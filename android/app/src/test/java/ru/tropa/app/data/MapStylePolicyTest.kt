package ru.tropa.app.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class MapStylePolicyTest {
    private val assets = File(requireNotNull(System.getProperty("tropnik.assets")))
    private val rawStyle get() = File(assets, "maps/style.json").readText()

    @Test fun limitedOfflineAndUserDisabledModesCannotEnableRemoteMap() {
        for (connection in listOf(ConnectionState.OFFLINE, ConnectionState.LIMITED)) {
            assertFalse(canUseOnlineMap(connection, requested = true, failed = false))
        }
        assertFalse(canUseOnlineMap(ConnectionState.ONLINE, requested = false, failed = false))
        assertFalse(canUseOnlineMap(ConnectionState.ONLINE, requested = true, failed = true))
        assertTrue(canUseOnlineMap(ConnectionState.ONLINE, requested = true, failed = false))
    }

    @Test fun offlineStyleHasNoRemoteRequestsAndRetainsLocalMapsRouteAndMask() {
        val style = JSONObject(mapStyleForConnection(rawStyle, false))
        val sources = style.getJSONObject("sources")
        assertFalse(sources.has("online-openmaptiles"))
        assertFalse(sources.has("online-dem"))
        val sourceNames = sources.keys().asSequence().toSet()
        assertTrue(sourceNames.containsAll(listOf("route", "pilot-dem", "russia-overview-relief")))
        for (id in sourceNames) {
            val source = sources.getJSONObject(id)
            for (key in listOf("url", "data")) {
                val value = source.opt(key)
                if (value is String) assertTrue("$id.$key", value.startsWith("asset://"))
            }
            source.optJSONArray("tiles")?.let { tiles ->
                for (i in 0 until tiles.length()) assertTrue(tiles.getString(i).startsWith("asset://"))
            }
        }
        assertTrue(style.getString("glyphs").startsWith("asset://"))
        val layers = style.getJSONArray("layers")
        for (i in 0 until layers.length()) assertFalse(layers.getJSONObject(i).getString("id").startsWith("online-"))
        assertEquals(JSONObject(rawStyle).getJSONArray("layers").let { it.getJSONObject(it.length() - 1).getString("id") }, layers.getJSONObject(layers.length() - 1).getString("id"))
    }

    @Test fun onlineStyleRetainsItsSourcesWithoutChangingOfflineRouteBytes() {
        val original = JSONObject(rawStyle)
        val online = JSONObject(mapStyleForConnection(rawStyle, true))
        assertTrue(online.getJSONObject("sources").has("online-openmaptiles"))
        assertTrue(online.getJSONObject("sources").has("online-dem"))
        assertEquals(original.getJSONObject("sources").getJSONObject("route").toString(), online.getJSONObject("sources").getJSONObject("route").toString())
        assertEquals(original.getJSONArray("layers").length(), online.getJSONArray("layers").length())
    }

    @Test fun referenceDurationsStayTextAndMultiRegionMembershipSurvivesParsing() {
        val routes = JSONObject(File(assets, "catalog.json").readText()).getJSONArray("routes")
        val parsed = (0 until routes.length()).map { routes.getJSONObject(it).toRoute() }
        val official = parsed.first { it.id == "kavkaz-8a" }
        assertEquals("1–5 дней", official.durationText)
        assertNull(official.durationMinutes)
        assertEquals(277, parsed.count { !it.illustrative })
        assertEquals(6, parsed.filter { !it.illustrative }.flatMap { it.regionIds }.toSet().size)
        assertTrue(parsed.all { it.regionId in it.regionIds && !it.fieldVerified })
    }
}
