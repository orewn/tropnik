package ru.tropa.app.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.maplibre.geojson.FeatureCollection
import org.maplibre.geojson.Point
import org.maplibre.geojson.Polygon
import java.io.File
import java.util.concurrent.CancellationException

class MapCoverageTest {
    private fun fixture(): MutableMap<String, ByteArray> {
        val json = JSONObject(javaClass.getResourceAsStream("/map-coverage-fixture.json")!!.bufferedReader().use { it.readText() })
        return json.keys().asSequence().associate { "maps/coverage/" + it to json.getString(it).toByteArray() }.toMutableMap()
    }
    private val west = MapCoverageBounds(171.0, 52.0, 175.0, 56.0)
    private val east = MapCoverageBounds.around(-175.0, listOf(-179.0 to 52.0, -171.0 to 56.0))

    @Test fun sharedLosslessDecoderResetsOncePerFileAndOnlyCanonicalizesEasternCells() {
        val files = fixture(); val reads = arrayListOf<String>()
        val coverage = MapCoverage.load(readAsset = { reads.add(it); files.getValue(it) })
        assertEquals(listOf("maps/coverage/manifest.json", "maps/coverage/base.coverage"), reads)
        val base = coverage.frame(4.0, west)
        val features = FeatureCollection.fromJson(base.json).features()!!
        assertEquals(8, features.size)
        assertTrue(base.geometry.contains(Point.fromLngLat(-175.0, 55.0)))
        assertTrue(base.geometry.contains(Point.fromLngLat(175.0, 55.0)))
        assertFalse(base.geometry.contains(Point.fromLngLat(165.0, 55.0)))
        assertEquals(2, reads.size)
        assertSame(base, coverage.frame(0.0, east))
    }

    @Test fun selectedViewportReplacesEveryRoleTogetherWithoutReadingOtherCells() {
        val files = fixture(); val reads = arrayListOf<String>()
        val coverage = MapCoverage.load(readAsset = { reads.add(it); files.getValue(it) })
        val frame = coverage.frame(12.25, east)
        assertEquals(setOf("east"), frame.detailedCells)
        assertEquals(listOf("maps/coverage/manifest.json", "maps/coverage/base.coverage", "maps/coverage/cells/eastsource.coverage"), reads)
        val features = FeatureCollection.fromJson(frame.json).features()!!
        assertEquals(8, features.size)
        for (cell in listOf("west", "east")) {
            val selected = features.filter { it.getStringProperty("cell") == cell }
            assertEquals(setOf("area", "mask", "territory", "territory-boundary"), selected.map { it.getStringProperty("role") }.toSet())
            assertTrue(selected.all { it.getStringProperty("fixtureLevel") == if (cell == "east") "source" else "overview" })
        }
        assertSame(frame, coverage.frame(17.0, east))
        assertEquals(3, reads.size)
    }

    @Test fun zoomThresholdsAndAViewportCrossingTheDatelineUseTheIntendedCells() {
        val files = fixture(); val coverage = MapCoverage.load(readAsset = files::getValue)
        for ((zoom, level) in listOf(0.0 to "overview", 4.0 to "overview", 4.01 to "regional", 8.0 to "regional",
            8.01 to "local", 12.0 to "local", 12.01 to "source", 18.0 to "source")) assertEquals(level, coverage.level(zoom))
        val crossing = MapCoverageBounds.around(180.0, listOf(179.0 to 55.0, -179.0 to 56.0))
        assertEquals(setOf("east", "west"), coverage.selected(14.0, crossing).map { it.id }.toSet())
        assertEquals(listOf("east"), coverage.selected(14.0, east).map { it.id })
        assertTrue(coverage.selected(14.0, MapCoverageBounds(20.0, 50.0, 30.0, 60.0)).isEmpty())
    }

    @Test fun canceledOrCorruptDetailCannotReplaceThePreviousCompleteFrameAndCacheIsBounded() {
        val files = fixture(); val reads = arrayListOf<String>()
        val coverage = MapCoverage.load(readAsset = { reads.add(it); files.getValue(it) }, cacheBudget = 1)
        val initial = coverage.frame(4.0, west)
        assertThrows(CancellationException::class.java) { coverage.frame(14.0, west) { throw CancellationException() } }
        assertSame(initial, coverage.frame(4.0, west))
        val path = "maps/coverage/cells/westsource.coverage"; val original = files.getValue(path)
        files[path] = original + byteArrayOf(32)
        assertThrows(IllegalArgumentException::class.java) { coverage.frame(14.0, west) }
        assertSame(initial, coverage.frame(4.0, west))
        files[path] = original
        coverage.frame(14.0, west); coverage.frame(14.0, east); coverage.frame(14.0, west)
        assertEquals(3, reads.count { it == path }) // Bad bytes, first read, evicted/reloaded.
    }

