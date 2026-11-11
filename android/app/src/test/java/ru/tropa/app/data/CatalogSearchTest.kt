package ru.tropa.app.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.Locale

class CatalogSearchTest {
    private fun catalog(): Catalog {
        val source = JSONObject(File(requireNotNull(System.getProperty("tropnik.assets")), "catalog.json").readText())
        val regions = source.getJSONArray("regions").let { values -> (0 until values.length()).map {
            val value = values.getJSONObject(it)
            Region(value.getString("id"), value.getString("name"), value.getString("subtitle"),
                value.getString("description"), value.getDouble("latitude"), value.getDouble("longitude"),
                value.getDouble("zoom"), value.optBoolean("territory", false))
        } }
        val routes = source.getJSONArray("routes").let { values -> (0 until values.length()).map { values.getJSONObject(it).toRoute() } }
        return Catalog("actual-bundled-catalogue", regions, routes)
    }

    private fun normalize(value: String) = value.trim().lowercase(Locale.ROOT).replace('ё', 'е')

    @Test fun indexedSearchRetainsLegacyResultsOrderAndAllRegionMemberships() {
        val catalog = catalog()
        val names = catalog.regions.associate { it.id to it.name }
        val queries = listOf("", "  ", "озёр", "ОЗЕР", "тропа", "Байкал", "Перевал", "неизвестный маршрут 999", "я".repeat(120))
        val regions = listOf(null, "missing") + catalog.regions.map { it.id }
        for (regionId in regions) for (query in queries) {
            val needle = normalize(query.take(100))
            val expected = catalog.routes.filter { route ->
                !route.illustrative && (regionId == null || regionId in route.regionIds) &&
                    (needle.isBlank() || normalize(listOf(route.title, route.summary, route.description,
                        route.regionIds.mapNotNull(names::get).joinToString(" ")).joinToString(" ")).contains(needle))
            }.map { it.id }
            assertEquals("query=$query region=$regionId", expected, catalog.referenceRoutes(query, regionId).map { it.id })
        }
        assertFalse(catalog.referenceRoutes().any { it.illustrative })
        assertNull(catalog.region(null))
        assertNull(catalog.route("missing"))
    }

    @Test fun aNewCatalogueRebuildsItsSearchAndIdentityIndexes() {
        val first = catalog()
        first.referenceRoutes("тропа")
        val original = first.referenceRoutes().first()
        val changed = original.copy(title = "Уникальная проверочная тропа ЯКМ", summary = "", description = "")
        val next = first.copy(version = "changed", routes = listOf(changed))
        assertEquals(listOf(changed), next.referenceRoutes("ЯКМ"))
        assertSame(changed, next.route(changed.id))
        assertSame(original, first.route(original.id))
        assertEquals(1, next.referenceRoutes().size)
        assertTrue(first.referenceRoutes().size > 1)
    }

    @Test fun modifyingAResultCannotRemoveRoutesFromLaterQueries() {
        val catalog = catalog()
        val first = catalog.referenceRoutes()
        val expected = first.map { it.id }
        (first as MutableList<TrailRoute>).clear()
        assertEquals(expected, catalog.referenceRoutes().map { it.id })
        for (region in catalog.regions.filter { it.territory }) {
            assertTrue(region.id.startsWith("territory-"))
            assertTrue(catalog.referenceRoutes(regionId = region.id).isNotEmpty())
        }
    }

    @Test fun detailedOfflinePilotRemainsAvailableFromItsTerritoryAndDirection() {
        val catalog = catalog()
        val expected = setOf("krasnodar", "territory-28173009B83675725671802")
        assertEquals(expected, catalog.regions.filter { catalog.hasDetailedOfflineMap(it.id) }.map { it.id }.toSet())
        assertFalse(catalog.hasDetailedOfflineMap("missing"))
        val withoutPilot = catalog.copy(routes = catalog.routes.filterNot { it.id == "kavkaz-8a" })
        assertTrue(withoutPilot.regions.none { withoutPilot.hasDetailedOfflineMap(it.id) })
        val referenceOnly = catalog.copy(routes = listOf(requireNotNull(catalog.route("kavkaz-8a")).copy(geometryAsset = null)))
        assertFalse(referenceOnly.hasDetailedOfflineMap("krasnodar"))
    }
}
