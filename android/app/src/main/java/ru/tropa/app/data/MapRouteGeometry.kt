package ru.tropa.app.data

import org.json.JSONArray
import org.json.JSONObject

internal data class RouteCameraFrame(val north: Double, val east: Double, val south: Double, val west: Double)
internal data class PreparedMapRoute(val json: String, val frame: RouteCameraFrame?, val utf8: ByteArray)

/** Parse off the UI thread. Retain the source geometry, but reduce camera work to
 * four extrema instead of allocating a camera object for every vertex (up to 100,000
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
                        // The shared camera uses the Russia world copy centred
                        // on 105E. A Chukotka route crossing 180E must not fit a
                        // 358-degree box; the source geometry stays untouched.
                        val cameraLongitude = longitude + 360 * kotlin.math.round((105 - longitude) / 360)
                        east = maxOf(east, cameraLongitude); west = minOf(west, cameraLongitude)
                    }
                } else for (index in 0 until value.length()) visit(value.opt(index))
            }
        }
    }
    visit(JSONObject(json))
    return PreparedMapRoute(json, if (count > 1) RouteCameraFrame(north, east, south, west) else null, json.toByteArray(Charsets.UTF_8))
}
