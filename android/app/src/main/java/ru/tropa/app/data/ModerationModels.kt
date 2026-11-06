package ru.tropa.app.data

import org.json.JSONObject
import java.time.Instant

data class Badge(val id: String, val title: String, val description: String, val earnedAt: String) {
    companion object { fun parse(j: JSONObject) = Badge(j.getString("id"), j.getString("title"), j.getString("description"), j.getString("earnedAt")) }
}
data class AccountSummary(val account: Account, val completedTrips: Int, val reviewsWritten: Int, val badges: List<Badge>, val mutedUntil: String?) {
    val mutedNow get() = mutedUntil?.let { runCatching { Instant.parse(it).isAfter(Instant.now()) }.getOrDefault(false) } ?: false
    companion object { fun parse(j: JSONObject) = AccountSummary(Account.parse(j.getJSONObject("user")),
        j.getJSONObject("stats").getInt("completedTrips"), j.getJSONObject("stats").getInt("reviewsWritten"),
        j.getJSONArray("badges").objectList().map(Badge::parse), j.getJSONObject("moderation").stringOrNull("mutedUntil")) }
}
data class AccountNotification(val id: String, val kind: String, val title: String, val body: String, val createdAt: String, val readAt: String?) {
    companion object { fun parse(j: JSONObject) = AccountNotification(j.getString("id"), j.getString("kind"), j.getString("title"), j.getString("body"), j.getString("createdAt"), j.stringOrNull("readAt")) }
}
data class ReportTarget(val type: String, val id: String)
data class UserReport(val id: String, val targetType: String, val targetId: String, val reason: String, val body: String,
    val status: String, val createdAt: String, val decisionReason: String?) {
    companion object { fun parse(j: JSONObject) = UserReport(j.getString("id"), j.getString("targetType"), j.getString("targetId"), j.getString("reason"),
        j.getString("body"), j.getString("status"), j.getString("createdAt"), j.stringOrNull("decisionReason")) }
}
data class ModerationAction(val id: String, val targetType: String, val action: String, val reason: String,
    val createdAt: String, val expiresAt: String?, val revokedAt: String?, val appealStatus: String?) {
    companion object { fun parse(j: JSONObject) = ModerationAction(j.getString("id"), j.getString("targetType"), j.getString("action"), j.getString("reason"),
        j.getString("createdAt"), j.stringOrNull("expiresAt"), j.stringOrNull("revokedAt"), j.stringOrNull("appealStatus")) }
}
data class Appeal(val id: String, val actionId: String, val body: String, val status: String, val createdAt: String, val decisionReason: String?) {
    companion object { fun parse(j: JSONObject) = Appeal(j.getString("id"), j.getString("actionId"), j.getString("body"), j.getString("status"), j.getString("createdAt"), j.stringOrNull("decisionReason")) }
}
