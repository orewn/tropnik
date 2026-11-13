package ru.tropa.app.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

data class Region(
    val id: String,
    val name: String,
    val subtitle: String,
    val description: String,
    val latitude: Double,
    val longitude: Double,
    val zoom: Double,
    val territory: Boolean = false,
)

data class TrailRoute(
    val id: String,
    val regionId: String,
    val title: String,
    val summary: String,
    val description: String,
    val difficulty: String,
    val distanceMeters: Double?,
    val ascentMeters: Double?,
    val durationMinutes: Int?,
    val geometryAsset: String?,
    val illustrative: Boolean,
    val fieldVerified: Boolean,
    val sourceName: String,
    val sourceUrl: String?,
    val sourceLicense: String,
    val sourceDate: String,
    val currentStatusLabel: String?,
    val currentAdvisory: String?,
    val advisorySourceUrl: String?,
    val notices: List<String>,
    val rawJson: String,
    val inlineGeometry: String? = null,
    val apiRouteId: String? = null,
    val apiRevisionId: String? = null,
    val apiOrigin: String? = null,
    val durationText: String? = null,
    val regionIds: List<String> = listOf(regionId),
    val officialEvidenceUrl: String? = null,
    val officialEvidenceSummary: String? = null,
    val officialEvidenceScope: String? = null,
    val officialEvidenceCheckedAt: String? = null,
    val sourceKind: String? = null,
    val additionalSources: List<RouteSourceReference> = emptyList(),
    val distanceNote: String? = null,
    val accessStatus: String? = null,
    val territoryIds: List<String> = emptyList(),
)

data class RouteSourceReference(
    val url: String,
    val name: String,
    val scope: String,
    val reviewedAt: String,
    val publishedAt: String? = null,
    val messageId: Int? = null,
)

data class Catalog(val version: String, val regions: List<Region>, val routes: List<TrailRoute>) {
    private val regionsById by lazy { regions.associateBy { it.id } }
    private val routesById by lazy { routes.associateBy { it.id } }
    private val references by lazy { routes.filterNot { it.illustrative } }
    private val referencesByRegion by lazy {
        buildMap<String, MutableList<TrailRoute>> {
            for (route in references) for (id in route.regionIds.distinct()) {
                getOrPut(id) { mutableListOf() }.add(route)
            }
        }
    }
    private val searchByRoute by lazy {
        references.associate { route -> route.id to searchText(listOf(route.title, route.summary,
            route.description, route.regionIds.mapNotNull { regionsById[it]?.name }.joinToString(" ")).joinToString(" ")) }
    }

    fun region(id: String?): Region? = id?.let(regionsById::get)
    fun route(id: String?): TrailRoute? = id?.let(routesById::get)

    /** The same bundled pilot is available through its direction and territory. */
    fun hasDetailedOfflineMap(regionId: String): Boolean {
        val pilot = route("kavkaz-8a") ?: return false
        return pilot.geometryAsset != null && regionId in pilot.regionIds
    }

    /** Cards remain discoverable even when no route line has been published. */
    fun referenceRoutes(query: String = "", regionId: String? = null): List<TrailRoute> {
        val needle = searchText(query.take(100))
        val candidates = if (regionId == null) references else referencesByRegion[regionId].orEmpty()
        return if (needle.isBlank()) candidates.toList() else candidates.filter { searchByRoute.getValue(it.id).contains(needle) }
    }

    companion object {
        fun load(context: Context): Catalog = context.assets.open("catalog.json").bufferedReader().use { parse(JSONObject(it.readText())) }

        internal fun parse(json: JSONObject): Catalog {
            require(json.getInt("schemaVersion") == 1) { "Unsupported bundled catalog schema" }
            val regions = json.getJSONArray("regions").objects().map {
                Region(it.getString("id"), it.getString("name"), it.getString("subtitle"),
                    it.getString("description"), it.getDouble("latitude"), it.getDouble("longitude"),
                    it.getDouble("zoom"), it.optBoolean("territory", false))
            }
            val routes = json.getJSONArray("routes").objects().map { it.toRoute() }
            require(regions.map { it.id }.toSet().size == regions.size)
            require(routes.map { it.id }.toSet().size == routes.size)
            val regionIds = regions.mapTo(mutableSetOf()) { it.id }
            require(routes.all { route -> route.regionId in route.regionIds && route.regionIds.all(regionIds::contains) })
            return Catalog(json.getString("version"), regions, routes)
        }
    }
}

private fun searchText(value: String) = value.trim().lowercase(Locale.ROOT).replace('ё', 'е')
private fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }
private fun JSONObject.optionalString(key: String) = if (isNull(key)) null else getString(key)
private fun JSONObject.optionalDouble(key: String) = if (isNull(key)) null else getDouble(key)

