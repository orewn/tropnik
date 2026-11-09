package ru.tropa.app.data

import org.json.JSONArray
import org.json.JSONObject

internal data class RouteCameraFrame(val north: Double, val east: Double, val south: Double, val west: Double)
internal data class PreparedMapRoute(val json: String, val frame: RouteCameraFrame?)

/** Parse off the UI thread. Retain the source geometry, but reduce camera work to
 * four extrema instead of allocating a LatLng for every vertex (up to 100,000
 * in a full API route). No simplification or invented connecting line is used. */
internal fun prepareMapRouteGeometry(json: String): PreparedMapRoute {
    var count = 0
    var north = Double.NEGATIVE_INFINITY
    var east = Double.NEGATIVE_INFINITY
    var south = Double.POSITIVE_INFINITY
    var west = Double.POSITIVE_INFINITY
    fun visit(value: Any?) {
        when (value) {
            is JSONObject -> {
                if (value.has("coordinates")) visit(value.opt("coordinates"))
                if (value.has("geometry")) visit(value.opt("geometry"))
                if (value.has("features")) visit(value.opt("features"))
            }
            is JSONArray -> {
                if (value.length() >= 2 && value.opt(0) is Number && value.opt(1) is Number) {
                    val longitude = value.getDouble(0)
                    val latitude = value.getDouble(1)
                    if (longitude in -180.0..180.0 && latitude in -90.0..90.0) {
                        count++
                        north = maxOf(north, latitude); south = minOf(south, latitude)
                        east = maxOf(east, longitude); west = minOf(west, longitude)
                    }
                } else for (index in 0 until value.length()) visit(value.opt(index))
            }
        }
    }
    visit(JSONObject(json))
    return PreparedMapRoute(json, if (count > 1) RouteCameraFrame(north, east, south, west) else null)
}
