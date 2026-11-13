package ru.tropa.app.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File

class BundledMapRuntimeTest {
    private val assets = File(requireNotNull(System.getProperty("tropnik.assets")))
    private fun bytes() = File(assets, BUNDLED_MAP_MANIFEST).readBytes()

    @Test fun realBundledRendererInventoryIsCompleteAndVerifiesWithoutTheRetiredStyle() {
        val runtime = parseBundledMapRuntime(bytes())
        assertFalse(File(assets, "maps/style.json").exists())
        assertTrue(runtime.assets.any { it.path.startsWith("maps/coverage/") })
        assertTrue(runtime.assets.any { it.path.startsWith("maps/russia-relief/") })
        assertTrue(runtime.assets.any { it.path == "maps/catalogue/trail-overlay.json" })
        assertTrue(runtime.assets.any { it.path.startsWith("maps/terrain-pilot/") })
        assertTrue(runtime.assets.any { it.path.startsWith("maps/pilot/localtiles/") })
        verifyBundledMapRuntime(runtime) { File(assets, it).inputStream() }
        assertEquals(BUNDLED_MAP_MANIFEST, runtime.descriptor().getString("path"))
    }

    @Test fun oneChangedOrMissingRuntimeFileInvalidatesTheBundle() {
        val runtime = parseBundledMapRuntime(bytes())
        val selected = runtime.assets.first { it.path.endsWith(".js") }
        for (truncate in listOf(false, true)) {
            assertThrows(IllegalArgumentException::class.java) {
                verifyBundledMapRuntime(runtime) { path ->
                    val original = File(assets, path).readBytes()
                    if (path != selected.path) ByteArrayInputStream(original)
                    else if (truncate) ByteArrayInputStream(original.copyOf(original.size - 1))
                    else { original[0] = (original[0].toInt() xor 1).toByte(); ByteArrayInputStream(original) }
                }
            }
        }
    }

    @Test fun manifestCannotIntroducePathsOutsideAssetsOrUnboundedRecords() {
        for (path in listOf("../escape", "/absolute", "maps//tile", "maps/./tile", "maps/../tile", "maps/tile?token=x")) {
            val changed = JSONObject(bytes().toString(Charsets.UTF_8))
            changed.getJSONArray("resourceAliases").getJSONObject(0).put("assetPath", path)
            assertThrows(IllegalArgumentException::class.java) { parseBundledMapRuntime(changed.toString().toByteArray()) }
        }
        val huge = JSONObject(bytes().toString(Charsets.UTF_8))
        huge.getJSONArray("resourceAliases").getJSONObject(0).put("sizeBytes", 9 * 1024 * 1024)
        assertThrows(IllegalArgumentException::class.java) { parseBundledMapRuntime(huge.toString().toByteArray()) }
    }

    @Test fun manifestReadIsBoundedBeforeJsonDecode() {
        assertThrows(IllegalArgumentException::class.java) { readBoundedBytes(ByteArrayInputStream(ByteArray(1025)), 1024) }
        assertArrayEquals(byteArrayOf(1, 2), readBoundedBytes(ByteArrayInputStream(byteArrayOf(1, 2)), 2))
    }
}
