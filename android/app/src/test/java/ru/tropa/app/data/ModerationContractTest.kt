package ru.tropa.app.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ModerationContractTest {
    @Test fun hiddenMessageNeverRetainsBodyEvenIfServerAccidentallyIncludesIt() {
        val response = JSONObject("""{"id":"message-1","userId":"fixture","displayName":"Fixture","body":"This must not be cached","visibility":"hidden","clientId":"client-1","createdAt":"2026-11-06T10:00:00Z"}""")
        val message = ChatMessage.parse(response)
        assertEquals("", message.body)
        assertEquals("", message.json().getString("body"))
        assertEquals("hidden", message.visibility)
    }

    @Test fun guideAndStaffRolesRemainSeparateAndNoAwardsAreInvented() {
        val response = JSONObject("""{"user":{"id":"fixture","displayName":"Fixture","email":"fixture@example.org","role":"guide","staffRole":"none","guideStatus":"pending","emailVerified":false},"stats":{"completedTrips":0,"reviewsWritten":0},"badges":[],"moderation":{"mutedUntil":null}}""")
        val summary = AccountSummary.parse(response)
        assertEquals("guide", summary.account.role)
        assertEquals("none", summary.account.staffRole)
        assertEquals("pending", summary.account.guideStatus)
        assertTrue(summary.badges.isEmpty())
        assertFalse(summary.mutedNow)
    }

    @Test fun unicodeLimitsMatchServerCodePointCounting() {
        val password = "🥾".repeat(12)
        assertEquals(12, password.characterCount())
        assertEquals("🥾".repeat(5), password.takeCharacters(5))
        assertEquals("привет", "привет".takeCharacters(80))
    }
}
