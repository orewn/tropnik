package ru.tropa.app.data

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.time.Instant

data class Account(val id: String, val displayName: String, val email: String, val role: String,
    val guideStatus: String, val emailVerified: Boolean, val rawJson: String, val staffRole: String = "none") {
    companion object {
        fun parse(json: JSONObject) = Account(json.getString("id"), json.getString("displayName"),
            json.getString("email"), json.getString("role"), json.getString("guideStatus"),
            json.getBoolean("emailVerified"), json.toString(), json.optString("staffRole", "none"))
    }
}

data class AccountSession(val origin: String, val token: String, val expiresAt: String, val account: Account) {
    val locallyUnexpired get() = runCatching { Instant.parse(expiresAt).isAfter(Instant.now()) }.getOrDefault(false)
}

data class PublishedRoute(val id: String, val slug: String, val regionId: String, val title: String, val description: String,
    val revisionId: String, val status: String, val difficulty: String, val distanceKm: Double,
    val ascentM: Double, val durationMin: Int, val verifiedAt: String?, val rawJson: String,
    val minPeople: Int = 4, val maxGroupSize: Int = 50, val requiredGuides: Int = 1, val apiOrigin: String = "") {
    companion object {
        fun parse(j: JSONObject) = PublishedRoute(j.getString("id"), j.getString("slug"), j.getString("regionId"),
            j.getString("title"), j.getString("description"), j.getString("revisionId"), j.getString("status"),
            j.getString("difficulty"), j.getDouble("distanceKm"), j.getDouble("ascentM"), j.getInt("durationMin"),
            j.stringOrNull("verifiedAt"), j.toString(), j.optInt("minPeople", 4), j.optInt("maxGroupSize", 50), j.optInt("requiredGuides", 1))
    }
}

data class Departure(val id: String, val routeId: String, val routeRevisionId: String, val guideId: String?, val guideName: String?,
    val startsAt: String, val endsAt: String, val timeZone: String, val minPeople: Int, val capacity: Int,
    val participantCount: Int, val status: String, val version: Int, val routeOpen: Boolean,
    val guideEligible: Boolean, val membership: String) {
    companion object {
        fun parse(j: JSONObject) = Departure(j.getString("id"), j.getString("routeId"), j.getString("routeRevisionId"),
            j.stringOrNull("guideId"), j.stringOrNull("guideName"), j.getString("startsAt"), j.getString("endsAt"),
            j.getString("timeZone"), j.getInt("minPeople"), j.getInt("capacity"), j.getInt("participantCount"),
            j.getString("status"), j.getInt("version"), j.getBoolean("routeOpen"), j.getBoolean("guideEligible"), j.getString("membership"))
    }
}

data class Participant(val userId: String, val displayName: String, val role: String, val status: String) {
    companion object { fun parse(j: JSONObject) = Participant(j.getString("userId"), j.getString("displayName"), j.getString("role"), j.getString("status")) }
}

data class Recruitment(val id: String, val routeId: String, val creatorId: String, val creatorName: String, val preferredDate: String?,
    val body: String, val status: String, val departureId: String?, val interestedCount: Int) {
    companion object {
        fun parse(j: JSONObject) = Recruitment(j.getString("id"), j.getString("routeId"), j.getString("creatorId"),
            j.getString("creatorName"), j.stringOrNull("preferredDate"), j.getString("body"), j.getString("status"),
            j.stringOrNull("departureId"), j.getInt("interestedCount"))
    }
}

data class ChatMessage(val id: String, val userId: String, val displayName: String, val body: String, val clientId: String, val createdAt: String, val visibility: String = "visible") {
    fun json() = JSONObject().put("id", id).put("userId", userId).put("displayName", displayName)
        .put("body", if (visibility == "hidden") "" else body).put("clientId", clientId).put("createdAt", createdAt).put("visibility", visibility)
    companion object { fun parse(j: JSONObject) = ChatMessage(j.getString("id"), j.getString("userId"), j.getString("displayName"),
        if (j.optString("visibility") == "hidden") "" else j.getString("body"), j.getString("clientId"), j.getString("createdAt"), j.optString("visibility", "visible")) }
}

data class Review(val id: String, val target: String, val rating: Int, val body: String, val createdAt: String) {
    companion object { fun parse(j: JSONObject) = Review(j.getString("id"), j.getString("target"), j.getInt("rating"), j.getString("body"), j.getString("createdAt")) }
}

enum class ConversationKind(val path: String) { DEPARTURE("departures"), RECRUITMENT("recruitment-requests") }
data class Conversation(val kind: ConversationKind, val id: String, val title: String)
data class MessagePage(val messages: List<ChatMessage>, val cursor: String?)
data class RoutePage(val routes: List<PublishedRoute>, val cursor: String?)
data class PendingMessageView(val clientId: String, val body: String, val createdAt: Long, val failed: Boolean, val error: String?)
class ApiFailure(val code: String, override val message: String, val status: Int = 0) : Exception(message) {
    val transient get() = status == 0 || status == 408 || status == 429 || status >= 500
}

object ApiAddress {
    fun normalize(value: String): String {
        val input = value.trim()
        if (input.isEmpty()) return ""
        require(input.length <= 2048) { "Адрес сервиса слишком длинный" }
        val uri = URI(input)
        require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null) {
            "Нужен HTTPS адрес без пароля, параметров и фрагмента"
        }
        require(uri.port == -1 || uri.port in 1..65535) { "Некорректный порт сервиса" }
        val path = uri.normalize().path.orEmpty().trimEnd('/')
        require(path.isEmpty() || path.endsWith("/api/v1")) { "Укажите адрес сервиса или полный путь, заканчивающийся /api/v1" }
        return URI("https", null, uri.host.lowercase(), uri.port, path.ifEmpty { "/api/v1" }, null, null).toASCIIString()
    }
    fun segment(id: String): String {
        require(id.matches(Regex("[A-Za-z0-9_-]{1,128}"))) { "Некорректный идентификатор записи" }
        return id
    }
}

internal fun JSONObject.stringOrNull(key: String) = if (isNull(key)) null else getString(key)
internal fun JSONArray.objectList() = (0 until length()).map { getJSONObject(it) }
internal fun String.characterCount() = codePointCount(0, length)
internal fun String.takeCharacters(limit: Int): String = if (characterCount() <= limit) this else substring(0, offsetByCodePoints(0, limit))
