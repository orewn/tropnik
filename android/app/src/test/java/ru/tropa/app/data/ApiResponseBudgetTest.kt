package ru.tropa.app.data

import org.junit.Assert.assertEquals
import org.junit.Test

class ApiResponseBudgetTest {
    @Test fun safetyResponseCapsCannotEscapeTheirExactSuccessfulMethodAndResource() {
        // These paths are registered in backend/internal/httpapi/server.go.
        // Native navigation opens the web planner; it does not invent API calls.
        val reads = mapOf(
            "/departures/fixture-id/emergency-card" to ApiResponseBudget.EMERGENCY_CARD_BYTES,
            "/departures/fixture-id/safety-passport" to ApiResponseBudget.SAFETY_PASSPORT_BYTES,
        )
        for ((path, budget) in reads) {
            assertEquals(budget, ApiResponseBudget.forResponse(path, "GET", true))
            assertEquals(budget, ApiResponseBudget.forResponse(path + "?locale=ru", "get", true))
            for (method in listOf("POST", "PATCH", "DELETE", "HEAD")) {
                assertEquals(ApiResponseBudget.DEFAULT_BYTES, ApiResponseBudget.forResponse(path, method, true))
            }
            assertEquals(ApiResponseBudget.DEFAULT_BYTES, ApiResponseBudget.forResponse(path, "GET", false))
        }
        val writes = listOf("safety-passport/prepare", "mchs/submission", "mchs/confirmation", "mchs/start-contact", "mchs/return-report")
        for (action in writes) {
            val path = "/departures/fixture-id/$action"
            assertEquals(ApiResponseBudget.SAFETY_PASSPORT_BYTES, ApiResponseBudget.forResponse(path, "POST", true))
            for (method in listOf("GET", "PATCH", "DELETE", "HEAD")) {
                assertEquals(ApiResponseBudget.DEFAULT_BYTES, ApiResponseBudget.forResponse(path, method, true))
            }
            assertEquals(ApiResponseBudget.DEFAULT_BYTES, ApiResponseBudget.forResponse(path, "POST", false))
            for (invalid in listOf(path + "/", path + "/extra", path + "#fragment", path.replace("fixture-id/", "fixture-id%2F"),
                path.replace("fixture-id", ".."), "/me?next=" + path)) {
                assertEquals(invalid, ApiResponseBudget.DEFAULT_BYTES, ApiResponseBudget.forResponse(invalid, "POST", true))
            }
        }
        for (path in reads.keys) for (invalid in listOf(path + "/", path + "/extra", path + "#fragment", "/other" + path)) {
            assertEquals(invalid, ApiResponseBudget.DEFAULT_BYTES, ApiResponseBudget.forResponse(invalid, "GET", true))
        }
    }
}
