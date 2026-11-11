package ru.tropa.app.data

import org.json.JSONException
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class MapRouteGeometryTest {
    @Test fun actualBundledBzerpinskyLineRetainsItsBytesAndExactCameraExtent() {
        val assets = File(requireNotNull(System.getProperty("tropnik.assets")))
        val source = File(assets, "maps/routes/route-11566519.geojson").readText()
        val prepared = prepareMapRouteGeometry(source)
        assertSame(source, prepared.json)
        assertArrayEquals(source.toByteArray(Charsets.UTF_8), prepared.utf8)
        assertEquals(RouteCameraFrame(43.7632088, 40.4380182, 43.694196, 40.3503352), prepared.frame)
    }

    @Test fun disconnectedPartsAndAltitudeDoNotCreateACameraPointFromProperties() {
        val prepared = prepareMapRouteGeometry("""{"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"coordinates":[0,0]},"geometry":{"type":"MultiLineString","coordinates":[[[30,60,700],[31,61,800]],[[29,59,900],[32,62,1000]]]}}
        ]}""")
        assertEquals(RouteCameraFrame(62.0, 32.0, 59.0, 29.0), prepared.frame)
    }

    @Test fun fullSizeApiRouteReducesToFourExtremaWithoutLosingSourceVertices() {
        val source = buildString {
            append("{\"type\":\"LineString\",\"coordinates\":[")
            repeat(100_000) { index ->
                if (index > 0) append(',')
                append('[').append(30.0 + index / 100_000.0).append(',').append(60.0 + index / 100_000.0).append(']')
            }
            append("]}")
        }
        val prepared = prepareMapRouteGeometry(source)
        assertSame(source, prepared.json)
        assertArrayEquals(source.toByteArray(Charsets.UTF_8), prepared.utf8)
        assertEquals(RouteCameraFrame(60.99999, 30.99999, 60.0, 30.0), prepared.frame)
    }

    @Test fun invalidCoordinatesDoNotEnterCameraBoundsAndSinglePointDoesNotFit() {
        val prepared = prepareMapRouteGeometry("""{"type":"LineString","coordinates":[[181,60],[30,91],[40,50]]}""")
        assertNull(prepared.frame)
        // Fit the continuous Russia world copy while retaining the source.
        assertEquals(RouteCameraFrame(67.0, 181.0, 66.0, 179.0),
            prepareMapRouteGeometry("""{"type":"LineString","coordinates":[[-179,66],[179,67]]}""").frame)
    }

    @Test(expected = JSONException::class)
    fun malformedJsonFailsBeforeBeingGivenToTheNativeMap() {
        prepareMapRouteGeometry("{not-json")
    }
}