    @Test fun nativeDecodeSharesPointsAcrossRolesAndOmitsUnusedTerritories() {
        val files = fixture()
        val coverage = MapCoverage.load(readAsset = files::getValue, includeTerritory = false)
        val decoded = decodeCoverage(files.getValue("maps/coverage/base.coverage"), coverage.version, null, "overview",
            coverage.cells.associate { it.id to it.bounds }, includeTerritory = false)
        assertEquals(6, decoded.features.size)
        assertEquals(setOf("area", "mask", "territory-boundary"), decoded.features.map { it.getStringProperty("role") }.toSet())
        val west = decoded.features.filter { it.getStringProperty("cell") == "west" }
        val area = (west.single { it.getStringProperty("role") == "area" }.geometry() as Polygon).coordinates().first()
        val mask = (west.single { it.getStringProperty("role") == "mask" }.geometry() as Polygon).coordinates().first()
        assertSame(area.first(), area.last())
        assertSame(area.first(), mask.first())
        assertTrue("Decoded object storage must not be charged as encoded file bytes",
            decoded.estimatedBytes > files.getValue("maps/coverage/base.coverage").size)
        val frame = coverage.frame(14.0, east)
        assertTrue(frame.geometry.contains(Point.fromLngLat(-175.0, 55.0)))
        assertTrue(frame.geometry.contains(Point.fromLngLat(175.0, 55.0)))
        assertFalse(FeatureCollection.fromJson(frame.json).features()!!.any { it.getStringProperty("role") == "territory" })
    }

    @Test fun decodedCacheRejectsAnOversizedCellAndCanceledDecodeCannotPopulateIt() {
        val files = fixture(); val reads = arrayListOf<String>()
        val path = "maps/coverage/cells/westsource.coverage"
        // The encoded asset fits exactly, but its retained objects do not.
        val coverage = MapCoverage.load(readAsset = { reads.add(it); files.getValue(it) },
            cacheBudget = files.getValue(path).size, includeTerritory = false)
        val initial = coverage.frame(4.0, west)
        var checkpoints = 0
        assertThrows(CancellationException::class.java) {
            coverage.frame(14.0, west) { if (++checkpoints == 10) throw CancellationException() }
        }
        assertSame(initial, coverage.frame(4.0, west))
        assertEquals(0L, coverage.cachedDecodedBytes)
        coverage.frame(14.0, west)
        assertEquals(0L, coverage.cachedDecodedBytes)
        coverage.frame(14.0, east); coverage.frame(14.0, west)
        assertEquals(3, reads.count { it == path }) // Canceled, then two uncached uses.
        assertEquals(0L, coverage.cachedDecodedBytes)
    }

    @Test fun aSharedDatelineIndexKeepsBothCanonicalSigns() {
        val files = fixture(); val coverage = MapCoverage.load(readAsset = files::getValue)
        val document = JSONObject(files.getValue("maps/coverage/base.coverage").toString(Charsets.UTF_8))
        val features = document.getJSONArray("features")
        for (i in 0 until features.length()) {
            val feature = features.getJSONObject(i)
            if (feature.getJSONObject("properties").getString("cell") != "east") continue
            // Reuse the west cell's +180 indices on the eastern side.
            val ring = feature.getJSONObject("geometry").getJSONArray("coordinates").getJSONArray(0)
            ring.put(0, 1); ring.put(3, 2); ring.put(4, 1)
        }
        val decoded = decodeCoverage(document.toString().toByteArray(), coverage.version, null, "overview",
            coverage.cells.associate { it.id to it.bounds })
        fun area(cell: String) = (decoded.features.single {
            it.getStringProperty("cell") == cell && it.getStringProperty("role") == "area"
        }.geometry() as Polygon).coordinates().first()
        assertEquals(180.0, area("west")[1].longitude(), 0.0)
        assertEquals(-180.0, area("east")[0].longitude(), 0.0)
    }

    @Test fun actualBundledOverviewAndSourceCellsCoverPinnedRegressionVerticesOffline() {
        val assets = File(requireNotNull(System.getProperty("tropnik.assets")))
        val coverage = MapCoverage.load(readAsset = { File(assets, it).readBytes() }, includeTerritory = false)
        val manifest = JSONObject(File(assets, "maps/coverage/manifest.json").readText())
        val probes = manifest.getJSONObject("regressionSourceVertices")
        for (name in probes.keys()) {
            val point = probes.getJSONArray(name); val x = point.getDouble(0); val y = point.getDouble(1)
            val frame = coverage.frame(14.0, MapCoverageBounds(x - .02, y - .02, x + .02, y + .02))
            assertTrue(name, frame.geometry.contains(Point.fromLngLat(x, y)))
            assertTrue(name, frame.detailedCells.isNotEmpty())
            assertTrue("Decoded detail cache exceeded its heap budget", coverage.cachedDecodedBytes <= 12 * 1024 * 1024)
        }
    }
}
