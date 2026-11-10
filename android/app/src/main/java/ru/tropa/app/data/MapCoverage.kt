package ru.tropa.app.data

import com.google.gson.JsonParser
import org.json.JSONArray
import org.json.JSONObject
import org.maplibre.geojson.Feature
import org.maplibre.geojson.FeatureCollection
import org.maplibre.geojson.LineString
import org.maplibre.geojson.MultiLineString
import org.maplibre.geojson.MultiPolygon
import org.maplibre.geojson.Point
import org.maplibre.geojson.Polygon
import java.security.MessageDigest
import kotlin.math.floor

internal const val MAP_COVERAGE_SOURCE = "tropnik-map-coverage"
private const val COVERAGE_PREFIX = "maps/coverage/"

internal data class MapCoverageBounds(val west: Double, val south: Double, val east: Double, val north: Double) {
    fun overlaps(other: MapCoverageBounds): Boolean = south <= other.north && north >= other.south &&
        (-1..1).any { world -> west <= other.east + world * 360 && east >= other.west + world * 360 }

    companion object {
        fun around(center: Double, points: List<Pair<Double, Double>>, padding: Double = 0.0): MapCoverageBounds {
            require(center.isFinite() && points.isNotEmpty() && points.all { it.first.isFinite() && it.second.isFinite() })
            val target = center + 360 * floor((105 - center) / 360 + .5)
            val xs = points.map { it.first + 360 * floor((target - it.first) / 360 + .5) }
            return MapCoverageBounds(xs.min() - padding, points.minOf { it.second } - padding,
                xs.max() + padding, points.maxOf { it.second } + padding)
        }
    }
}

internal data class MapCoverageFile(val path: String, val bytes: Int, val sha256: String)
internal data class MapCoverageCell(val id: String, val bounds: MapCoverageBounds, val levels: Map<String, MapCoverageFile>)
internal data class MapCoverageFrame(val key: String, val json: String, val geometry: MapLabelGeometry,
                                     val detailedCells: Set<String>)
internal data class DecodedMapCoverage(val features: List<Feature>, val estimatedBytes: Long)

/** Reads only the overview and selected viewport cells. All four roles of a
 * leaf are replaced in one source update; true boundary lines never acquire
 * the artificial rectangular edges of the cell partition. */
