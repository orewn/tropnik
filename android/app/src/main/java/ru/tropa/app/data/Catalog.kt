package ru.tropa.app.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class Region(
    val id: String,
    val name: String,
    val subtitle: String,
    val description: String,
    val latitude: Double,
    val longitude: Double,
    val zoom: Double,
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
)

data class Catalog(val version: String, val regions: List<Region>, val routes: List<TrailRoute>) {
    companion object {
        fun load(context: Context): Catalog {
            val json = context.assets.open("catalog.json").bufferedReader().use { JSONObject(it.readText()) }
            require(json.getInt("schemaVersion") == 1) { "Unsupported bundled catalog schema" }
            val regions = json.getJSONArray("regions").objects().map {
                Region(it.getString("id"), it.getString("name"), it.getString("subtitle"),
                    it.getString("description"), it.getDouble("latitude"), it.getDouble("longitude"),
                    it.getDouble("zoom"))
            }
            val routes = json.getJSONArray("routes").objects().map { it.toRoute() }
            require(regions.map { it.id }.toSet().size == regions.size)
            require(routes.map { it.id }.toSet().size == routes.size)
            require(routes.all { route -> regions.any { it.id == route.regionId } })
            return Catalog(json.getString("version"), regions, routes)
        }
    }
}

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
)

fun PublishedRoute.toTrailRoute(): TrailRoute {
    val source = JSONObject(rawJson).getJSONObject("source")
    val geometry = JSONObject(rawJson).getJSONObject("geometry")
    val difficultyName = when (difficulty) { "easy" -> "Простой"; "moderate" -> "Средний"; "hard" -> "Сложный"; "expert" -> "Экспертный"; else -> difficulty }
    val originKey = java.security.MessageDigest.getInstance("SHA-256").digest(apiOrigin.toByteArray()).take(8).joinToString("") { "%02x".format(it) }
    val snapshot = JSONObject().put("id", "api:$originKey:$id").put("regionId", regionId).put("title", title)
        .put("summary", "Карточка опубликована подключённым сервисом. Состояние на момент загрузки.")
        .put("description", description).put("difficulty", difficultyName).put("distanceMeters", distanceKm * 1000)
        .put("ascentMeters", ascentM).put("durationMinutes", durationMin).put("geometryAsset", JSONObject.NULL)
        .put("inlineGeometry", geometry.toString()).put("apiRouteId", id).put("apiRevisionId", revisionId).put("apiOrigin", apiOrigin)
        .put("illustrative", false).put("fieldVerified", false).put("sourceName", source.getString("name"))
        .put("sourceUrl", source.getString("url")).put("sourceLicense", source.getString("license"))
        .put("sourceDate", source.getString("retrievedAt"))
        .put("currentStatusLabel", if (status == "closed") "Закрыт сервисом" else "Опубликован сервисом")
        .put("currentAdvisory", if (status == "closed") "Сервис обозначил маршрут закрытым. Не используйте линию как разрешение на прохождение." else JSONObject.NULL)
        .put("advisorySourceUrl", source.getString("url"))
        .put("notices", JSONArray(listOf("Данные карточки не заменяют проверку условий, погоды и допусков перед выходом.",
            "Версия маршрута: $revisionId. Поход закрепляется за конкретной версией на сервере.",
            "Правила сервиса: минимум $minPeople человек, максимум $maxGroupSize, гидов: $requiredGuides. Гид включён в число участников.",
            "Подробный офлайн пакет есть только у пилотной зоны Бзерпинского карниза. В остальных местах доступна обзорная карта.",
            "Оффлайн сохранение карточки не обновляет состояние маршрута и не даёт разрешение на старт.")))
    return snapshot.toRoute()
}
