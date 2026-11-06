package ru.tropa.app.data

import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** A packaged document only. No URLs, account state or JavaScript bridge inputs. */
internal const val MAX_LANDSCAPE_BYTES = 2 * 1024 * 1024

internal fun loadLandscapeDocument(readAsset: (String) -> ByteArray): String {
    val manifest = JSONObject(readAsset("landscape/manifest.json").toString(Charsets.UTF_8))
    require(manifest.getInt("schemaVersion") == 1 && manifest.getBoolean("complete") && manifest.getBoolean("offline"))
    val entries = manifest.getJSONArray("files")
    require(entries.length() == 1) { "Unexpected landscape bundle" }
    val document = entries.getJSONObject(0)
    require(document.getString("path") == "landscape.html") { "Invalid landscape entrypoint" }
    val expectedSize = document.getLong("sizeBytes")
    require(expectedSize in 1..MAX_LANDSCAPE_BYTES.toLong()) { "Landscape exceeds its byte budget" }
    val terrainManifest = readAsset("maps/terrain-pilot/manifest.json")
    val terrainSha = terrainManifest.inputStream().use(::sha256)
    require(terrainSha == manifest.getString("terrainManifestSha256")) {
        "Landscape and native relief refer to different packages"
    }
    val provenance = manifest.getJSONObject("gridProvenance")
    require(provenance.getJSONObject("inputManifest").getString("sha256") == terrainSha &&
        provenance.getJSONObject("output").getString("sha256") == manifest.getString("gridSha256")) {
        "Landscape derivative and native relief have different provenance"
    }
    val dimensions = manifest.getJSONArray("gridDimensions")
    require(dimensions.length() == 2 && dimensions.getInt(0) in 2..1025 && dimensions.getInt(1) in 2..1025) {
        "Invalid landscape grid dimensions"
    }
    val bytes = readAsset("landscape/landscape.html")
    require(bytes.size.toLong() == expectedSize && bytes.inputStream().use(::sha256) == document.getString("sha256")) {
        "Landscape is incomplete or damaged"
    }
    return Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
}
