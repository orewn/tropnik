package ru.tropa.app.data

import org.json.JSONObject
import org.maplibre.android.geometry.LatLngBounds
import org.maplibre.geojson.FeatureCollection
import org.maplibre.geojson.Geometry
import org.maplibre.geojson.MultiPolygon
import org.maplibre.geojson.Point
import org.maplibre.geojson.Polygon
import org.maplibre.turf.TurfJoins

/** The product's documented display selection, never a legal or navigation boundary. */
internal class RussiaDisplayArea private constructor(
    val fitBounds: LatLngBounds,
    val cameraBounds: LatLngBounds,
    private val polygons: List<Geometry>,
) {
    fun contains(longitude: Double, latitude: Double): Boolean {
        if (!longitude.isFinite() || !latitude.isFinite() || latitude !in -90.0..90.0) return false
        val canonical = ((longitude + 180) % 360 + 360) % 360 - 180
        val point = Point.fromLngLat(canonical, latitude)
        return polygons.any { geometry -> when (geometry) {
            is MultiPolygon -> TurfJoins.inside(point, geometry)
            is Polygon -> TurfJoins.inside(point, geometry)
            else -> false
        } }
    }

    fun cameraLongitude(longitude: Double): Double = if (longitude < 0) longitude + 360 else longitude

    companion object {
        fun load(readAsset: (String) -> String): RussiaDisplayArea {
            val metadata = JSONObject(readAsset("maps/russia/russia-boundaries-provenance.json"))
            require(metadata.getInt("schemaVersion") == 1 && metadata.getJSONObject("validation").getBoolean("passed"))
            fun bounds(name: String): LatLngBounds {
                val values = metadata.getJSONArray(name)
                val sw = values.getJSONArray(0); val ne = values.getJSONArray(1)
                return LatLngBounds.from(ne.getDouble(1), ne.getDouble(0), sw.getDouble(1), sw.getDouble(0))
            }
            val area = FeatureCollection.fromJson(readAsset("maps/russia/russia-canonical-area.geojson"))
            val polygons = area.features().orEmpty().mapNotNull { it.geometry() }
            require(polygons.isNotEmpty() && polygons.all { it is Polygon || it is MultiPolygon })
            return RussiaDisplayArea(bounds("fitBounds"), bounds("recommendedMaxBounds"), polygons)
        }
    }
}
