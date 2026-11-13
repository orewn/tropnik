package ru.tropa.app.data

import org.json.JSONArray
import org.json.JSONObject

/** A completed viewport belongs to its native route/region focus, not to the
 * WebView process. Keep numbers rather than a mutable bridge JSON object. */
internal data class MapCameraCheckpoint(
    val focus: String,
    val longitude: Double,
    val latitude: Double,
    val zoom: Double,
    val bearingDegrees: Double,
) {
    fun cameraFor(currentFocus: String): JSONObject? = if (focus != currentFocus) null else
        JSONObject().put("center", JSONArray(listOf(longitude, latitude)))
            .put("zoom", zoom).put("bearingDegrees", bearingDegrees)

    companion object {
        fun capture(focus: String, camera: JSONObject): MapCameraCheckpoint? = runCatching {
            val center = camera.getJSONArray("center")
            require(center.length() == 2 && center.get(0) is Number && center.get(1) is Number)
            require(camera.get("zoom") is Number)
            require(!camera.has("bearingDegrees") || camera.get("bearingDegrees") is Number)
            val longitude = center.getDouble(0)
            val latitude = center.getDouble(1)
            val zoom = camera.getDouble("zoom")
            val bearing = camera.optDouble("bearingDegrees", 0.0)
            // The engine's Russia world copy includes longitudes beyond 180E.
            require(longitude.isFinite() && latitude.isFinite() && zoom.isFinite() && bearing.isFinite())
            require(longitude in -720.0..720.0 && latitude in -85.051129..85.051129 && zoom in 0.0..17.0)
            MapCameraCheckpoint(focus, longitude, latitude, zoom, bearing)
        }.getOrNull()
    }
}
