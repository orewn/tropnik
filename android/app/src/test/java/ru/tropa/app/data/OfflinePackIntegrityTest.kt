package ru.tropa.app.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

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
}
