package ru.tropa.app

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.round
import kotlin.math.sin
import kotlin.math.tan

/** An independent screen-space check of the exact saved/source GeoJSON.
 * Renderer ready/drawnRoute metadata alone cannot prove a visible line. */
internal class RoutePixelProbe(source: String) {
    private data class Point(val x: Double, val y: Double)
    private val lines = mutableListOf<List<Point>>()
    private var sourceVertices = 0
    private val sourceSha256 = MessageDigest.getInstance("SHA-256").digest(source.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

    init {
        fun line(coordinates: JSONArray) {
            require(coordinates.length() >= 2) { "Pixel fixture needs a source line" }
            sourceVertices += coordinates.length()
            require(sourceVertices <= 100_000) { "Pixel fixture exceeds its vertex budget" }
            var longitudeReference = 105.0
            lines.add((0 until coordinates.length()).map { index ->
                val coordinate = coordinates.getJSONArray(index)
                val longitude = coordinate.getDouble(0)
                val latitude = coordinate.getDouble(1)
                require(longitude.isFinite() && latitude.isFinite() && latitude in -90.0..90.0)
                val continuous = longitude + 360 * round((longitudeReference - longitude) / 360)
                longitudeReference = continuous
                Point((continuous + 180) / 360, mercatorY(latitude))
            })
        }
        fun visit(value: JSONObject) {
            when (value.getString("type")) {
                "FeatureCollection" -> value.getJSONArray("features").let { values ->
                    for (index in 0 until values.length()) visit(values.getJSONObject(index))
                }
                "Feature" -> visit(value.getJSONObject("geometry"))
                "GeometryCollection" -> value.getJSONArray("geometries").let { values ->
                    for (index in 0 until values.length()) visit(values.getJSONObject(index))
                }
                "LineString" -> line(value.getJSONArray("coordinates"))
                "MultiLineString" -> value.getJSONArray("coordinates").let { values ->
                    for (index in 0 until values.length()) line(values.getJSONArray(index))
                }
                else -> error("Pixel fixture must contain source lines")
            }
        }
        visit(JSONObject(source))
        require(lines.isNotEmpty())
    }

    fun inspect(bitmap: Bitmap, snapshot: JSONObject, bounds: Rect, visible: Rect, density: Float): JSONObject {
        require(density.isFinite() && density > 0 && bounds.width() > 0 && bounds.height() > 0)
        val size = snapshot.getJSONObject("size")
        val domBounds = snapshot.getJSONObject("viewportBounds")
        val camera = snapshot.getJSONObject("camera")
        val center = camera.getJSONArray("center")
        val centerX = (center.getDouble(0) + 180) / 360
        val centerY = mercatorY(center.getDouble(1))
        val scale = 256 * 2.0.pow(camera.getDouble("zoom"))
        val angle = camera.optDouble("bearingDegrees", 0.0) * PI / 180
        val pitchScale = cos(snapshot.optDouble("pitch", 0.0) * PI / 180)
        val scaleX = bounds.width() / domBounds.getDouble("width")
        val scaleY = bounds.height() / domBounds.getDouble("height")
        require(listOf(centerX, centerY, scale, angle, pitchScale, scaleX, scaleY).all { it.isFinite() })
        require(scale > 0 && scaleX > 0 && scaleY > 0 && pitchScale > 0)
        fun project(point: Point): Point {
            val dx = (point.x - centerX) * scale
            val dy = (point.y - centerY) * scale
            return Point(bounds.left + (size.getDouble("width") / 2 + dx * cos(angle) + dy * sin(angle)) * scaleX,
                bounds.top + (size.getDouble("height") / 2 + (-dx * sin(angle) + dy * cos(angle)) * pitchScale) * scaleY)
        }
        fun rect(value: Rect) = JSONArray(listOf(value.left, value.top, value.right, value.bottom))
        // These are the route-card's native chrome bands, in Android dp:
        // heading above, zoom/north at right, availability/layers/attribution
        // below. Also intersect with actual ancestor clipping and the screen;
        // a partially scrolled WebView must never change the projection scale.
        val roi = Rect(bounds.left + ceil(16 * density).toInt(), bounds.top + ceil(64 * density).toInt(),
            bounds.right - ceil(76 * density).toInt(), bounds.bottom - ceil(140 * density).toInt())
        val report = JSONObject().put("passed", false).put("sourceSha256", sourceSha256)
            .put("sourceVertices", sourceVertices).put("sourceParts", lines.size)
            .put("nativeBounds", rect(bounds)).put("globalVisible", rect(visible)).put("density", density.toDouble())
            .put("projectionScale", JSONArray(listOf(scaleX, scaleY))).put("camera", camera).put("pitch", snapshot.optDouble("pitch", 0.0))
        if (roi.isEmpty || !roi.intersect(visible) || !roi.intersect(0, 0, bitmap.width, bitmap.height)) {
            return report.put("reason", "No unobscured route-card map area is on screen")
        }
        report.put("roi", rect(roi))
        val excluded = mutableListOf<Rect>()
        val markers = snapshot.optJSONArray("markers") ?: JSONArray()
        for (index in 0 until markers.length()) {
            val marker = markers.getJSONObject(index)
            if (marker.optBoolean("hidden")) continue
            val x = bounds.left + marker.getDouble("x") * scaleX
            val y = bounds.top + marker.getDouble("y") * scaleY
            val halfWidth = marker.getDouble("width") * scaleX / 2 + 4 * density
            val halfHeight = marker.getDouble("height") * scaleY / 2 + 4 * density
            excluded.add(Rect(floor(x - halfWidth).toInt(), floor(y - halfHeight).toInt(), ceil(x + halfWidth).toInt(), ceil(y + halfHeight).toInt()))
        }
        // A single source line can carry passive A/B badges and labels. They
        // are not route pixels and cannot satisfy the route-line assertion.
        if (lines.size == 1) for (endpoint in listOf(lines.single().first(), lines.single().last())) {
            val point = project(endpoint)
            excluded.add(Rect(floor(point.x - 40 * density).toInt(), floor(point.y - 24 * density).toInt(),
                ceil(point.x + 40 * density).toInt(), ceil(point.y + 56 * density).toInt()))
        }
        val cell = 8 * density
        val samples = linkedMapOf<Pair<Int, Int>, Point>()
        for (line in lines) for (index in 1 until line.size) {
            val clipped = clip(project(line[index - 1]), project(line[index]), roi) ?: continue
            val dx = clipped.second.x - clipped.first.x
            val dy = clipped.second.y - clipped.first.y
            val steps = ceil(hypot(dx, dy) / (4 * density)).toInt().coerceAtLeast(1)
            for (step in 0..steps) {
                val point = Point(clipped.first.x + dx * step / steps, clipped.first.y + dy * step / steps)
                if (excluded.any { it.contains(point.x.toInt(), point.y.toInt()) }) continue
                val key = floor(point.x / cell).toInt() to floor(point.y / cell).toInt()
                samples.putIfAbsent(key, point)
            }
        }
        val radius = ceil(2 * density).toInt()
        val matched = mutableListOf<Point>()
        val evidence = JSONArray()
        for (point in samples.values) {
            var hit = false
            val x = point.x.toInt(); val y = point.y.toInt()
            for (py in maxOf(roi.top, y - radius)..minOf(roi.bottom - 1, y + radius)) {
                for (px in maxOf(roi.left, x - radius)..minOf(roi.right - 1, x + radius)) {
                    val color = bitmap.getPixel(px, py)
                    // Allow edge anti-aliasing/native color rounding, while
                    // excluding the lighter catalogue stroke and terrain fill.
                    if (Color.alpha(color) >= 240 && abs(Color.red(color) - 0x24) <= 18 &&
                        abs(Color.green(color) - 0x4d) <= 18 && abs(Color.blue(color) - 0x3c) <= 18) hit = true
                }
            }
            if (hit) matched.add(point)
            if (evidence.length() < 128) evidence.put(JSONObject().put("screenX", point.x).put("screenY", point.y)
                .put("cssX", (point.x - bounds.left) / scaleX).put("cssY", (point.y - bounds.top) / scaleY).put("matched", hit))
        }
        val fraction = if (samples.isEmpty()) 0.0 else matched.size.toDouble() / samples.size
        val span = if (matched.isEmpty()) 0.0 else hypot(matched.maxOf { it.x } - matched.minOf { it.x },
            matched.maxOf { it.y } - matched.minOf { it.y }) / density
        return report.put("sampleCount", samples.size).put("matchedSamples", matched.size).put("matchedFraction", fraction)
            .put("matchedSpanDp", span).put("samples", evidence).put("excludedOverlays", JSONArray(excluded.map(::rect)))
            .put("thresholds", JSONObject().put("minimumSamples", 12).put("minimumMatchedFraction", 0.70)
                .put("minimumMatchedSpanDp", 36).put("sampleCellDp", 8).put("searchRadiusPixels", radius).put("channelTolerance", 18))
            .put("passed", samples.size >= 12 && fraction >= 0.70 && span >= 36)
    }

    private fun mercatorY(latitude: Double): Double {
        val radians = latitude.coerceIn(-85.0511287798066, 85.0511287798066) * PI / 180
        return (1 - ln(tan(PI / 4 + radians / 2)) / PI) / 2
    }

    private fun clip(from: Point, to: Point, bounds: Rect): Pair<Point, Point>? {
        val dx = to.x - from.x; val dy = to.y - from.y
        var start = 0.0; var end = 1.0
        for ((direction, distance) in listOf(-dx to from.x - bounds.left, dx to bounds.right - 1 - from.x,
            -dy to from.y - bounds.top, dy to bounds.bottom - 1 - from.y)) {
            if (direction == 0.0) { if (distance < 0) return null }
            else {
                val at = distance / direction
                if (direction < 0) start = maxOf(start, at) else end = minOf(end, at)
                if (start > end) return null
            }
        }
        return Point(from.x + dx * start, from.y + dy * start) to Point(from.x + dx * end, from.y + dy * end)
    }
}