fun JSONObject.toRoute(): TrailRoute = TrailRoute(
    id = getString("id"), regionId = getString("regionId"), title = getString("title"),
    summary = getString("summary"), description = getString("description"),
    difficulty = getString("difficulty"), distanceMeters = optionalDouble("distanceMeters"),
    ascentMeters = optionalDouble("ascentMeters"),
    durationMinutes = if (isNull("durationMinutes")) null else getInt("durationMinutes"),
    geometryAsset = optionalString("geometryAsset"), illustrative = getBoolean("illustrative"),
    fieldVerified = getBoolean("fieldVerified"), sourceName = getString("sourceName"),
    sourceUrl = optionalString("sourceUrl"), sourceLicense = getString("sourceLicense"),
    sourceDate = getString("sourceDate"),
    currentStatusLabel = optionalString("currentStatusLabel"),
    currentAdvisory = optionalString("currentAdvisory"),
    advisorySourceUrl = optionalString("advisorySourceUrl"),
    notices = getJSONArray("notices").let { list -> (0 until list.length()).map { list.getString(it) } },
    rawJson = toString(),
    inlineGeometry = optionalString("inlineGeometry"),
    apiRouteId = optionalString("apiRouteId"),
    apiRevisionId = optionalString("apiRevisionId"),
    apiOrigin = optionalString("apiOrigin"),
    durationText = optionalString("durationText"),
    regionIds = optJSONArray("regionIds")?.let { list -> (0 until list.length()).map { list.getString(it) } }
        ?: listOf(getString("regionId")),
    officialEvidenceUrl = optionalString("officialEvidenceUrl"),
    officialEvidenceSummary = optionalString("officialEvidenceSummary"),
    officialEvidenceScope = optionalString("officialEvidenceScope"),
    officialEvidenceCheckedAt = optionalString("officialEvidenceCheckedAt"),
    sourceKind = optionalString("sourceKind"),
    distanceNote = optionalString("distanceNote"),
    accessStatus = optionalString("accessStatus"),
    territoryIds = optJSONArray("territoryIds")?.let { list -> (0 until list.length()).map { list.getString(it) } }.orEmpty(),
    additionalSources = optJSONArray("additionalSources")?.objects()?.map { source ->
        RouteSourceReference(url = source.getString("url"), name = source.getString("name"),
            scope = source.getString("scope"), reviewedAt = source.getString("reviewedAt"),
            publishedAt = source.optionalString("publishedAt"),
            messageId = if (source.isNull("messageId")) null else source.getInt("messageId"))
    }.orEmpty(),
)

fun PublishedRoute.toTrailRoute(): TrailRoute {
    val source = JSONObject(rawJson).getJSONObject("source")
    val geometry = JSONObject(rawJson).getJSONObject("geometry")
    val difficultyName = when (difficulty) { "easy" -> "Простой"; "moderate" -> "Средний"; "hard" -> "Сложный"; "expert" -> "Экспертный"; else -> difficulty }
    val originKey = java.security.MessageDigest.getInstance("SHA-256").digest(apiOrigin.toByteArray()).take(8).joinToString("") { "%02x".format(it) }
    val snapshot = JSONObject().put("id", "api:$originKey:$id").put("regionId", regionId).put("title", title)
        .put("summary", "Посмотрите описание маршрута и выберите подходящий поход.")
        .put("description", description).put("difficulty", difficultyName).put("distanceMeters", distanceKm * 1000)
        .put("ascentMeters", ascentM).put("durationMinutes", durationMin).put("geometryAsset", JSONObject.NULL)
        .put("inlineGeometry", geometry.toString()).put("apiRouteId", id).put("apiRevisionId", revisionId).put("apiOrigin", apiOrigin)
        .put("illustrative", false).put("fieldVerified", false).put("sourceName", source.getString("name"))
        .put("sourceUrl", source.getString("url")).put("sourceLicense", source.getString("license"))
        .put("sourceDate", source.getString("retrievedAt"))
        .put("currentStatusLabel", if (status == "closed") "Маршрут закрыт" else "Открыт для походов")
        .put("currentAdvisory", if (status == "closed") "Маршрут закрыт для посещения. Уточните ограничения у организатора." else JSONObject.NULL)
        .put("advisorySourceUrl", source.getString("url"))
        .put("notices", JSONArray(listOf("Данные карточки не заменяют проверку условий, погоды и допусков перед выходом.",
            "Группа от $minPeople до $maxGroupSize человек, включая гидов. Необходимое число гидов: $requiredGuides.",
            "Без интернета подробная карта доступна в районе Бзерпинского карниза. Для других районов сохраняется обзорная карта.",
            "Перед походом обновите карточку и проверьте условия посещения.")))
    return snapshot.toRoute()
}
