package ru.tropa.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

sealed interface ServerState {
    data object NotConfigured : ServerState
    data object Idle : ServerState
    data object Checking : ServerState
    data object Reachable : ServerState
    data class Unavailable(val reason: String) : ServerState
}

class ApiClient internal constructor(private val endpoint: () -> String, private val bearer: () -> String?, private val http: OkHttpClient) {
    constructor(endpoint: () -> String, bearer: () -> String?) : this(endpoint, bearer,
        OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS)
            .callTimeout(20, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false)
            .retryOnConnectionFailure(false).build())
    val configured get() = endpoint().isNotBlank()
    val baseUrl get() = ApiAddress.normalize(endpoint())

    suspend fun checkHealth(): ServerState = try {
        if (!configured) ServerState.NotConfigured else {
            // Liveness only proves that the HTTP process responds. The readiness
            // endpoint checks the database/schema; its exact envelope must agree.
            val response = request("GET", "/health/ready", authenticated = false, expectedStatus = 200)
            if (response.optJSONObject("data")?.opt("status") == "ready" &&
                response.optJSONObject("meta")?.opt("mode") == "production" && !response.has("error")) {
                ServerState.Reachable
            } else ServerState.Unavailable("Сервис отвечает, но не подтвердил готовность API и базы данных.")
        }
    } catch (failure: ApiFailure) { ServerState.Unavailable(failure.message) }

    suspend fun authenticate(email: String, password: String, displayName: String? = null, role: String = "tourist"): AccountSession {
        val body = JSONObject().put("email", email.trim()).put("password", password)
        if (displayName != null) body.put("displayName", displayName.trim()).put("role", role)
        val response = request("POST", if (displayName == null) "/auth/login" else "/auth/register", body, authenticated = false).getJSONObject("data")
        return AccountSession(baseUrl, response.getString("token"), response.getString("expiresAt"), Account.parse(response.getJSONObject("user")))
    }
    suspend fun logout() { request("POST", "/auth/logout") }
    suspend fun me() = Account.parse(request("GET", "/me").getJSONObject("data"))
    suspend fun accountSummary() = AccountSummary.parse(request("GET", "/me/summary").getJSONObject("data"))
    suspend fun notifications() = request("GET", "/me/notifications").getJSONArray("data").objectList().map(AccountNotification::parse)
    suspend fun readNotification(id: String) { request("POST", "/me/notifications/${ApiAddress.segment(id)}/read") }
    suspend fun reports() = request("GET", "/me/reports").getJSONArray("data").objectList().map(UserReport::parse)
    suspend fun report(target: ReportTarget, reason: String, body: String) = UserReport.parse(request("POST", "/reports",
        JSONObject().put("targetType", target.type).put("targetId", target.id).put("reason", reason).put("body", body.trim())).getJSONObject("data"))
    suspend fun moderationActions() = request("GET", "/me/moderation-actions").getJSONArray("data").objectList().map(ModerationAction::parse)
    suspend fun appeals() = request("GET", "/me/appeals").getJSONArray("data").objectList().map(Appeal::parse)
    suspend fun appeal(actionId: String, body: String) = Appeal.parse(request("POST", "/moderation-actions/${ApiAddress.segment(actionId)}/appeals", JSONObject().put("body", body.trim())).getJSONObject("data"))
    suspend fun updateProfile(name: String, role: String) = Account.parse(request("PATCH", "/me/profile", JSONObject().put("displayName", name.trim()).put("role", role)).getJSONObject("data"))
    suspend fun routePage(cursor: String? = null): RoutePage {
        val query = if (cursor.isNullOrBlank()) "" else "&cursor=" + URLEncoder.encode(cursor, "UTF-8")
        val response = request("GET", "/routes?limit=25$query", authenticated = false)
        return RoutePage(response.getJSONArray("data").objectList().map { PublishedRoute.parse(it).copy(apiOrigin = baseUrl) }, response.optJSONObject("meta")?.stringOrNull("nextCursor"))
    }
    suspend fun route(id: String) = PublishedRoute.parse(request("GET", "/routes/${ApiAddress.segment(id)}", authenticated = false).getJSONObject("data")).copy(apiOrigin = baseUrl)
    suspend fun departures(routeId: String? = null) = request("GET", "/departures" + (routeId?.let { "?route=${ApiAddress.segment(it)}" } ?: ""), authenticationOptional = true).getJSONArray("data").objectList().map(Departure::parse)
    suspend fun departure(id: String) = Departure.parse(request("GET", "/departures/${ApiAddress.segment(id)}", authenticationOptional = true).getJSONObject("data"))
    suspend fun participants(id: String) = request("GET", "/departures/${ApiAddress.segment(id)}/participants").getJSONArray("data").objectList().map(Participant::parse)
    suspend fun join(departure: Departure, idempotencyKey: String) = Departure.parse(request("POST", "/departures/${ApiAddress.segment(departure.id)}/join",
        JSONObject().put("expectedVersion", departure.version), extraHeaders = mapOf("Idempotency-Key" to idempotencyKey)).getJSONObject("data"))
    suspend fun leave(id: String) = Departure.parse(request("POST", "/departures/${ApiAddress.segment(id)}/leave").getJSONObject("data"))
    suspend fun checkIn(departure: Departure, userId: String) = Departure.parse(request("POST", "/departures/${ApiAddress.segment(departure.id)}/check-in",
        JSONObject().put("userId", userId).put("expectedVersion", departure.version)).getJSONObject("data"))
    suspend fun transition(departure: Departure, action: String) = Departure.parse(request("POST", "/departures/${ApiAddress.segment(departure.id)}/transition",
        JSONObject().put("action", action).put("expectedVersion", departure.version)).getJSONObject("data"))
    suspend fun createDeparture(body: JSONObject) = Departure.parse(request("POST", "/departures", body).getJSONObject("data"))
    suspend fun recruitment(routeId: String? = null) = request("GET", "/recruitment-requests" + (routeId?.let { "?route=${ApiAddress.segment(it)}" } ?: "")).getJSONArray("data").objectList().map(Recruitment::parse)
    suspend fun createRecruitment(routeId: String, date: String?, text: String): Recruitment {
        val body = JSONObject().put("routeId", routeId).put("body", text.trim())
        if (!date.isNullOrBlank()) body.put("preferredDate", date)
        return Recruitment.parse(request("POST", "/recruitment-requests", body).getJSONObject("data"))
    }
    suspend fun joinRecruitment(id: String) { request("POST", "/recruitment-requests/${ApiAddress.segment(id)}/join") }
    suspend fun leaveRecruitment(id: String) { request("POST", "/recruitment-requests/${ApiAddress.segment(id)}/leave") }
    suspend fun acceptRecruitment(id: String, body: JSONObject) = Departure.parse(request("POST", "/recruitment-requests/${ApiAddress.segment(id)}/accept", body).getJSONObject("data"))
    suspend fun messages(conversation: Conversation, cursor: String?): MessagePage {
        val query = if (cursor != null && conversation.kind == ConversationKind.DEPARTURE) "?cursor=" + URLEncoder.encode(cursor, "UTF-8") else ""
        val response = request("GET", "/${conversation.kind.path}/${ApiAddress.segment(conversation.id)}/messages$query")
        return MessagePage(response.getJSONArray("data").objectList().map(ChatMessage::parse), response.optJSONObject("meta")?.stringOrNull("nextCursor"))
    }
    suspend fun sendMessage(conversation: Conversation, text: String, clientId: String) = ChatMessage.parse(request("POST",
        "/${conversation.kind.path}/${ApiAddress.segment(conversation.id)}/messages", JSONObject().put("body", text).put("clientId", clientId)).getJSONObject("data"))
    suspend fun reviews(departureId: String) = request("GET", "/departures/${ApiAddress.segment(departureId)}/reviews", authenticated = false).getJSONArray("data").objectList().map(Review::parse)
    suspend fun review(departureId: String, target: String, rating: Int, text: String) = Review.parse(request("POST",
        "/departures/${ApiAddress.segment(departureId)}/reviews", JSONObject().put("target", target).put("rating", rating).put("body", text.trim())).getJSONObject("data"))

    private suspend fun request(method: String, path: String, body: JSONObject? = null, authenticated: Boolean = true,
        authenticationOptional: Boolean = false, extraHeaders: Map<String, String> = emptyMap(), expectedStatus: Int? = null): JSONObject = withContext(Dispatchers.IO) {
        if (!configured) throw ApiFailure("service_not_configured", "Сначала подключите HTTPS адрес сервиса в профиле.")
        val base = baseUrl
        val token = if (authenticated) bearer() else null
        if (authenticated && !authenticationOptional && token.isNullOrBlank()) throw ApiFailure("auth_required", "Войдите в аккаунт, чтобы продолжить.", 401)
        val requestBody = if (method in setOf("POST", "PATCH", "PUT")) (body?.toString() ?: "{}").toRequestBody("application/json; charset=utf-8".toMediaType()) else null
        val builder = Request.Builder().url(base + path).method(method, requestBody)
            .header("Accept", "application/json").header("User-Agent", "TropnikAndroid/${ru.tropa.app.BuildConfig.VERSION_NAME}")
        if (!token.isNullOrBlank()) builder.header("Authorization", "Bearer $token")
        extraHeaders.forEach { (key, value) -> builder.header(key, value) }
        try {
            http.newCall(builder.build()).execute().use { response ->
                if (response.isSuccessful && expectedStatus != null && response.code != expectedStatus) {
                    throw ApiFailure("unexpected_status", "Сервис не подтвердил готовность ожидаемым ответом (${response.code}).", response.code)
                }
                if (response.code == 204) return@withContext JSONObject()
                val output = ByteArrayOutputStream()
                response.body?.byteStream()?.use { input ->
                    val buffer = ByteArray(8192)
                    while (true) {
                        val length = input.read(buffer)
                        if (length < 0) break
                        if (output.size() + length > 1_048_576) throw ApiFailure("response_too_large", "Ответ сервиса слишком большой. Попробуйте позже.")
                        output.write(buffer, 0, length)
                    }
                }
                val json = runCatching { JSONObject(output.toString("UTF-8")) }.getOrElse {
                    throw ApiFailure("http_${response.code}", "Сервис вернул ответ в неподдерживаемом формате (${response.code}).", response.code)
                }
                if (!response.isSuccessful) {
                    val failure = json.optJSONObject("error")
                    throw ApiFailure(failure?.optString("code")?.takeIf { it.isNotBlank() } ?: "http_${response.code}",
                        failure?.optString("message")?.takeIf { it.isNotBlank() } ?: "Сервис вернул ошибку ${response.code}.", response.code)
                }
                json
            }
        } catch (failure: ApiFailure) { throw failure }
        catch (_: java.io.IOException) { throw ApiFailure("network_unavailable", "Не удалось связаться с сервисом. Проверьте интернет и адрес подключения.") }
    }
}
