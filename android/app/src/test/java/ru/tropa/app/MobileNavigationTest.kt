package ru.tropa.app

import org.junit.Assert.*
import org.junit.Test
import ru.tropa.app.data.Catalog
import ru.tropa.app.data.InstalledPackEntity
import ru.tropa.app.data.OfflineRegionSnapshot
import ru.tropa.app.data.Region

class MobileNavigationTest {
    @Test fun destinationSwitchRestoresTheExplorationContextAndDoesNotResetOnReselection() {
        val exploring = AppState(regionId = "karelia", search = "трейл", catalogTerritories = true,
            browsePanel = BrowsePanel.CONTENT)
        assertSame(exploring, exploring.navigateTo(Screen.EXPLORE))
        val saved = exploring.navigateTo(Screen.SAVED)
        assertNull(saved.regionId)
        val returned = saved.navigateTo(Screen.EXPLORE)
        assertEquals("karelia", returned.regionId)
        assertEquals("трейл", returned.search)
        assertTrue(returned.catalogTerritories)
        assertEquals(BrowsePanel.CONTENT, returned.browsePanel)
    }

    @Test fun routeBackReturnsToSavedWithoutBorrowingTheExploreSelection() {
        val saved = AppState(regionId = "altai", search = "гора").navigateTo(Screen.SAVED)
        val detail = saved.copy(routeId = "saved-route", browsePanel = BrowsePanel.CONTENT)
        val returned = detail.navigateBack()
        assertEquals(Screen.SAVED, returned.screen)
        assertNull(returned.routeId)
        assertNull(returned.regionId)
        assertEquals("altai", returned.navigateTo(Screen.EXPLORE).regionId)
        assertEquals("гора", returned.navigateTo(Screen.EXPLORE).search)
        val viaTab = detail.navigateTo(Screen.SAVED)
        assertEquals(Screen.SAVED, viaTab.screen)
        assertNull(viaTab.routeId)
        assertSame(viaTab, viaTab.navigateTo(Screen.SAVED))
        assertEquals("гора", viaTab.navigateTo(Screen.EXPLORE).search)
    }

    @Test fun moreChildrenKeepTheDestinationStableAndHaveAnExplicitParent() {
        val profile = AppState().navigateTo(Screen.MORE).navigateTo(Screen.PROFILE)
        assertEquals(Screen.MORE, profile.screen.destination())
        val menu = profile.navigateTo(Screen.MORE)
        assertEquals(Screen.MORE, menu.screen)
        assertSame(menu, menu.navigateTo(Screen.MORE))
        assertEquals(Screen.MORE, profile.navigateBack().screen)
        val trips = profile.navigateBack().navigateTo(Screen.TRIPS)
        assertEquals(Screen.MORE, trips.navigateBack().screen)
    }

    @Test fun offlineRegionBReturnsToSavedWithoutOverwritingMapA() {
        val mapA = AppState(regionId = "karelia", routeId = "route-a", search = "трейл",
            catalogTerritories = true, browsePanel = BrowsePanel.MAP, routeParentPanel = BrowsePanel.CONTENT)
        val packB = InstalledPackEntity("altai", "Алтай", "test", "/owned/pack-b", 12L, 1L, true)
        val snapshotB = OfflineRegionSnapshot(packB, Catalog("test", listOf(
            Region("altai", "Алтай", "", "", 51.0, 85.0, 8.0)), emptyList()))
        val openedB = mapA.navigateTo(Screen.SAVED).openSavedRegion(snapshotB)
        assertEquals(Screen.SAVED, openedB.screen)
        assertEquals("altai", openedB.regionId)
        assertSame(snapshotB, openedB.offlineSnapshot)
        val saved = openedB.navigateBack()
        assertEquals(Screen.SAVED, saved.screen)
        assertNull(saved.regionId)
        assertNull(saved.offlineSnapshot)
        val returnedA = saved.navigateTo(Screen.EXPLORE)
        assertEquals(mapA.browsingContext(), returnedA.browsingContext())
        val rootFromTab = openedB.navigateTo(Screen.SAVED)
        assertNull(rootFromTab.offlineSnapshot)
        assertNull(rootFromTab.regionId)
        assertEquals(mapA.browsingContext(), rootFromTab.navigateTo(Screen.EXPLORE).browsingContext())
        // A temporary destination switch also retains the owned Saved snapshot.
        val resumedB = openedB.navigateTo(Screen.EXPLORE).navigateTo(Screen.SAVED)
        assertSame(snapshotB, resumedB.offlineSnapshot)
        assertEquals("altai", resumedB.regionId)
    }

    @Test fun tripsOpenedFromARouteReturnToThatRouteAndItsPanel() {
        val route = AppState(regionId = "krasnodar", routeId = "kavkaz-8a", search = "карниз",
            browsePanel = BrowsePanel.CONTENT)
        val trips = route.navigateTo(Screen.TRIPS)
        assertEquals(Screen.MORE, trips.screen.destination())
        val profile = trips.navigateTo(Screen.PROFILE)
        assertEquals(Screen.TRIPS, profile.navigateBack().screen)
        val returned = profile.navigateBack().navigateBack()
        assertEquals(Screen.EXPLORE, returned.screen)
        assertEquals("kavkaz-8a", returned.routeId)
        assertEquals("карниз", returned.search)
        assertEquals(BrowsePanel.CONTENT, returned.browsePanel)
    }

    @Test fun backClosesTheCurrentContextInOrderWithoutClearingAnotherDestination() {
        val detail = AppState(regionId = "karelia", routeId = "route", search = "трейл",
            browsePanel = BrowsePanel.CONTENT, routeParentPanel = BrowsePanel.MAP)
        val region = detail.navigateBack()
        assertNull(region.routeId)
        assertEquals("karelia", region.regionId)
        assertEquals("трейл", region.search)
        assertEquals(BrowsePanel.MAP, region.browsePanel)
        val overview = region.navigateBack()
        assertNull(overview.regionId)
        assertEquals("", overview.search)
        assertEquals(BrowsePanel.CONTENT, overview.browsePanel)
        assertEquals(BrowsePanel.MAP, overview.navigateBack().browsePanel)
    }
}
