package ru.tropa.app.data

import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID

/** Every asset in this preview is bundled. No public OSM tile server is scraped. */
class OfflinePacks(
    private val context: Context,
    private val dao: LocalDao,
    private val catalog: Catalog,
) {
    private val mutex = Mutex()
    private val root = File(context.filesDir, "offline").apply { mkdirs() }
    private var verifiedRuntimeSha256: String? = null

    private fun bundledRuntime(): BundledMapRuntime = try {
        val runtime = parseBundledMapRuntime(context.assets.open(BUNDLED_MAP_MANIFEST).use {
            readBoundedBytes(it, MAX_BUNDLED_MANIFEST_BYTES)
        })
        if (verifiedRuntimeSha256 != runtime.manifestSha256) {
            verifyBundledMapRuntime(runtime, context.assets::open)
            verifiedRuntimeSha256 = runtime.manifestSha256
        }
        runtime
    } catch (error: Exception) {
        throw OfflinePackAssetsUnavailable(error)
    }

    suspend fun install(region: Region): InstalledPackEntity = mutex.withLock {
        withContext(Dispatchers.IO) {
            require(region.id.matches(Regex("(?:[a-z0-9-]{1,64}|territory-[A-Za-z0-9]{1,54})"))
                && catalog.region(region.id) != null)
            val regionRoot = File(root, region.id).apply { mkdirs() }
            val directory = File(regionRoot, UUID.randomUUID().toString()).apply { mkdirs() }
            val publication = OfflinePackPublication(directory)
            try {
                // Bind to the same manifest used by CustomMapResources. Shared
                // coverage, renderer and overview stay in the immutable APK;
                // copying them into every region would waste over 100 MB each.
                val runtime = bundledRuntime()
                val includePilot = catalog.hasDetailedOfflineMap(region.id)
                val assets = mutableListOf("catalog.json", "SOURCES.txt")
                val routeAssets = catalog.referenceRoutes(regionId = region.id).mapNotNull { it.geometryAsset }
                assets += routeAssets
                val files = JSONArray()
                var copiedBytes = 0L
                assets.distinct().forEach { asset ->
                    currentCoroutineContext().ensureActive()
                    require(safePackRelativePath(asset))
                    val target = File(directory, asset)
                    target.parentFile?.mkdirs()
                    val input = try { context.assets.open(asset) } catch (error: Exception) { throw OfflinePackAssetsUnavailable(error) }
                    input.use { source ->
                        target.outputStream().use { output ->
                            val buffer = ByteArray(64 * 1024)
                            var assetBytes = 0L
                            while (true) {
                                currentCoroutineContext().ensureActive()
                                val count = source.read(buffer)
                                if (count < 0) break
                                assetBytes += count; copiedBytes += count
                                require(assetBytes <= MAX_PACK_FILE_BYTES && copiedBytes <= MAX_PACK_BYTES) { "Offline pack exceeds its byte budget" }
                                output.write(buffer, 0, count)
                            }
                        }
                    }
                    files.put(JSONObject().put("path", asset).put("size", target.length())
                        .put("sha256", target.inputStream().use(::sha256)))
                }
                val manifest = JSONObject().put("schemaVersion", 2)
                    .put("regionId", region.id).put("version", catalog.version)
                    .put("kind", "bundled-custom-map-region")
                    .put("navigationApproved", false).put("assets", files).put("bundledRuntime", runtime.descriptor())
                if (includePilot) manifest.put("detailedCoverage", JSONObject()
                    .put("title", "Район Бзерпинского карниза")
                    .put("bbox", JSONArray(listOf(40.29, 43.64, 40.49, 43.82)))
                    .put("routeIds", JSONArray(listOf("kavkaz-8a"))))
                File(directory, "manifest.json").writeText(manifest.toString(2))
                // Verify actual bytes before the database points to the new installation.
                validateFiles(directory, manifest)
                val size = directory.walkTopDown().filter { it.isFile }.sumOf { it.length() }
                val next = InstalledPackEntity(region.id, region.name, catalog.version, directory.absolutePath,
                    size, System.currentTimeMillis(), routeAssets.isNotEmpty())
                val previous = dao.pack(region.id)
                currentCoroutineContext().ensureActive()
                publication.publish { dao.putPack(next) }
                // Failure to remove an old copy cannot roll back the published
                // directory. It can be cleaned up on a later maintenance pass.
                previous?.let { old -> runCatching { safeDelete(File(old.directory)) } }
                next
            } catch (cancelled: CancellationException) {
                publication.discardUnpublished()
                throw cancelled
            } catch (error: Exception) {
                publication.discardUnpublished()
                throw error
            }
        }
    }

    suspend fun remove(regionId: String) = mutex.withLock {
        withContext(Dispatchers.IO) {
            val previous = dao.pack(regionId) ?: return@withContext
            // Stop offering the pack before deleting its files; bookmarks are independent.
            dao.removePack(regionId)
            safeDelete(File(previous.directory))
        }
    }

    private fun inspectPack(pack: InstalledPackEntity): OfflinePackAvailability = try {
            val directory = File(pack.directory)
            require(directory.canonicalPath.startsWith(root.canonicalPath + File.separator))
            val file = File(directory, "manifest.json")
            require(file.isFile && !Files.isSymbolicLink(file.toPath()) && file.length() in 1..MAX_BUNDLED_MANIFEST_BYTES.toLong())
            val manifest = JSONObject(file.inputStream().use { readBoundedBytes(it, MAX_BUNDLED_MANIFEST_BYTES) }.toString(Charsets.UTF_8))
            validateFiles(directory, manifest)
            require(manifest.getString("regionId") == pack.regionId && manifest.getString("version") == pack.version)
            if (manifest.getInt("schemaVersion") == 1 || pack.version != catalog.version) OfflinePackAvailability.UPDATE_REQUIRED
            else {
                // A syntactically valid manifest is not enough: every regional
                // card with a source line must have its exact saved geometry.
                val savedCatalog = packCatalog(directory, manifest, pack)
                val expectedPaths = setOf("catalog.json", "SOURCES.txt") + savedCatalog.referenceRoutes(regionId = pack.regionId).mapNotNull { it.geometryAsset }
                val actualPaths = manifest.getJSONArray("assets").let { entries ->
                    (0 until entries.length()).map { entries.getJSONObject(it).getString("path") }.toSet()
                }
                require(actualPaths == expectedPaths) { "Saved region asset set does not match its catalogue" }
                val runtime = bundledRuntime()
                val expected = manifest.getJSONObject("bundledRuntime")
                if (expected.getString("sha256") != runtime.manifestSha256 || expected.getLong("size") != runtime.manifestSizeBytes)
                    OfflinePackAvailability.UPDATE_REQUIRED
                else OfflinePackAvailability.READY
            }
        } catch (cancelled: CancellationException) { throw cancelled
        } catch (_: OfflinePackAssetsUnavailable) { OfflinePackAvailability.APP_DATA_UNAVAILABLE
        } catch (_: Exception) { OfflinePackAvailability.DAMAGED }

    suspend fun verify(pack: InstalledPackEntity): OfflinePackAvailability = mutex.withLock {
        withContext(Dispatchers.IO) {
            dao.pack(pack.regionId)?.let(::inspectPack) ?: OfflinePackAvailability.DAMAGED
        }
    }

    suspend fun open(pack: InstalledPackEntity): OfflinePackOpenResult = mutex.withLock {
        withContext(Dispatchers.IO) {
            // The Saved screen may still hold a row that was replaced or
            // removed. Only the currently published database entry can open.
            val current = dao.pack(pack.regionId) ?: return@withContext OfflinePackOpenResult(OfflinePackAvailability.DAMAGED)
            val availability = inspectPack(current)
            if (availability != OfflinePackAvailability.READY) return@withContext OfflinePackOpenResult(availability)
            try {
                val directory = File(current.directory)
                val manifest = JSONObject(File(directory, "manifest.json").inputStream().use {
                    readBoundedBytes(it, MAX_BUNDLED_MANIFEST_BYTES)
                }.toString(Charsets.UTF_8))
                val savedCatalog = packCatalog(directory, manifest, current)
                val routes = savedCatalog.referenceRoutes(regionId = current.regionId).map { route ->
                    currentCoroutineContext().ensureActive()
                    route.geometryAsset?.let { path ->
                        val bytes = readPackAsset(directory, manifest, path)
                        // Retain verified bytes in memory. No unverified file
                        // path escapes the lock into the asynchronous WebView.
                        route.copy(inlineGeometry = bytes.toString(Charsets.UTF_8))
                    } ?: route
                }
                OfflinePackOpenResult(OfflinePackAvailability.READY,
                    OfflineRegionSnapshot(current, savedCatalog.copy(routes = routes)))
            } catch (cancelled: CancellationException) { throw cancelled
            } catch (_: Exception) { OfflinePackOpenResult(OfflinePackAvailability.DAMAGED) }
        }
    }

    private fun packCatalog(directory: File, manifest: JSONObject, pack: InstalledPackEntity): Catalog {
        val result = Catalog.parse(JSONObject(readPackAsset(directory, manifest, "catalog.json").toString(Charsets.UTF_8)))
        require(result.version == pack.version && result.region(pack.regionId) != null)
        return result
    }

    private fun safeDelete(directory: File) {
        if (directory.canonicalPath.startsWith(root.canonicalPath + File.separator)) directory.deleteRecursively()
    }

}

