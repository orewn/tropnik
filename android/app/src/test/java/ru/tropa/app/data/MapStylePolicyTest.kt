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
        val manifest = JSONObject(File(assets, "catalog-manifest.json").readText())
        val referenceIds = manifest.getJSONArray("referenceRouteIds").let { values -> (0 until values.length()).map { values.getString(it) }.toSet() }
        val regionIds = manifest.getJSONArray("regionIds").let { values -> (0 until values.length()).map { values.getString(it) }.toSet() }
        assertEquals(referenceIds, parsed.filter { !it.illustrative }.map { it.id }.toSet())
        assertEquals(regionIds, parsed.filter { !it.illustrative }.flatMap { it.regionIds }.toSet())
        assertTrue(parsed.all { it.regionId in it.regionIds && !it.fieldVerified })
    }

    @Test fun referenceWithoutGeometrySurvivesBookmarkSnapshotAndSearch() {
        // Synthetic fixture; never imported into the public catalogue.
        val source = JSONObject(File(assets, "catalog.json").readText()).getJSONArray("routes").getJSONObject(0)
        source.put("id", "synthetic-reference-only").put("title", "Тропа у озёр")
            .put("geometryAsset", JSONObject.NULL).put("inlineGeometry", JSONObject.NULL)
            .put("distanceMeters", JSONObject.NULL).put("ascentMeters", JSONObject.NULL)
            .put("durationMinutes", JSONObject.NULL).put("durationText", JSONObject.NULL)
            .put("sourceKind", "community").put("sourceUrl", "https://t.me/poiskpohod/101")
            .put("distanceNote", "в одну сторону").put("accessStatus", "unknown")
            .put("territoryIds", org.json.JSONArray().put("territory-synthetic"))
            .put("additionalSources", org.json.JSONArray().put(JSONObject()
                .put("url", "https://t.me/poiskpohod/101").put("name", "Сообщество poiskpohod")
                .put("messageId", 101).put("publishedAt", "2026-11-01T12:00:00")
                .put("reviewedAt", "2026-11-06").put("scope", "community_mention")))
        val card = source.toRoute()
        val restored = JSONObject(card.rawJson).toRoute()
        assertNull(restored.geometryAsset)
        assertNull(restored.inlineGeometry)
        assertNull(restored.distanceMeters)
        assertNull(restored.durationMinutes)
        assertFalse(restored.fieldVerified)
        assertNull(restored.apiRouteId)
        assertEquals(card.additionalSources, restored.additionalSources)
        assertEquals("community", restored.sourceKind)
        assertEquals("в одну сторону", restored.distanceNote)
        assertEquals("unknown", restored.accessStatus)
        assertEquals(listOf("territory-synthetic"), restored.territoryIds)
        assertEquals(101, restored.additionalSources.single().messageId)
        val region = Region(card.regionId, "Учебный регион", "", "", 50.0, 80.0, 6.0)
        val catalog = Catalog("synthetic", listOf(region), listOf(restored))
        assertEquals(listOf(restored), catalog.referenceRoutes("ОЗЕР", card.regionId))
        assertEquals(listOf(restored), catalog.referenceRoutes("Учебный регион"))
        assertTrue(catalog.referenceRoutes("озер", "another-region").isEmpty())
        assertTrue(catalog.referenceRoutes("другое место").isEmpty())
    }
}
