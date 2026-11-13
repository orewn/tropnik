package ru.tropa.app.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MapCameraCheckpointTest {
    private fun camera(longitude: Double = 181.25, zoom: Double = 13.25): JSONObject =
        JSONObject().put("center", JSONArray(listOf(longitude, 65.25)))
            .put("zoom", zoom).put("bearingDegrees", -32.5)

    @Test fun replacementRendererRestoresTheCompletedWorldCopyWithoutRefittingAnotherFocus() {
        val frame = camera()
        val checkpoint = requireNotNull(MapCameraCheckpoint.capture("chukotka:source-route", frame))
        val recovered = requireNotNull(checkpoint.cameraFor("chukotka:source-route"))
        assertEquals(181.25, recovered.getJSONArray("center").getDouble(0), 0.0)
        assertEquals(13.25, recovered.getDouble("zoom"), 0.0)
        assertEquals(-32.5, recovered.getDouble("bearingDegrees"), 0.0)
        assertNull(checkpoint.cameraFor("chukotka:another-route"))
        assertNull(checkpoint.cameraFor("altai:source-route"))
        // Neither incoming bridge objects nor a command consumer can mutate
        // the retained state across another renderer restart.
        frame.getJSONArray("center").put(0, 30.0)
        recovered.put("zoom", 2.0)
        assertEquals(181.25, checkpoint.cameraFor(checkpoint.focus)!!.getJSONArray("center").getDouble(0), 0.0)
        assertEquals(13.25, checkpoint.cameraFor(checkpoint.focus)!!.getDouble("zoom"), 0.0)
    }

    @Test fun malformedOrOutOfPolicyBridgeFramesCannotReplaceAValidViewport() {
        for (invalid in listOf(JSONObject(), camera().put("center", JSONArray(listOf("181", 65))),
            camera().put("center", JSONArray(listOf(181, 92))), camera(zoom = -1.0), camera(zoom = 18.0),
            camera().put("zoom", "13.25"), camera().put("bearingDegrees", "invalid"))) {
            assertNull(MapCameraCheckpoint.capture("region:route", invalid))
        }
        assertNotNull(MapCameraCheckpoint.capture("null:null", camera(zoom = 0.0)))
    }
}
