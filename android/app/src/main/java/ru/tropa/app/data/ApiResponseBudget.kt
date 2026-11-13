package ru.tropa.app.data

/** Decoded JSON budgets for the backend response contracts. */
internal object ApiResponseBudget {
    const val DEFAULT_BYTES = 1_048_576
    // A 100-message window can contain 4000 Unicode runes per message. Go's
    // HTML escaping alone can expand its valid JSON beyond the default 1 MiB.
    const val CHAT_WINDOW_BYTES = 4 * DEFAULT_BYTES
    const val COLLECTION_BYTES = 8 * DEFAULT_BYTES
    const val FULL_ROUTE_BYTES = 8 * DEFAULT_BYTES
    const val EMERGENCY_CARD_BYTES = 2 * DEFAULT_BYTES
    const val SAFETY_PASSPORT_BYTES = 16 * DEFAULT_BYTES

    private val routeDetail = Regex("routes/[A-Za-z0-9_-]{1,128}")
    private val chatWindow = Regex("(?:departures|recruitment-requests)/[A-Za-z0-9_-]{1,128}/messages")
    private val reviewCollection = Regex("(?:departures|guides)/[A-Za-z0-9_-]{1,128}/reviews")
    private val collections = setOf("recruitment-requests", "me/reports", "me/moderation-actions", "me/appeals",
        "me/notifications", "moderation/reports", "moderation/appeals")
    private val emergencyCard = Regex("departures/[A-Za-z0-9_-]{1,128}/emergency-card")
    private val safetyPassport = Regex("departures/[A-Za-z0-9_-]{1,128}/safety-passport")
    private val passportResult = Regex("departures/[A-Za-z0-9_-]{1,128}/(?:safety-passport/prepare|mchs/(?:submission|confirmation|start-contact|return-report))")

    fun forResponse(path: String, method: String, successful: Boolean): Int {
        if (!successful) return DEFAULT_BYTES
        val pathname = path.substringBefore('?').removePrefix("/")
        if (method.equals("GET", ignoreCase = true)) {
            return when {
                routeDetail.matches(pathname) -> FULL_ROUTE_BYTES
                chatWindow.matches(pathname) -> CHAT_WINDOW_BYTES
                pathname in collections || reviewCollection.matches(pathname) -> COLLECTION_BYTES
                emergencyCard.matches(pathname) -> EMERGENCY_CARD_BYTES
                safetyPassport.matches(pathname) -> SAFETY_PASSPORT_BYTES
                else -> DEFAULT_BYTES
            }
        }
        // These five existing backend mutations return the complete passport,
        // not a small acknowledgement. No native UI/API method is added here.
        if (method.equals("POST", ignoreCase = true) && passportResult.matches(pathname)) return SAFETY_PASSPORT_BYTES
        return DEFAULT_BYTES
    }
}