internal class MapCoverage private constructor(
    val version: String,
    val cells: List<MapCoverageCell>,
    private val levels: List<Pair<String, Double>>,
    private val base: Map<String, List<Feature>>,
    private val readAsset: (String) -> ByteArray,
    private val cacheBudget: Int,
    private val includeTerritory: Boolean,
) {
    private val cache = LinkedHashMap<String, DecodedMapCoverage>(16, .75f, true)
    // This is the decoded detail LRU budget. The single shared overview and
    // last complete frame are separate; encoded bytes are not a heap bound.
    internal var cachedDecodedBytes = 0L
        private set
    private var previous: MapCoverageFrame? = null
    private val cellBounds = cells.associate { it.id to it.bounds }

    fun level(zoom: Double): String {
        require(zoom.isFinite())
        return levels.firstOrNull { zoom <= it.second }?.first ?: levels.last().first
    }

    fun selected(zoom: Double, viewport: MapCoverageBounds): List<MapCoverageCell> {
        val level = level(zoom)
        return cells.filter { it.levels.containsKey(level) && it.bounds.overlaps(viewport) }
    }

    // One background worker owns this small LRU. Canceled camera requests may
    // finish one asset read but can never publish an obsolete frame.
    fun frame(zoom: Double, viewport: MapCoverageBounds, checkCurrent: () -> Unit = {}): MapCoverageFrame {
        checkCurrent()
        val level = level(zoom)
        val selected = selected(zoom, viewport)
        val key = level + ":" + selected.joinToString(",") { it.id }
        previous?.takeIf { it.key == key }?.let { return it }
        val replacement = linkedMapOf<String, List<Feature>>()
        for (cell in selected) {
            checkCurrent()
            val file = cell.levels.getValue(level)
            val cached = cache[file.path] ?: run {
                val data = verified(readAsset, file)
                checkCurrent()
                decodeCoverage(data, version, cell.id, level, cellBounds, includeTerritory, checkCurrent).also { entry ->
                    // A single large cell is usable for this frame, but must
                    // not silently exceed the retained cache limit.
                    if (entry.estimatedBytes <= cacheBudget) {
                        cache[file.path] = entry; cachedDecodedBytes += entry.estimatedBytes
                        while (cachedDecodedBytes > cacheBudget) {
                            val oldest = cache.entries.first()
                            cachedDecodedBytes -= oldest.value.estimatedBytes
                            cache.remove(oldest.key)
                        }
                    }
                }
            }
            replacement[cell.id] = cached.features
        }
        checkCurrent()
        val features = base.flatMap { (id, originals) -> replacement[id] ?: originals }
        val areas = features.filter { it.getStringProperty("role") == "area" }.mapNotNull { it.geometry() }
        val geometry = MapLabelGeometry.fromPolygons(areas)
        checkCurrent()
        val json = FeatureCollection.fromFeatures(features).toJson()
        checkCurrent()
        return MapCoverageFrame(key, json, geometry, replacement.keys.toSet()).also { previous = it }
    }

    companion object {
        fun load(readAsset: (String) -> ByteArray, cacheBudget: Int = 12 * 1024 * 1024,
                 includeTerritory: Boolean = true): MapCoverage {
            require(cacheBudget > 0)
            val manifest = JSONObject(readAsset(COVERAGE_PREFIX + "manifest.json").toString(Charsets.UTF_8))
            require(manifest.getInt("schemaVersion") == 1 && manifest.getString("nativeDecoder") == "indexed-delta-1e7-v1")
            val version = manifest.getString("version")
            require(version.matches(Regex("[0-9a-f]{16}")))
            fun file(record: JSONObject): MapCoverageFile {
                val path = record.getString("url").removePrefix("/data/map-coverage/")
                require(path.matches(Regex("(?:cells/)?[a-zA-Z0-9_.-]+\\.coverage")) && ".." !in path)
                val size = record.getInt("bytes"); val digest = record.getString("sha256")
                require(size in 1..8 * 1024 * 1024 && digest.matches(Regex("[0-9a-f]{64}")))
                return MapCoverageFile(path, size, digest)
            }
            val levels = manifest.getJSONArray("levels").let { values -> (0 until values.length()).map { i ->
                val item = values.getJSONObject(i); item.getString("id") to item.getDouble("maxZoom")
            } }
            require(levels.map { it.first } == listOf("overview", "regional", "local", "source") &&
                levels.zipWithNext().all { (a, b) -> a.second.isFinite() && a.second < b.second } && levels.last().second.isFinite())
            val cells = manifest.getJSONArray("cells").let { values -> (0 until values.length()).map { i ->
                val item = values.getJSONObject(i); val id = item.getString("id"); val bounds = item.getJSONArray("bounds")
                val box = MapCoverageBounds(bounds.getDouble(0), bounds.getDouble(1), bounds.getDouble(2), bounds.getDouble(3))
                require(id.matches(Regex("[a-z0-9-]+")) && bounds.length() == 4 &&
                    listOf(box.west, box.south, box.east, box.north).all(Double::isFinite) &&
                    box.west >= 0 && box.east <= 360 && box.west < box.east && box.south < box.north &&
                    box.south >= -85.051129 && box.north <= 85.051129 && !(box.west < 180 && box.east > 180))
                val records = item.getJSONObject("levels")
                MapCoverageCell(id, box, records.keys().asSequence().associateWith { name ->
                    require(name in setOf("regional", "local", "source")); file(records.getJSONObject(name))
                })
            } }
            require(cells.isNotEmpty() && cells.map { it.id }.distinct().size == cells.size)
            val features = decodeCoverage(verified(readAsset, file(manifest.getJSONObject("base"))), version, null,
                "overview", cells.associate { it.id to it.bounds }, includeTerritory)
            val base = features.features.groupBy { it.getStringProperty("cell") }
            require(base.keys == cells.map { it.id }.toSet())
            return MapCoverage(version, cells, levels, base, readAsset, cacheBudget, includeTerritory)
        }

        private fun verified(read: (String) -> ByteArray, file: MapCoverageFile): ByteArray {
            val data = read(COVERAGE_PREFIX + file.path)
            require(data.size == file.bytes && MessageDigest.getInstance("SHA-256").digest(data)
                .joinToString("") { "%02x".format(it) } == file.sha256) { "Map coverage asset differs from its manifest" }
            return data
        }

    }
}

/** Lossless shared coordinate encoding. The accumulator resets per file, not
 * per ring. Canonical conversion applies to a complete east-of-180 cell. */
