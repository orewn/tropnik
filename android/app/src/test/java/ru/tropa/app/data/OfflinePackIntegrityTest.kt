package ru.tropa.app.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertThrows
import org.junit.Assert.assertArrayEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files

class OfflinePackIntegrityTest {
    @get:Rule val temporary = TemporaryFolder()

    private fun entry(file: File, path: String) = JSONObject().put("path", path).put("size", file.length())
        .put("sha256", file.inputStream().use(::sha256))
    private fun manifest(vararg entries: JSONObject) = JSONObject().put("schemaVersion", 1).put("assets", JSONArray(entries.toList()))

    @Test fun acceptsCompletePackThenRejectsCorruptionAndTruncation() {
        val directory = temporary.newFolder("pack")
        val tile = File(directory, "tile.pbf").apply { writeBytes(byteArrayOf(1, 2, 3, 4)) }
        val index = manifest(entry(tile, "tile.pbf"))
        validateFiles(directory, index)
        tile.writeBytes(byteArrayOf(1, 2, 3, 5))
        assertThrows(IllegalArgumentException::class.java) { validateFiles(directory, index) }
        tile.writeBytes(byteArrayOf(1, 2))
        assertThrows(IllegalArgumentException::class.java) { validateFiles(directory, index) }
    }

    @Test fun rejectsOutsideFilesEvenWithCorrectDigest() {
        val directory = temporary.newFolder("pack")
        val outside = File(directory.parentFile, "outside.pbf").apply { writeText("outside") }
        assertThrows(IllegalArgumentException::class.java) { validateFiles(directory, manifest(entry(outside, "../outside.pbf"))) }
    }

    @Test fun rejectsDuplicatePathsAndMissingFiles() {
        val directory = temporary.newFolder("pack")
        val tile = File(directory, "tile.pbf").apply { writeText("tile") }
        val asset = entry(tile, "tile.pbf")
        assertThrows(IllegalArgumentException::class.java) { validateFiles(directory, manifest(asset, asset)) }
        tile.delete()
        assertThrows(IllegalArgumentException::class.java) { validateFiles(directory, manifest(asset)) }
    }

    @Test fun currentPackPinsTheSharedRuntimeButDoesNotRequireACopiedVendorStyle() {
        val directory = temporary.newFolder("pack-current")
        val card = File(directory, "catalog.json").apply { writeText("current saved catalogue") }
        val sources = File(directory, "SOURCES.txt").apply { writeText("Source attribution") }
        val index = manifest(entry(card, "catalog.json"), entry(sources, "SOURCES.txt")).put("schemaVersion", 2)
            .put("kind", "bundled-custom-map-region").put("navigationApproved", false)
            .put("bundledRuntime", JSONObject().put("path", BUNDLED_MAP_MANIFEST).put("size", 1200).put("sha256", "ab".repeat(32)))
        validateFiles(directory, index)
        val onlyAttribution = JSONObject(index.toString()).put("assets", JSONArray().put(entry(sources, "SOURCES.txt")))
        assertThrows(IllegalArgumentException::class.java) { validateFiles(directory, onlyAttribution) }
        index.getJSONObject("bundledRuntime").put("path", "maps/style.json")
        assertThrows(IllegalArgumentException::class.java) { validateFiles(directory, index) }
    }

    @Test fun rejectsLinkedAssetsAndOversizedDeclarationsBeforeReadingThem() {
        val directory = temporary.newFolder("pack-bounded")
        val tile = File(directory, "tile.pbf").apply { writeText("tile") }
        val alias = File(directory, "alias.pbf")
        Files.createSymbolicLink(alias.toPath(), tile.toPath())
        assertThrows(IllegalArgumentException::class.java) { validateFiles(directory, manifest(entry(alias, "alias.pbf"))) }
        assertThrows(IllegalArgumentException::class.java) {
            validateFiles(directory, manifest(entry(tile, "tile.pbf").put("size", MAX_PACK_FILE_BYTES.toLong() + 1)))
        }
    }

    @Test fun snapshotReadRetainsExactUtf8BytesAndRejectsLaterChangesOrMissingEntries() {
        val directory = temporary.newFolder("snapshot")
        val original = "{\n  \"name\": \"Тропа · берег\", \"coordinates\": [1.000, 2.000]\n}\n".toByteArray(Charsets.UTF_8)
        val geometry = File(directory, "geometry.geojson").apply { writeBytes(original) }
        val index = manifest(entry(geometry, "geometry.geojson"))
        val snapshot = readPackAsset(directory, index, "geometry.geojson")
        assertArrayEquals(original, snapshot)
        geometry.writeText("changed")
        assertArrayEquals(original, snapshot)
        assertThrows(IllegalArgumentException::class.java) { readPackAsset(directory, index, "geometry.geojson") }
        assertThrows(IllegalArgumentException::class.java) { readPackAsset(directory, index, "missing.geojson") }
    }
}
