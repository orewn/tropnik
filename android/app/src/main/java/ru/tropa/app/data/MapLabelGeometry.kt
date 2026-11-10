package ru.tropa.app.data

import org.maplibre.geojson.Geometry
import org.maplibre.geojson.LineString
import org.maplibre.geojson.MultiLineString
import org.maplibre.geojson.MultiPoint
import org.maplibre.geojson.MultiPolygon
import org.maplibre.geojson.Point
import org.maplibre.geojson.Polygon
import kotlin.math.abs
import kotlin.math.asinh
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt
import kotlin.math.tan

/** Immutable indexes over the sourced country rings. Build off the UI thread.
 * Labels retain their complete glyphs; eligibility concerns their point or all
 * rendered line segments, including holes, rather than a text bounding box. */
internal class MapLabelGeometry private constructor(polygons: List<List<List<XY>>>) {
    private val geographic = Area(polygons)
    private val projected = Area(polygons.map { polygon -> polygon.map { ring -> ring.map { XY(it.x, mercator(it.y)) } } })

    fun coveredGeometry(geometry: Geometry?): Geometry? {
        val normalized = normalize(geometry) ?: return null
        val covered = when (normalized) {
            is Point -> coveredPoint(normalized)
            is MultiPoint -> normalized.coordinates().let { it.isNotEmpty() && it.all(::coveredPoint) }
            is LineString -> coveredLine(normalized.coordinates())
            is MultiLineString -> normalized.coordinates().let { it.isNotEmpty() && it.all(::coveredLine) }
            else -> false
        }
        return normalized.takeIf { covered }
    }

    fun contains(geometry: Geometry?): Boolean = coveredGeometry(geometry) != null

    private fun coveredPoint(point: Point): Boolean = geographic.contains(XY(point.longitude(), point.latitude())) &&
        projected.contains(XY(point.longitude(), mercator(point.latitude())))

    private fun coveredLine(points: List<Point>): Boolean {
        if (points.size < 2 || !points.all(::coveredPoint)) return false
        val line = points.map { XY(it.longitude(), mercator(it.latitude())) }
        return line.zipWithNext().all { (a, b) -> projected.coversSegment(a, b) }
    }

    private data class XY(val x: Double, val y: Double)
    private data class Edge(val a: XY, val b: XY) {
        val west = min(a.x, b.x); val east = max(a.x, b.x)
        val south = min(a.y, b.y); val north = max(a.y, b.y)
    }

    private class Buckets<T>(values: List<T>, private val south: Double, north: Double,
                             lower: (T) -> Double, upper: (T) -> Double) {
        private val count = max(1, min(512, ceil(sqrt(values.size.toDouble()) * 2).toInt()))
        private val scale = if (north > south) count / (north - south) else 0.0
        private val rows = List(count) { ArrayList<T>() }
        init { for (value in values) for (row in bucket(lower(value) - EPS)..bucket(upper(value) + EPS)) rows[row].add(value) }
        private fun bucket(y: Double) = floor((y - south) * scale).toInt().coerceIn(0, count - 1)
        fun at(y: Double): List<T> = rows[bucket(y)]
        fun between(a: Double, b: Double): Sequence<T> = (bucket(a - EPS)..bucket(b + EPS)).asSequence().flatMap { rows[it].asSequence() }.distinct()
    }

    private class Ring(points: List<XY>) {
        val west = points.minOf { it.x }; val east = points.maxOf { it.x }
        val south = points.minOf { it.y }; val north = points.maxOf { it.y }
        val edges = points.zipWithNext().filter { (a, b) -> a != b }.map { (a, b) -> Edge(a, b) }
        private val buckets = Buckets(edges, south, north, { it.south }, { it.north })
        fun contains(p: XY): Boolean {
            if (p.x < west - EPS || p.x > east + EPS || p.y < south - EPS || p.y > north + EPS) return false
            var inside = false
            for (edge in buckets.at(p.y)) {
                if (p.y < edge.south - EPS || p.y > edge.north + EPS || p.x > edge.east + EPS) continue
                val a = edge.a; val b = edge.b
                if (abs(cross(p.x - a.x, p.y - a.y, b.x - a.x, b.y - a.y)) < EPS &&
                    p.x >= edge.west - EPS && p.x <= edge.east + EPS) return true
                if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside
            }
            return inside
        }
    }