internal fun decodeCoverage(data: ByteArray, version: String, cell: String?, level: String,
                            bounds: Map<String, MapCoverageBounds>, includeTerritory: Boolean = true,
                            checkCurrent: () -> Unit = {}): DecodedMapCoverage {
    checkCurrent()
    val encoded = JSONObject(data.toString(Charsets.UTF_8))
    checkCurrent()
    require(encoded.getString("type") == "TropnikCoverage" && encoded.getString("encoding") == "indexed-delta-1e7-v1" &&
        encoded.getString("coverageVersion") == version && encoded.getString("lod") == level &&
        (cell == null || encoded.getString("cell") == cell))
    val positions = encoded.getJSONArray("positions")
    require(positions.length() > 0 && positions.length() % 2 == 0)
    fun integer(value: Any): Long {
        require(value is Number && value.toDouble().isFinite() && value.toDouble() == value.toLong().toDouble())
        return value.toLong()
    }
    val xs = DoubleArray(positions.length() / 2); val ys = DoubleArray(xs.size)
    var x = 0L; var y = 0L
    for (i in xs.indices) {
        if (i % 1024 == 0) checkCurrent()
        val dx = integer(positions.get(2 * i)); val dy = integer(positions.get(2 * i + 1))
        require(dx in -3_600_000_000L..3_600_000_000L && dy in -1_800_000_000L..1_800_000_000L)
        x += dx; y += dy
        require(x in 0..3_600_000_000L && y in -850_511_290L..850_511_290L)
        xs[i] = x / 1e7; ys[i] = y / 1e7
    }
    // Point/list graphs are built directly from the shared indexes. Expanding
    // all coordinates into JSON and parsing it again retained both graphs
    // during the entire decode, and repeated the same Point across roles.
    val pointPool = arrayOfNulls<Point>(xs.size)
    var estimatedBytes = 64L
    fun point(value: Any, shift: Double): Point {
        val index = integer(value); require(index >= 0 && index < xs.size)
        val slot = index.toInt(); val longitude = xs[slot] + shift
        pointPool[slot]?.takeIf { it.longitude() == longitude }?.let { return it }
        // A point on 180 can belong to either canonical half. Never reuse
        // +180 in an eastern cell, or -180 in a western cell.
        estimatedBytes += 160 // Point, coordinate list, boxed doubles and alignment.
        return Point.fromLngLat(longitude, ys[slot]).also { pointPool[slot] = it }
    }
    fun line(values: JSONArray, shift: Double): List<Point> {
        estimatedBytes += 48L + 8L * values.length()
        return ArrayList<Point>(values.length()).apply {
            for (i in 0 until values.length()) {
                if (i % 512 == 0) checkCurrent()
                add(point(values.get(i), shift))
            }
        }
    }
    fun rings(values: JSONArray, shift: Double): List<List<Point>> {
        estimatedBytes += 48L + 8L * values.length()
        return (0 until values.length()).map { line(values.getJSONArray(it), shift) }
    }
    val items = encoded.getJSONArray("features")
    require(items.length() > 0)
    val result = ArrayList<Feature>(items.length())
    for (i in 0 until items.length()) {
        checkCurrent()
        val feature = items.getJSONObject(i); val properties = feature.getJSONObject("properties")
        val id = properties.getString("cell"); val box = requireNotNull(bounds[id])
        require(cell == null || id == cell)
        val geometry = feature.getJSONObject("geometry")
        val type = geometry.getString("type")
        val role = properties.getString("role")
        require(when (role) {
            "area", "mask", "territory" -> type == "Polygon" || type == "MultiPolygon"
            "territory-boundary" -> type == "LineString" || type == "MultiLineString"
            else -> false
        })
        // Native styling only consumes the area, mask and true boundary
        // lines. The shared package retains territory for the web renderer.
        if (!includeTerritory && role == "territory") continue
        val shift = if (box.west >= 180) -360.0 else 0.0
        val coordinates = geometry.getJSONArray("coordinates")
        val decoded = when (type) {
            "Polygon" -> Polygon.fromLngLats(rings(coordinates, shift))
            "MultiPolygon" -> {
                estimatedBytes += 48L + 8L * coordinates.length()
                MultiPolygon.fromLngLats((0 until coordinates.length()).map { rings(coordinates.getJSONArray(it), shift) })
            }
            "LineString" -> LineString.fromLngLats(line(coordinates, shift))
            "MultiLineString" -> MultiLineString.fromLngLats(rings(coordinates, shift))
            else -> throw IllegalArgumentException("Unknown coverage geometry")
        }
        val json = properties.toString()
        estimatedBytes += 512L + json.length * 4L
        result.add(Feature.fromGeometry(decoded, JsonParser.parseString(json).asJsonObject,
            if (feature.has("id") && !feature.isNull("id")) feature.getString("id") else null))
    }
    checkCurrent()
    return DecodedMapCoverage(result, estimatedBytes)
}
