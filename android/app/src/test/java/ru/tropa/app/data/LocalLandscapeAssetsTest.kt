package ru.tropa.app.data

import org.json.JSONObject
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class LocalLandscapeAssetsTest {
    private val assets = File(requireNotNull(System.getProperty("tropnik.assets")))
    private fun read(path: String) = File(assets, path).readBytes()

    @Test fun realBundledSceneLoadsWithItsExactTerrainPackage() {
        val document = loadLandscapeDocument(::read)
        assertTrue(document.startsWith("<!doctype html>"))
        assertTrue(document.contains("new TerrainRenderer("))
    }

    @Test fun alteredAndTruncatedDocumentsAreRejectedBeforeWebView() {
        val original = read("landscape/landscape.html")
        val altered = original.copyOf().apply { this[size / 2] = (this[size / 2].toInt() xor 1).toByte() }
        for (bytes in listOf(altered, original.copyOf(original.size - 1))) {
            assertThrows(IllegalArgumentException::class.java) {
                loadLandscapeDocument { path -> if (path == "landscape/landscape.html") bytes else read(path) }
            }
        }
    }

    @Test fun staleTerrainManifestDoesNotOpenAnotherLandscape() {
        assertThrows(IllegalArgumentException::class.java) {
            loadLandscapeDocument { path -> if (path == "maps/terrain-pilot/manifest.json") "{}".toByteArray() else read(path) }
        }
    }

    @Test fun externalEntrypointAndIncompleteBundleAreRejected() {
        for (mutation in listOf<(JSONObject) -> Unit>(
            { it.getJSONArray("files").getJSONObject(0).put("path", "../maps/style.json") },
            { it.put("complete", false) },
            { it.put("offline", false) },
            { it.getJSONArray("files").getJSONObject(0).put("sizeBytes", MAX_LANDSCAPE_BYTES + 1) },
            { it.getJSONObject("gridProvenance").getJSONObject("inputManifest").put("sha256", "0".repeat(64)) },
            { it.getJSONObject("gridProvenance").getJSONObject("output").put("sha256", "0".repeat(64)) },
            { it.put("gridDimensions", org.json.JSONArray(listOf(2048, 2048))) },
        )) {
            val manifest = JSONObject(read("landscape/manifest.json").toString(Charsets.UTF_8))
            mutation(manifest)
            assertThrows(IllegalArgumentException::class.java) {
                loadLandscapeDocument { path -> if (path == "landscape/manifest.json") manifest.toString().toByteArray() else read(path) }
            }
        }
    }
}
