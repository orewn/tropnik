package ru.tropa.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File

class RussiaDisplayAreaTest {
    @Test fun documentedDisplaySelectionMatchesGeographicCasesIncludingDateline() {
        val assets = File(requireNotNull(System.getProperty("tropnik.assets")))
        val area = RussiaDisplayArea.load { path -> File(assets, path).readText() }
        val fixture = javaClass.getResourceAsStream("/russia-display-cases.json")!!.bufferedReader().use { it.readText() }
        val cases = JSONObject(fixture).getJSONArray("pointCases")
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val point = case.getJSONArray("inputLngLat")
            assertEquals(case.getString("name"), case.getBoolean("expectedInside"), area.contains(point.getDouble(0), point.getDouble(1)))
        }
        assertFalse(area.contains(Double.NaN, 60.0))
        assertFalse(area.contains(50.0, Double.POSITIVE_INFINITY))
        assertEquals(190.1908, area.cameraLongitude(-169.8092), 0.000001)
    }
}