enum class OfflinePackAvailability { READY, UPDATE_REQUIRED, DAMAGED, APP_DATA_UNAVAILABLE }
class OfflinePackAssetsUnavailable(cause: Throwable) : IllegalStateException("Bundled offline assets are unavailable", cause)
data class OfflineRegionSnapshot(val pack: InstalledPackEntity, val catalog: Catalog)
data class OfflinePackOpenResult(val availability: OfflinePackAvailability, val snapshot: OfflineRegionSnapshot? = null)

internal fun readPackAsset(directory: File, manifest: JSONObject, path: String): ByteArray {
    require(safePackRelativePath(path))
    val entries = manifest.getJSONArray("assets")
    val matching = (0 until entries.length()).map { entries.getJSONObject(it) }.filter { it.getString("path") == path }
    require(matching.size == 1) { "Required saved region asset is missing or ambiguous" }
    val expected = matching.single()
    require(expected.getLong("size") in 1..MAX_PACK_FILE_BYTES.toLong())
    val target = File(directory, path)
    require(target.canonicalPath.startsWith(directory.canonicalPath + File.separator) && !Files.isSymbolicLink(target.toPath()))
    var component = directory
    for (name in path.split('/')) { component = File(component, name); require(!Files.isSymbolicLink(component.toPath())) }
    val bytes = target.inputStream().use { readBoundedBytes(it, MAX_PACK_FILE_BYTES) }
    require(bytes.size.toLong() == expected.getLong("size") && bytes.inputStream().use(::sha256) == expected.getString("sha256"))
    return bytes
}

