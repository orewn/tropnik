package ru.tropa.app.ui

import org.json.JSONObject
import java.util.Collections

internal data class MapAsset(val path: String, val size: Int, val sha256: String)

/** One owner per Application: installed APK assets are immutable for its lifetime.
 * Cache only the completed registry, never a WebView, route, socket or callback.
 * Synchronized lazy initialization retries after a failed read or validation. */
internal class CustomMapAssetRegistry(private val readManifest: () -> String) {
    val entries: Map<String, MapAsset> by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        val manifest = JSONObject(readManifest())
        require(manifest.getInt("schemaVersion") == 1 && manifest.getString("runtime") == "tropnik-canvas" && manifest.getString("origin") == CUSTOM_MAP_ORIGIN)
        val allowed = mutableMapOf<String, MapAsset>()
        fun add(url: String, path: String, size: Int, sha: String) {
            require(CustomMapResourcePolicy.safePath(url) && CustomMapResourcePolicy.safePath("/$path") && size in 1..MAX_MAP_RESOURCE_BYTES && Regex("[a-f0-9]{64}").matches(sha))
            require(allowed.put(url, MapAsset(path, size, sha)) == null)
        }
        val files = manifest.getJSONArray("files")
        for (index in 0 until files.length()) {
            val file = files.getJSONObject(index);val path = file.getString("path")
            add("/custom-map/$path", "custom-map/$path", file.getInt("sizeBytes"), file.getString("sha256"))
        }
        val aliases = manifest.getJSONArray("resourceAliases")
        for (index in 0 until aliases.length()) {
            val alias = aliases.getJSONObject(index)
            add(alias.getString("url"), alias.getString("assetPath"), alias.getInt("sizeBytes"), alias.getString("sha256"))
        }
        allowed["/offline-map/manifest.json"] = requireNotNull(allowed["/custom-map/offline-manifest.json"])
        // The parser tree can be collected; only validated immutable records remain.
        Collections.unmodifiableMap(allowed)
    }
}
