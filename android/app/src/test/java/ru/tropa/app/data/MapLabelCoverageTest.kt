package ru.tropa.app.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.maplibre.geojson.Feature
import org.maplibre.geojson.FeatureCollection
import org.maplibre.geojson.LineString
import org.maplibre.geojson.MultiLineString
import org.maplibre.geojson.MultiPoint
import org.maplibre.geojson.Point
import org.maplibre.geojson.Polygon
import java.io.File

class MapLabelCoverageTest {
    private fun p(x: Double, y: Double) = Point.fromLngLat(x, y)
    private fun ring(w: Double, s: Double, e: Double, n: Double) = listOf(p(w, s), p(e, s), p(e, n), p(w, n), p(w, s))
    private fun area(vararg rings: List<Point>) = Polygon.fromLngLats(rings.toList())
    private val rectangle = ring(10.0, 50.0, 20.0, 60.0)
    private val hole = ring(14.0, 54.0, 16.0, 56.0)
    private fun line(vararg points: Point) = LineString.fromLngLats(points.toList())
    private fun coverage(vararg polygons: Polygon) = MapLabelGeometry.fromPolygons(polygons.toList())

    @Test fun sourcedCountryCasesAndRepeatedWorldsUseTheSameEligibility() {
        val assets = File(requireNotNull(System.getProperty("tropnik.assets")))
        val sourced = RussiaDisplayArea.load { File(assets, it).readText() }.labelCoverage
        val cases = JSONObject(javaClass.getResourceAsStream("/russia-display-cases.json")!!.bufferedReader().use { it.readText() }).getJSONArray("pointCases")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index); val point = case.getJSONArray("inputLngLat")
            for (world in -2..2) assertEquals("${case.getString("name")}, world $world", case.getBoolean("expectedInside"),
                sourced.contains(p(point.getDouble(0) + 360 * world, point.getDouble(1))))
        }
    }

    @Test fun fullLinesAndMultipointsCannotCrossHolesOrDiscardAnOutsidePart() {
        val coverage = coverage(area(rectangle, hole))
        assertTrue(coverage.contains(p(10.0, 55.0)))
        assertFalse(coverage.contains(p(14.0, 55.0)))
        assertTrue(coverage.contains(line(p(10.0, 51.0), p(10.0, 59.0))))
        assertFalse(coverage.contains(line(p(11.0, 55.0), p(19.0, 55.0))))
        assertTrue(coverage.contains(line(p(11.0, 55.0), p(11.0, 57.0), p(19.0, 57.0), p(19.0, 55.0))))
        assertTrue(coverage.contains(MultiPoint.fromLngLats(listOf(p(11.0, 55.0), p(19.0, 55.0)))))
        assertFalse(coverage.contains(MultiPoint.fromLngLats(listOf(p(11.0, 55.0), p(15.0, 55.0)))))
        assertFalse(coverage.contains(MultiLineString.fromLngLats(listOf(listOf(p(11.0, 51.0), p(19.0, 51.0)), listOf(p(11.0, 55.0), p(19.0, 55.0))))))
    }

    @Test fun aLongSegmentCannotSkipAnOffCentreNarrowHoleOrConcaveBay() {
        val bay = listOf(p(10.0, 50.0), p(20.0, 50.0), p(20.0, 60.0), p(11.6, 60.0), p(11.6, 54.0), p(11.5, 54.0), p(11.5, 60.0), p(10.0, 60.0), p(10.0, 50.0))
        for (scope in listOf(coverage(area(rectangle, ring(11.5, 54.0, 11.500001, 56.0))), coverage(area(bay)))) {
            assertTrue(scope.contains(p(15.0, 55.0)))
            assertFalse(scope.contains(line(p(11.0, 55.0), p(19.0, 55.0))))
            assertFalse(scope.contains(line(p(19.0, 55.0), p(11.0, 55.0))))
        }
    }

    @Test fun renderedMercatorSegmentsAndSlopedEdgesDoNotUseALatitudeMidpoint() {
        val middle = 61.56829417944769
        val scope = coverage(area(ring(10.0, 40.0, 50.0, 80.0), ring(29.9, middle - .1, 30.1, middle + .1)))
        assertTrue(scope.contains(p(30.0, 60.0)))
        assertFalse(scope.contains(line(p(20.0, 50.0), p(40.0, 70.0))))
        val sloped = coverage(area(listOf(p(20.0, 50.0), p(40.0, 70.0), p(40.0, 80.0), p(20.0, 80.0), p(20.0, 50.0))))
        assertFalse(sloped.contains(p(30.0, 60.8)))
        assertTrue(sloped.contains(p(30.0, 62.0)))
    }

    @Test fun adjacentCellsFormAUnionWhileGapsAndDatelineHolesStayExcluded() {
        assertTrue(coverage(area(rectangle), area(ring(20.0, 50.0, 25.0, 60.0))).contains(line(p(11.0, 55.0), p(24.0, 55.0))))
        assertFalse(coverage(area(rectangle), area(ring(21.0, 50.0, 25.0, 60.0))).contains(line(p(11.0, 55.0), p(24.0, 55.0))))
        val scope = coverage(area(ring(170.0, 40.0, 190.0, 60.0), ring(178.0, 47.0, 182.0, 53.0)))
        for (world in -1..1) {
            assertTrue(scope.contains(line(p(175.0 + world * 360, 45.0), p(-175.0 + world * 360, 45.0))))
            assertFalse(scope.contains(line(p(175.0 + world * 360, 50.0), p(-175.0 + world * 360, 50.0))))
        }
    }

    @Test fun unknownAndMalformedGeometryCannotBecomeALabelAndInputIsNotMutated() {
        val scope = coverage(area(rectangle))
        assertFalse(scope.contains(null))
        assertFalse(scope.contains(area(rectangle)))
        assertFalse(scope.contains(p(Double.NaN, 55.0)))
        assertFalse(scope.contains(p(15.0, 95.0)))
        assertFalse(scope.contains(line(p(15.0, 55.0))))
        assertThrows(IllegalArgumentException::class.java) { coverage(area(rectangle.dropLast(1))) }
        val geometry = line(p(371.0, 55.0), p(379.0, 55.0)); val before = geometry.toJson()
        repeat(3) { assertTrue(scope.contains(geometry)); assertFalse(coverage(area(rectangle, hole)).contains(geometry)) }
        assertEquals(before, geometry.toJson())
    }

    @Test fun everyActualSymbolLayerRetainsItsPresentationAndRequiresAnInitiallyEmptyCoveredSource() {
        val raw = File(requireNotNull(System.getProperty("tropnik.assets")), "maps/style.json").readText()
        for (online in listOf(false, true)) {
            val original = JSONObject(mapStyleForConnection(raw, online))
            val prepared = withMapLabelCoverage(original.toString()); val style = JSONObject(prepared.json)
            val before = original.getJSONArray("layers").objects(); val after = style.getJSONArray("layers").objects()
            val mask = after.indexOfFirst { it.getString("id") == "russia-outside-mask" }
            val symbols = before.filter { it.getString("type") == "symbol" }
            assertEquals(if (online) 16 else 8, symbols.size)
            for (layer in symbols) {
                val index = after.indexOfFirst { it.getString("id") == layer.getString("id") }; val moved = after[index]
                assertTrue(index > mask)
                assertEquals(MAP_LABEL_SOURCE, moved.getString("source"))
                assertFalse(moved.has("source-layer"))
                for (field in listOf("layout", "paint", "minzoom", "maxzoom")) assertEquals(layer.opt(field)?.toString(), moved.opt(field)?.toString())
                layer.optJSONArray("filter")?.let { assertEquals(it.toString(), moved.getJSONArray("filter").getJSONArray(2).toString()) }
            }
            assertEquals(0, style.getJSONObject("sources").getJSONObject(MAP_LABEL_SOURCE).getJSONObject("data").getJSONArray("features").length())
            assertTrue(prepared.groups.all { "name:ru" in it.properties && "name" in it.properties })
            val retained = after.filter { it.getString("id").startsWith("tropnik-label-query-") }
            assertEquals(prepared.groups.filter {
                original.getJSONObject("sources").getJSONObject(it.source).getString("type") == "geojson"
            }.map { it.source }.toSet(), retained.map { it.getString("source") }.toSet())
            for (layer in retained) {
                val filter = layer.getJSONArray("filter")
                assertEquals("==", filter.getString(0))
                // A nested operand is required for native expression syntax;
                // a numeric legacy property name drops the retention layer.
                assertEquals("literal", filter.getJSONArray(1).getString(0))
                assertNotEquals(filter.getJSONArray(1).getInt(1), filter.getInt(2))
            }
        }
    }

    @Test fun geographicAdmissionIgnoresLanguageAndTileLocalIdsButDeduplicatesExactFeatures() {
        val group = MapLabelGroup("places", "source", "place", listOf("name", "name:ru"), listOf(MapLabelRule(0.0, 20.0, null)))
        fun feature(x: Double, name: String) = Feature.fromGeometry(p(x, 55.0), com.google.gson.JsonObject().apply {
            addProperty("name:ru", name); addProperty("private_unused", "discard"); addProperty("name", name)
        }, "same-tile-local-id")
        val first = feature(11.0, "Первый"); val second = feature(19.0, "Второй"); val foreign = feature(25.0, "Иностранное русское имя")
        val before = first.toJson()
        val processor = MapLabelProcessor(coverage(area(rectangle)))
        val result = FeatureCollection.fromJson(processor.process(listOf(MapLabelBatch(group, listOf(first, second, first, foreign))))).features()!!
        assertEquals(2, result.size)
        assertEquals(setOf(11.0, 19.0), result.map { (it.geometry() as Point).longitude() }.toSet())
        assertTrue(result.all { !it.hasProperty("private_unused") && it.hasProperty("__tropnik_label_group") })
        assertEquals(before, first.toJson())
        assertThrows(InterruptedException::class.java) { processor.process(listOf(MapLabelBatch(group, listOf(first)))) { throw InterruptedException() } }
    }

    @Test fun activeZoomFiltersAreUnionedAndUnfilteredRulesDoNotNarrowOtherLabels() {
        val first = "[\"==\",[\"get\",\"class\"],\"city\"]"; val second = "[\"==\",[\"get\",\"class\"],\"town\"]"
        val group = MapLabelGroup("a", "v", "place", emptyList(), listOf(MapLabelRule(4.0, 8.0, first), MapLabelRule(6.0, 12.0, second)))
        assertFalse(group.query(3.0).first)
        assertEquals(first, group.query(4.0).second)
        assertEquals("any", JSONArray(group.query(6.0).second!!).getString(0))
        assertEquals(second, group.query(8.0).second)
        assertFalse(group.query(12.0).first)
        assertNull(group.copy(rules = group.rules + MapLabelRule(0.0, 24.0, null)).query(6.0).second)
    }

    private fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }
}