internal fun validateFiles(directory: File, manifest: JSONObject) {
    val version = manifest.getInt("schemaVersion")
    require(version in 1..2)
    if (version == 2) {
        require(manifest.getString("kind") == "bundled-custom-map-region" && !manifest.getBoolean("navigationApproved"))
        val runtime = manifest.getJSONObject("bundledRuntime")
        require(runtime.getString("path") == BUNDLED_MAP_MANIFEST &&
            runtime.getLong("size") in 1..MAX_BUNDLED_MANIFEST_BYTES.toLong() &&
            runtime.getString("sha256").matches(Regex("[a-f0-9]{64}")))
    }
    val assets = manifest.getJSONArray("assets")
    require(assets.length() in 1..2048)
    val paths = mutableSetOf<String>()
    var bytes = 0L
    for (i in 0 until assets.length()) {
        val item = assets.getJSONObject(i)
        val path = item.getString("path")
        require(safePackRelativePath(path) && paths.add(path)) { "Invalid or duplicate asset path" }
        val size = item.getLong("size")
        require(size in 1..MAX_PACK_FILE_BYTES.toLong() && item.getString("sha256").matches(Regex("[a-f0-9]{64}")))
        bytes += size
        require(bytes <= MAX_PACK_BYTES) { "Offline pack exceeds its total size limit" }
        val target = File(directory, path)
        require(target.canonicalPath.startsWith(directory.canonicalPath + File.separator))
        var component = directory
        for (name in path.split('/')) { component = File(component, name); require(!Files.isSymbolicLink(component.toPath())) }
        require(target.isFile && target.length() == size)
        require(target.inputStream().use(::sha256) == item.getString("sha256"))
    }
    if (version == 2) require(paths.containsAll(listOf("catalog.json", "SOURCES.txt"))) { "Saved catalogue or attribution is missing" }
}

internal fun sha256(input: InputStream): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val bytes = ByteArray(64 * 1024)
    while (true) {
        val count = input.read(bytes)
        if (count < 0) break
        digest.update(bytes, 0, count)
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}
