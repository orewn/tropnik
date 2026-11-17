package ru.tropa.app

import ru.tropa.app.data.OfflineRegionSnapshot

enum class BrowsePanel { MAP, CONTENT }

/** Small navigation values live separately for each destination. An opened
 * offline snapshot is retained in memory, never serialized into a Bundle. */
data class BrowsingContext(
    val regionId: String? = null,
    val routeId: String? = null,
    val search: String = "",
    val catalogTerritories: Boolean = false,
    val panel: BrowsePanel = BrowsePanel.MAP,
    val routeParentPanel: BrowsePanel = BrowsePanel.MAP,
    val offlineSnapshot: OfflineRegionSnapshot? = null,
)

fun Screen.destination(): Screen = when (this) {
    Screen.TRIPS, Screen.PROFILE -> Screen.MORE
    else -> this
}

internal fun AppState.browsingContext() = BrowsingContext(regionId, routeId, search,
    catalogTerritories, browsePanel, routeParentPanel, offlineSnapshot)

internal fun AppState.navigateTo(target: Screen, fromBack: Boolean = false): AppState {
    if (screen == target) {
        if (!fromBack && target == Screen.SAVED && (routeId != null || offlineSnapshot != null)) {
            return copy(regionId = null, routeId = null, search = "", offlineSnapshot = null,
                catalogTerritories = false, browsePanel = BrowsePanel.MAP, routeParentPanel = BrowsePanel.MAP,
                navigationContexts = navigationContexts + (Screen.SAVED to BrowsingContext()))
        }
        return this
    }
    val retained = navigationContexts + (screen to browsingContext())
    val restored = retained[target] ?: BrowsingContext()
    val parents = if (!fromBack && target in setOf(Screen.TRIPS, Screen.PROFILE)) navigationParents + (target to screen)
        else navigationParents
    return copy(screen = target, regionId = restored.regionId, routeId = restored.routeId,
        search = restored.search, catalogTerritories = restored.catalogTerritories,
        browsePanel = restored.panel, routeParentPanel = restored.routeParentPanel,
        offlineSnapshot = restored.offlineSnapshot, navigationContexts = retained, navigationParents = parents)
}

/** An owned offline snapshot is a child of Saved. Opening it must not replace
 * the user's current map query, route or camera in the Explore destination. */
internal fun AppState.openSavedRegion(snapshot: OfflineRegionSnapshot): AppState = navigateTo(Screen.SAVED).copy(
    regionId = snapshot.pack.regionId, routeId = null, search = "",
    catalogTerritories = snapshot.catalog.region(snapshot.pack.regionId)?.territory == true,
    offlineSnapshot = snapshot, browsePanel = BrowsePanel.CONTENT, routeParentPanel = BrowsePanel.CONTENT,
)

internal fun AppState.navigateBack(): AppState = when {
    routeId != null -> copy(routeId = null, browsePanel = routeParentPanel)
    regionId != null && offlineSnapshot != null ->
        copy(screen = Screen.SAVED, regionId = null, search = "", offlineSnapshot = null,
            catalogTerritories = false, browsePanel = BrowsePanel.MAP, routeParentPanel = BrowsePanel.MAP)
    regionId != null -> copy(regionId = null, search = "", browsePanel = BrowsePanel.CONTENT)
    search.isNotBlank() -> copy(search = "", browsePanel = BrowsePanel.MAP)
    browsePanel == BrowsePanel.CONTENT && screen == Screen.EXPLORE -> copy(browsePanel = BrowsePanel.MAP)
    screen == Screen.TRIPS || screen == Screen.PROFILE -> navigateTo(navigationParents[screen] ?: Screen.MORE, fromBack = true)
    screen != Screen.EXPLORE -> navigateTo(Screen.EXPLORE, fromBack = true)
    else -> this
}
