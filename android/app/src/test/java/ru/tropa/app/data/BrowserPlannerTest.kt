package ru.tropa.app.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.net.URI
import java.net.URLDecoder

class BrowserPlannerTest {
    private val assets = File(requireNotNull(System.getProperty("tropnik.assets")))
    private val routes = JSONObject(File(assets, "catalog.json").readText()).getJSONArray("routes").let { array ->
        (0 until array.length()).map { array.getJSONObject(it).toRoute() }
    }
    private val catalog = Catalog("test", emptyList(), routes)

    @Test fun generalPlannerUsesThePublicHttpsOriginWithoutRouteOrAccountData() {
        val target = requireNotNull(catalog.browserPlannerTarget())
        val uri = URI(target.url)
        assertEquals("https", uri.scheme)
        assertEquals("orewn.github.io", uri.host)
        assertEquals("/tropnik/planner/", uri.path)
        assertNull(uri.userInfo)
        assertNull(uri.query)
        assertNull(uri.fragment)
        assertNull(target.routeTitle)
    }

    @Test fun everyNativePlannerLinkMatchesAnActualWebGraphRoute() {
        val graph = JSONObject(File(requireNotNull(System.getProperty("tropnik.planner.index"))).readText())
        val graphIds = graph.getJSONObject("routes").keys().asSequence().toSet()
        val links = routes.mapNotNull { route -> catalog.browserPlannerTarget(route)?.let { route to it } }
        assertTrue(graphIds.isNotEmpty())
        assertEquals(graphIds, links.map { it.first.id }.toSet())
        for ((route, target) in links) {
            val uri = URI(target.url)
            assertEquals("https", uri.scheme)
            assertEquals("orewn.github.io", uri.host)
            assertEquals("/tropnik/planner/", uri.path)
            assertEquals(route.id, URLDecoder.decode(uri.rawQuery.removePrefix("route="), "UTF-8"))
            assertEquals(route.title, target.routeTitle)
            assertNull(uri.fragment)
        }
    }

    @Test fun tutorialMissingGeometryUnknownAndServerRoutesCannotSeedAPlan() {
        assertTrue(routes.any { it.illustrative })
        assertTrue(routes.any { !it.illustrative && it.geometryAsset == null })
        routes.filter { it.illustrative || it.geometryAsset == null }.forEach {
            assertNull(it.id, catalog.browserPlannerTarget(it))
        }
        val reference = routes.first { !it.illustrative && it.geometryAsset != null }
        assertNull(catalog.browserPlannerTarget(reference.copy(id = "unknown-route")))
        assertNull(catalog.browserPlannerTarget(reference.copy(apiRouteId = "server-route")))
        assertNull(catalog.browserPlannerTarget(reference.copy(apiOrigin = "https://example.org")))
        assertNull(catalog.browserPlannerTarget(reference.copy(geometryAsset = null, inlineGeometry = "{}")))
    }

    @Test fun aRouteIdentifierCannotAddASecondQueryOrReplaceTheDestination() {
        val route = routes.first { !it.illustrative && it.geometryAsset != null }
            .copy(id = "trail &redirect=https://example.org/#part")
        val synthetic = Catalog("synthetic", emptyList(), listOf(route))
        val uri = URI(requireNotNull(synthetic.browserPlannerTarget(route)).url)
        assertEquals("orewn.github.io", uri.host)
        assertEquals("/tropnik/planner/", uri.path)
        assertEquals(1, uri.rawQuery.split('&').size)
        assertEquals(route.id, URLDecoder.decode(uri.rawQuery.removePrefix("route="), "UTF-8"))
        assertNull(uri.fragment)
    }
}
