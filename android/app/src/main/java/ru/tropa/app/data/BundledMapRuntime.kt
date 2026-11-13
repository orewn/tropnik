package ru.tropa.app.data

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.security.MessageDigest

internal const val BUNDLED_MAP_MANIFEST = "custom-map/manifest.json"
internal const val MAX_BUNDLED_MANIFEST_BYTES = 2 * 1024 * 1024
internal const val MAX_PACK_FILE_BYTES = 16 * 1024 * 1024
internal const val MAX_PACK_BYTES = 64L * 1024 * 1024

internal data class BundledMapAsset(val path: String, val sizeBytes: Long, val sha256: String)
internal data class BundledMapRuntime(val manifestSha256: String, val manifestSizeBytes: Long, val assets: List<BundledMapAsset>) {
    fun descriptor(): JSONObject = JSONObject().put("path", BUNDLED_MAP_MANIFEST)
        .put("size", manifestSizeBytes).put("sha256", manifestSha256)
}

internal fun safePackRelativePath(value: String): Boolean = value.length in 1..512 &&
    value.matches(Regex("[A-Za-z0-9_./-]+")) && value.split('/').all { it.isNotEmpty() && it != "." && it != ".." }

internal fun readBoundedBytes(input: InputStream, maximum: Int): ByteArray {
    val result = ByteArrayOutputStream()
    val buffer = ByteArray(64 * 1024)
    while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        require(result.size().toLong() + count <= maximum) { "Offline asset exceeds its size limit" }
        result.write(buffer, 0, count)
    }
    return result.toByteArray()
}

internal fun parseBundledMapRuntime(bytes: ByteArray): BundledMapRuntime {
    require(bytes.isNotEmpty() && bytes.size <= MAX_BUNDLED_MANIFEST_BYTES)
    val manifest = JSONObject(bytes.toString(Charsets.UTF_8))
    require(manifest.getInt("schemaVersion") == 1 && manifest.getString("runtime") == "tropnik-canvas" &&
        manifest.getString("origin") == "https://map.tropnik.invalid")
    val records = linkedMapOf<String, BundledMapAsset>()
    fun add(path: String, size: Long, digest: String) {
        require(safePackRelativePath(path) && size in 1..(8L * 1024 * 1024) && digest.matches(Regex("[a-f0-9]{64}")))
        val record = BundledMapAsset(path, size, digest)
        val previous = records.put(path, record)
        require(previous == null || previous == record) { "Conflicting bundled map asset" }
    }
    val files = manifest.getJSONArray("files")
    val aliases = manifest.getJSONArray("resourceAliases")
    require(files.length() in 5..64 && aliases.length() in 1..4096)
    for (index in 0 until files.length()) {
        val file = files.getJSONObject(index)
        add("custom-map/" + file.getString("path"), file.getLong("sizeBytes"), file.getString("sha256"))
    }
    for (index in 0 until aliases.length()) {
        val file = aliases.getJSONObject(index)
        add(file.getString("assetPath"), file.getLong("sizeBytes"), file.getString("sha256"))
    }
    require(listOf("custom-map/index.html", "custom-map/android-bootstrap.js", "custom-map/map-runtime.js",
        "custom-map/map.css", "custom-map/catalogue.json").all(records::containsKey)) { "Incomplete bundled renderer" }
    require(records.keys.any { it.startsWith("maps/coverage/") } &&
        records.keys.any { it.startsWith("maps/russia-relief/") } &&
        records.keys.any { it.startsWith("maps/catalogue/") }) { "Incomplete bundled map data" }
    require(records.values.sumOf { it.sizeBytes } <= 256L * 1024 * 1024) { "Bundled map exceeds its total budget" }
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    return BundledMapRuntime(digest, bytes.size.toLong(), records.values.toList())
}

/** APK resources are immutable during an installed app's lifetime. The caller
 * may cache this success by manifest SHA; no per-region copy is required. */
internal fun verifyBundledMapRuntime(runtime: BundledMapRuntime, open: (String) -> InputStream) {
    val buffer = ByteArray(64 * 1024)
    for (asset in runtime.assets) {
        val digest = MessageDigest.getInstance("SHA-256")
        var length = 0L
        open(asset.path).use { input ->
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                length += count
                require(length <= asset.sizeBytes) { "Bundled map asset exceeds its recorded size" }
                digest.update(buffer, 0, count)
            }
        }
        require(length == asset.sizeBytes && digest.digest().joinToString("") { "%02x".format(it) } == asset.sha256) {
            "Bundled map asset does not match the renderer manifest: " + asset.path
        }
    }
}
