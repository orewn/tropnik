package ru.tropa.app.ui

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MapPresentationStateTest {
    private fun camera(longitude: Double, zoom: Double) = JSONObject()
        .put("center", JSONArray(listOf(longitude, 61.0))).put("zoom", zoom).put("bearingDegrees", 15.0)

    @Test fun mapAndRouteContextsKeepTheirOwnCompletedCameraAndControls() {
        val session = MapPresentationState()
        session.rememberCamera("karelia:null", camera(32.0, 9.0))
        session.rememberCamera("karelia:trail", camera(32.5, 14.0))
        session.rememberCamera("SAVED:karelia:trail", camera(32.8, 12.0))
        session.mode = "satellite"
        session.paths = false
        assertEquals(9.0, session.cameraFor("karelia:null")!!.getDouble("zoom"), 0.0)
        assertEquals(14.0, session.cameraFor("karelia:trail")!!.getDouble("zoom"), 0.0)
        assertEquals(12.0, session.cameraFor("SAVED:karelia:trail")!!.getDouble("zoom"), 0.0)
        assertEquals("satellite", session.mode)
        assertFalse(session.paths)
        assertNull(session.cameraFor("altai:null"))
    }

    @Test fun invalidCameraCannotDestroyTheLastCompletedViewAndHistoryIsBounded() {
        val session = MapPresentationState()
        session.rememberCamera("karelia:null", camera(32.0, 9.0))
        session.rememberCamera("karelia:null", camera(32.0, -1.0))
        assertEquals(9.0, session.cameraFor("karelia:null")!!.getDouble("zoom"), 0.0)
        for (index in 0..32) session.rememberCamera("route:$index", camera(32.0, 9.0))
        assertNull(session.cameraFor("karelia:null"))
        assertNotNull(session.cameraFor("route:32"))
    }
}
