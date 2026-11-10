package ru.tropa.app.data

import com.google.gson.JsonObject
import org.json.JSONArray
import org.json.JSONObject
import org.maplibre.geojson.Feature
import org.maplibre.geojson.Geometry

internal const val MAP_LABEL_SOURCE = "tropnik-covered-labels"
private const val LABEL_GROUP = "__tropnik_label_group"
internal data class MapLabelRule(val minimum: Double, val maximum: Double, val filter: String?)
internal data class MapLabelGroup(val key: String, val source: String, val sourceLayer: String?,
                                 val properties: List<String>, val rules: List<MapLabelRule>) {
    fun query(zoom: Double): Pair<Boolean, String?> {
        val active = rules.filter { zoom >= it.minimum && zoom < it.maximum }
        if (active.isEmpty()) return false to null
        if (active.any { it.filter == null }) return true to null
        val filters = active.map { JSONArray(it.filter!!) }
        return true to if (filters.size == 1) filters.first().toString() else JSONArray().put("any").apply { filters.forEach(::put) }.toString()
    }
}
internal data class CoveredMapStyle(val json: String, val groups: List<MapLabelGroup>)
internal data class MapLabelBatch(val group: MapLabelGroup, val features: List<Feature>)

/** The stored template stays fail-closed under its mask. Only this runtime
 * style routes labels through an initially empty, geographically checked source. */
internal fun withMapLabelCoverage(rawStyle: String): CoveredMapStyle {
    val style = JSONObject(rawStyle)
    val layers = style.getJSONArray("layers")
    if ((0 until layers.length()).none { layers.getJSONObject(it).optString("id") == "russia-outside-mask" }) return CoveredMapStyle(rawStyle, emptyList())
    val sources = style.getJSONObject("sources")
    val groups = linkedMapOf<String, MutableList<JSONObject>>()
    val origins = linkedMapOf<String, Pair<String, String?>>()
    val symbols = ArrayList<JSONObject>(); val ground = ArrayList<JSONObject>()
    val retainedSources = hashSetOf<String>()
    val layerIds = (0 until layers.length()).map { layers.getJSONObject(it).getString("id") }.toMutableSet()
    for (i in 0 until layers.length()) {
        val layer = layers.getJSONObject(i)
        val source = layer.optString("source")
        val sourceType = sources.optJSONObject(source)?.optString("type")
        if (layer.optString("type") != "symbol" || sourceType !in setOf("vector", "geojson") || source == MAP_LABEL_SOURCE) { ground.add(layer); continue }
        val sourceLayer = layer.optString("source-layer").takeIf { it.isNotEmpty() }
        if (sourceType == "vector" && sourceLayer == null) { ground.add(layer); continue }
        val key = JSONArray().put(source).put(sourceLayer ?: JSONObject.NULL).toString()
        if (sourceType == "geojson" && retainedSources.add(source)) {
            // A source used only by labels would otherwise have no active
            // tiles after those labels move to the overlay. An always-empty
            // layer retains queryable tiles without drawing a second label.
            var id = "tropnik-label-query-" + retainedSources.size
            while (!layerIds.add(id)) id += "-query"
            ground.add(JSONObject().put("id", id).put("type", "circle").put("source", source)
                .put("filter", JSONArray().put("==").put(1).put(0)))
        }
        groups.getOrPut(key) { ArrayList() }.add(JSONObject(layer.toString()))
        origins[key] = source to sourceLayer
        val originalFilter = layer.optJSONArray("filter")
        layer.put("source", MAP_LABEL_SOURCE).remove("source-layer")
        val filter = JSONArray().put("all").put(JSONArray().put("==").put(JSONArray().put("get").put(LABEL_GROUP)).put(key))
        if (originalFilter != null) filter.put(originalFilter)
        layer.put("filter", filter)
        symbols.add(layer)
    }
    val finalLayers = JSONArray()
    for (layer in ground) {
        finalLayers.put(layer)
        if (layer.optString("id") == "russia-outside-mask") symbols.forEach(finalLayers::put)
    }
    sources.put(MAP_LABEL_SOURCE, JSONObject().put("type", "geojson").put("tolerance", 0).put("buffer", 128).put("maxzoom", 18)
        .put("data", JSONObject().put("type", "FeatureCollection").put("features", JSONArray())))
    style.put("layers", finalLayers)
    val descriptors = groups.map { (key, originals) ->
        val properties = sortedSetOf<String>()
        fun references(value: Any?) {
            if (value !is JSONArray) return
            if (value.optString(0) in setOf("get", "has") && value.opt(1) is String) properties.add(value.getString(1))
            for (index in 0 until value.length()) references(value.opt(index))
        }
        for (layer in originals) {
            references(layer.opt("filter"))
            for (part in listOf("layout", "paint")) layer.optJSONObject(part)?.let { objectPart -> objectPart.keys().forEach { references(objectPart.opt(it)) } }
        }
        val (source, sourceLayer) = origins.getValue(key)
        MapLabelGroup(key, source, sourceLayer, properties.toList(), originals.map { MapLabelRule(it.optDouble("minzoom", 0.0), it.optDouble("maxzoom", 24.0), it.optJSONArray("filter")?.toString()) })
    }
    return CoveredMapStyle(style.toString(), descriptors)
}

/** Single-worker bounded cache; SDK calls stay outside this pure processor. */
internal class MapLabelProcessor(private val coverage: MapLabelGeometry) {
    private val geometryCache = LinkedHashMap<String, Geometry?>()
    fun process(batches: List<MapLabelBatch>, checkCurrent: () -> Unit = {}): String {
        val candidates = sortedSetOf<String>()
        for ((group, features) in batches) for (feature in features) {
            checkCurrent()
            val sourceGeometry = feature.geometry() ?: continue
            val key = sourceGeometry.toJson()
            val geometry = if (geometryCache.containsKey(key)) geometryCache[key] else {
                val accepted = coverage.coveredGeometry(sourceGeometry)
                geometryCache[key] = accepted
                while (geometryCache.size > 4096) geometryCache.remove(geometryCache.keys.first())
                accepted
            } ?: continue
            val properties = JsonObject().apply {
                addProperty(LABEL_GROUP, group.key)
                for (name in group.properties) if (name != LABEL_GROUP && feature.hasProperty(name)) add(name, feature.getProperty(name))
            }
            // Exact content deduplication never conflates unrelated tile-local IDs.
            candidates.add(Feature.fromGeometry(geometry, properties, feature.id()).toJson())
        }
        return "{\"type\":\"FeatureCollection\",\"features\":[" + candidates.joinToString(",") + "]}"
    }
}
