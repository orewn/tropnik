package ru.tropa.app.data

import java.net.URLEncoder

internal const val BROWSER_PLANNER_URL = "https://orewn.github.io/tropnik/planner/"

internal data class BrowserPlannerTarget(val url: String, val routeTitle: String? = null)

/** Only the bundled reference catalogue shares identifiers with the web planner.
 * Account/API routes, examples and cards without a line cannot seed a plan. */
internal fun Catalog.browserPlannerTarget(route: TrailRoute? = null): BrowserPlannerTarget? {
    if (route == null) return BrowserPlannerTarget(BROWSER_PLANNER_URL)
    if (route.illustrative || route.geometryAsset == null || route.apiRouteId != null || route.apiOrigin != null) return null
    val reference = routes.firstOrNull {
        it.id == route.id && !it.illustrative && it.geometryAsset != null && it.apiRouteId == null && it.apiOrigin == null
    } ?: return null
    return BrowserPlannerTarget(
        "$BROWSER_PLANNER_URL?route=${URLEncoder.encode(reference.id, "UTF-8")}",
        reference.title,
    )
}