    private class Area(input: List<List<List<XY>>>) {
        private val polygons = input.map { it.map(::Ring) }
        private val south = polygons.minOf { it.first().south }; private val north = polygons.maxOf { it.first().north }
        private val polygonBuckets = Buckets(polygons, south, north, { it.first().south }, { it.first().north })
        private val edges = polygons.flatMap { polygon -> polygon.flatMap { it.edges } }
        private val edgeBuckets = Buckets(edges, south, north, { it.south }, { it.north })
        fun contains(p: XY): Boolean = p.x.isFinite() && p.y.isFinite() && p.y >= south - EPS && p.y <= north + EPS &&
            polygonBuckets.at(p.y).any { rings -> rings.first().contains(p) && rings.drop(1).none { it.contains(p) } }

        fun coversSegment(a: XY, b: XY): Boolean {
            if (a == b) return true
            val west = min(a.x, b.x); val east = max(a.x, b.x)
            val low = min(a.y, b.y); val high = max(a.y, b.y)
            val parameters = arrayListOf(0.0, 1.0)
            for (edge in edgeBuckets.between(low, high)) {
                if (edge.east < west - EPS || edge.west > east + EPS || edge.north < low - EPS || edge.south > high + EPS) continue
                intersections(a, b, edge, parameters)
            }
            if (parameters.size == 2) return true // Covered endpoints and no boundary crossing.
            parameters.sort()
            fun inside(t: Double) = contains(XY(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t))
            var previous = 0.0
            for (current in parameters) {
                if (!inside(current) || current > previous && !inside((previous + current) / 2)) return false
                previous = current
            }
            return true
        }
    }

    companion object {
        private const val EPS = 1e-10
        private fun cross(ax: Double, ay: Double, bx: Double, by: Double) = ax * by - ay * bx
        private fun longitude(value: Double) = value + 360 * floor((105 - value) / 360 + .5)
        private fun mercator(latitude: Double) = asinh(tan(latitude * Math.PI / 180)) * 180 / Math.PI
        private fun valid(point: Point) = point.longitude().isFinite() && point.latitude().isFinite() && point.latitude() > -90 && point.latitude() < 90

        fun fromPolygons(geometries: List<Geometry>): MapLabelGeometry {
            val polygons = geometries.flatMap { geometry -> when (geometry) {
                is Polygon -> listOf(geometry.coordinates())
                is MultiPolygon -> geometry.coordinates()
                else -> throw IllegalArgumentException("Coverage must contain polygons")
            } }
            require(polygons.isNotEmpty())
            val rings = polygons.map { polygon ->
                require(polygon.isNotEmpty())
                polygon.map { ring ->
                    require(ring.size >= 4 && ring.all(::valid))
                    val points = ring.map { XY(longitude(it.longitude()), it.latitude()) }
                    require(points.first() == points.last() && points.distinct().size >= 3)
                    points
                }
            }
            return MapLabelGeometry(rings)
        }

        private fun normalize(geometry: Geometry?): Geometry? {
            fun point(value: Point): Point? = if (valid(value)) Point.fromLngLat(longitude(value.longitude()), value.latitude()) else null
            fun points(values: List<Point>): List<Point>? {
                val result = values.map { point(it) ?: return null }
                return result
            }
            return when (geometry) {
                is Point -> point(geometry)
                is MultiPoint -> points(geometry.coordinates())?.let(MultiPoint::fromLngLats)
                is LineString -> points(geometry.coordinates())?.let(LineString::fromLngLats)
                is MultiLineString -> {
                    val lines = geometry.coordinates().map { points(it) ?: return null }
                    MultiLineString.fromLngLats(lines)
                }
                else -> null
            }
        }

        private fun intersections(a: XY, b: XY, edge: Edge, parameters: MutableList<Double>) {
            val rx = b.x - a.x; val ry = b.y - a.y
            val sx = edge.b.x - edge.a.x; val sy = edge.b.y - edge.a.y
            val qx = edge.a.x - a.x; val qy = edge.a.y - a.y
            val denominator = cross(rx, ry, sx, sy)
            if (denominator != 0.0) {
                val t = cross(qx, qy, sx, sy) / denominator; val u = cross(qx, qy, rx, ry) / denominator
                val tolerance = 64 * Math.ulp(1.0)
                if (t >= -tolerance && t <= 1 + tolerance && u >= -tolerance && u <= 1 + tolerance) parameters.add(t.coerceIn(0.0, 1.0))
            } else if (abs(cross(qx, qy, rx, ry)) <= EPS) {
                val useX = abs(rx) >= abs(ry); val delta = if (useX) rx else ry
                val first = if (useX) (edge.a.x - a.x) / delta else (edge.a.y - a.y) / delta
                val last = if (useX) (edge.b.x - a.x) / delta else (edge.b.y - a.y) / delta
                val start = max(0.0, min(first, last)); val end = min(1.0, max(first, last))
                if (start <= end) { parameters.add(start); parameters.add(end) }
            }
        }
    }
}
