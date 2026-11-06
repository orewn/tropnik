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

    suspend fun install(region: Region): InstalledPackEntity = mutex.withLock {
        withContext(Dispatchers.IO) {
            require(region.id.matches(Regex("[a-z0-9-]{1,64}")))
            val regionRoot = File(root, region.id).apply { mkdirs() }
            val directory = File(regionRoot, UUID.randomUUID().toString()).apply { mkdirs() }
            val publication = OfflinePackPublication(directory)
            try {
                val assets = mutableListOf("maps/world.geojson", "maps/style.json", "catalog.json", "SOURCES.txt")
                if (context.assets.list("maps")?.contains("regions.geojson") == true) assets += "maps/regions.geojson"
                assets += bundledFiles("maps/russia")
                if (region.id == "krasnodar") {
                    assets += bundledFiles("maps/pilot")
                    assets += bundledFiles("maps/terrain-pilot")
                    assets += bundledFiles("landscape")
                    assets += "licenses/Manrope-OFL.txt"
                    assets += "licenses/Manrope-Scene-OFL.txt"
                }
                val routeAssets = catalog.routes.filter { region.id in it.regionIds }.mapNotNull { it.geometryAsset }
                assets += routeAssets
                val files = JSONArray()
                assets.distinct().forEach { asset ->
                    currentCoroutineContext().ensureActive()
                    require(!asset.contains("..") && !asset.startsWith('/'))
                    val target = File(directory, asset)
                    target.parentFile?.mkdirs()
                    context.assets.open(asset).use { input -> target.outputStream().use(input::copyTo) }
                    files.put(JSONObject().put("path", asset).put("size", target.length())
                        .put("sha256", target.inputStream().use(::sha256)))
                }
                val manifest = JSONObject().put("schemaVersion", 1)
                    .put("regionId", region.id).put("version", catalog.version)
                    .put("kind", "bundled-preview-overview")
                    .put("navigationApproved", false).put("assets", files)
                if (region.id == "krasnodar") manifest.put("detailedCoverage", JSONObject()
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

    suspend fun verify(pack: InstalledPackEntity): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val directory = File(pack.directory)
            require(directory.canonicalPath.startsWith(root.canonicalPath + File.separator))
            validateFiles(directory, JSONObject(File(directory, "manifest.json").readText()))
            true
        }.getOrDefault(false)
    }

    private fun safeDelete(directory: File) {
        if (directory.canonicalPath.startsWith(root.canonicalPath + File.separator)) directory.deleteRecursively()
    }

    private fun bundledFiles(path: String): List<String> {
        val children = context.assets.list(path).orEmpty()
        return if (children.isEmpty()) listOf(path) else children.flatMap { bundledFiles("$path/$it") }
    }
}

internal fun validateFiles(directory: File, manifest: JSONObject) {
    require(manifest.getInt("schemaVersion") == 1)
    val assets = manifest.getJSONArray("assets")
    require(assets.length() in 1..512)
    val paths = mutableSetOf<String>()
    for (i in 0 until assets.length()) {
        val item = assets.getJSONObject(i)
        require(paths.add(item.getString("path"))) { "Duplicate asset path" }
        val target = File(directory, item.getString("path"))
        require(target.canonicalPath.startsWith(directory.canonicalPath + File.separator))
        require(target.isFile && target.length() == item.getLong("size"))
        require(target.inputStream().use(::sha256) == item.getString("sha256"))
    }
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
