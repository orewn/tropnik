package ru.tropa.app.data

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.Buffer
import okio.GzipSink
import okio.buffer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/** Local TLS fixtures only; no real account, route or service is contacted. */
class ApiRouteHistoryTest {
    private lateinit var server: MockWebServer
    private lateinit var api: ApiClient
    private val token = "t".repeat(43)

    @Before fun setup() {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val clientTls = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        // setChunkedBody writes HTTP/1.1 transfer framing. HTTP/2 DATA must not
        // contain that framing, so these chunked/decoded-budget fixtures use H1.
        server = MockWebServer().apply {
            protocols = listOf(Protocol.HTTP_1_1)
            useHttps(serverTls.sslSocketFactory(), false)
            start()
        }
        val client = OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1))
            .sslSocketFactory(clientTls.sslSocketFactory(), clientTls.trustManager)
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).callTimeout(10, TimeUnit.SECONDS).build()
        api = ApiClient({ server.url("/api/v1").toString() }, { token }, client)
    }

    @After fun close() { server.shutdown() }

    private fun routeJson(coordinates: String = "[33,63],[33.01,63.01]") = """{"id":"route-fixture","slug":"route-fixture","regionId":"karelia","title":"Fixture only","description":"Transport fixture, not a hiking route","revisionId":"revision-fixture","status":"published","difficulty":"easy","distanceKm":1,"ascentM":10,"durationMin":30,"verifiedAt":null,"geometryDetail":"full","geometry":{"type":"LineString","coordinates":[$coordinates]}}"""

    @Test fun fullChatWindowsRetainEveryMaximalHtmlEscapedMessage() = runBlocking {
        // Equivalent to Go encoding/json's default EscapeHTML for 4000 '<'
        // runes. This is valid backend data, not an oversized synthetic string.
        val escapedBody = "\\u003c".repeat(4000)
        val messages = List(100) { index -> """{"id":"message-$index","userId":"fixture-user","displayName":"Fixture","body":"$escapedBody","clientId":"client-$index","createdAt":"2026-11-13T00:00:00Z"}""" }.joinToString(",")
        val body = """{"data":[$messages],"meta":{"mode":"production"}}"""
        assertTrue(body.toByteArray().size > ApiResponseBudget.DEFAULT_BYTES)
        assertTrue(body.toByteArray().size < ApiResponseBudget.CHAT_WINDOW_BYTES)
        for (kind in ConversationKind.entries) {
            server.enqueue(MockResponse().setChunkedBody(body, 8192))
            val page = api.messages(Conversation(kind, "chat-fixture", "Fixture"), null)
            assertEquals(100, page.messages.size)
            assertTrue(page.messages.all { it.body == "<".repeat(4000) })
            assertEquals("message-99", page.messages.last().id)
            val request = server.takeRequest(3, TimeUnit.SECONDS)!!
            assertEquals("/api/v1/${kind.path}/chat-fixture/messages", request.path)
            assertEquals("GET", request.method)
            assertEquals("Bearer $token", request.getHeader("Authorization"))
        }
    }

    @Test fun chatAllowanceIsBoundedAfterDecodeAndDoesNotEnlargeErrorsOrSendAcknowledgements() = runBlocking {
        val conversation = Conversation(ConversationKind.DEPARTURE, "chat-fixture", "Fixture")
        val compressed = Buffer()
        GzipSink(compressed).buffer().use { it.writeUtf8("x".repeat(ApiResponseBudget.CHAT_WINDOW_BYTES + 1)) }
        assertTrue(compressed.size < ApiResponseBudget.DEFAULT_BYTES)
        server.enqueue(MockResponse().setHeader("Content-Encoding", "gzip").setBody(compressed))
        val large = try { api.messages(conversation, null); null } catch (failure: ApiFailure) { failure }
        assertEquals("response_too_large", large?.code)

        val defaultOverflow = "x".repeat(ApiResponseBudget.DEFAULT_BYTES + 1)
        server.enqueue(MockResponse().setResponseCode(503).setChunkedBody(defaultOverflow, 8192))
        val error = try { api.messages(conversation, null); null } catch (failure: ApiFailure) { failure }
        assertEquals("response_too_large", error?.code)

        server.enqueue(MockResponse().setBody(defaultOverflow))
        val acknowledgement = try { api.sendMessage(conversation, "Fixture", "client-fixture"); null } catch (failure: ApiFailure) { failure }
        assertEquals("response_too_large", acknowledgement?.code)
    }

    @Test fun boundedRichCollectionsRetainAllHundredRowsThroughActualApiMethods() = runBlocking {
        val text = "\\u003c".repeat(2000)
        val review = "\\u003c".repeat(3000)
        val base = "\"id\":\"item\",\"createdAt\":\"2026-11-13T00:00:00Z\""
        data class Fixture(val path: String, val item: String, val expected: String, val read: suspend () -> List<String>)
        val fixtures = listOf(
            Fixture("/departures/fixture/reviews", """{$base,"target":"guide","rating":5,"body":"$review"}""", "<".repeat(3000)) { api.reviews("fixture").map { it.body } },
            Fixture("/recruitment-requests", """{$base,"routeId":"fixture","creatorId":"fixture-user","creatorName":"Fixture","preferredDate":null,"body":"$text","status":"open","departureId":null,"interestedCount":1}""", "<".repeat(2000)) { api.recruitment().map { it.body } },
            Fixture("/me/reports", """{$base,"targetType":"departure_message","targetId":"fixture","reason":"spam","body":"$text","status":"resolved","decisionReason":"$text"}""", "<".repeat(2000)) { api.reports().map { it.body } },
            Fixture("/me/moderation-actions", """{$base,"targetType":"departure_message","action":"hide","reason":"$text","expiresAt":null,"revokedAt":null,"appealStatus":null}""", "<".repeat(2000)) { api.moderationActions().map { it.reason } },
            Fixture("/me/appeals", """{$base,"actionId":"fixture","body":"$text","status":"open","decisionReason":"$text"}""", "<".repeat(2000)) { api.appeals().map { it.body } },
            Fixture("/me/notifications", """{$base,"kind":"moderation","title":"Fixture","body":"$text","readAt":null}""", "<".repeat(2000)) { api.notifications().map { it.body } },
        )
        for (fixture in fixtures) {
            val items = List(100) { index -> fixture.item.replace("\"id\":\"item\"", "\"id\":\"item-$index\"") }.joinToString(",")
            val body = """{"data":[$items],"meta":{"mode":"production"}}"""
            assertTrue(body.toByteArray().size > ApiResponseBudget.DEFAULT_BYTES)
            assertTrue(body.toByteArray().size < ApiResponseBudget.COLLECTION_BYTES)
            server.enqueue(MockResponse().setChunkedBody(body, 8192))
            val rows = fixture.read()
            assertEquals(100, rows.size)
            assertTrue(rows.all { it == fixture.expected })
            assertEquals("/api/v1" + fixture.path, server.takeRequest(3, TimeUnit.SECONDS)!!.path)
        }
    }

    @Test fun collectionBudgetRejectsDecodedOverflowAndNeverExtendsAnErrorMutationOrUnlistedPath() = runBlocking {
        val compressed = Buffer()
        GzipSink(compressed).buffer().use { it.writeUtf8("x".repeat(ApiResponseBudget.COLLECTION_BYTES + 1)) }
        server.enqueue(MockResponse().setHeader("Content-Encoding", "gzip").setBody(compressed))
        val large = try { api.reviews("fixture"); null } catch (failure: ApiFailure) { failure }
        assertEquals("response_too_large", large?.code)
        val overflow = "x".repeat(ApiResponseBudget.DEFAULT_BYTES + 1)
        server.enqueue(MockResponse().setResponseCode(503).setChunkedBody(overflow, 8192))
        val error = try { api.reviews("fixture"); null } catch (failure: ApiFailure) { failure }
        assertEquals("response_too_large", error?.code)
        server.enqueue(MockResponse().setBody(overflow))
        val mutation = try { api.review("fixture", "guide", 5, "Fixture"); null } catch (failure: ApiFailure) { failure }
        assertEquals("response_too_large", mutation?.code)
        for (path in listOf("/routes?limit=100", "/me/summary", "/me/reports/id", "/me/unknown", "/moderation/reports/id",
            "/departures/fixture/reviews/more", "/guides/fixture", "/departures/../reviews", "/recruitment-requests/fixture")) {
            assertEquals(path, ApiResponseBudget.DEFAULT_BYTES, ApiResponseBudget.forResponse(path, "GET", true))
        }
    }

    @Test fun fullRouteAboveOneMebibyteRetainsAllHundredThousandVertices() = runBlocking {
        val vertices = List(100_000) { "[33.123456789,63.123456789]" }.joinToString(",")
        val body = """{"data":${routeJson(vertices)},"meta":{"mode":"production"}}"""
        assertTrue(body.toByteArray().size > ApiResponseBudget.DEFAULT_BYTES)
        assertTrue(body.toByteArray().size < ApiResponseBudget.FULL_ROUTE_BYTES)
        server.enqueue(MockResponse().setChunkedBody(body, 8192))

        val route = api.route("route-fixture")
        val geometry = JSONObject(route.rawJson).getJSONObject("geometry").getJSONArray("coordinates")
        assertEquals(100_000, geometry.length())
        assertEquals(33.123456789, geometry.getJSONArray(99_999).getDouble(0), 0.0)
        val request = server.takeRequest(3, TimeUnit.SECONDS)!!
        assertEquals("/api/v1/routes/route-fixture", request.path)
        assertEquals("GET /api/v1/routes/route-fixture HTTP/1.1", request.requestLine)
        assertNull(request.getHeader("Authorization"))
    }

    @Test fun detailBudgetStillRejectsAnOversizedUnknownLengthBody() = runBlocking {
        server.enqueue(MockResponse().setChunkedBody("x".repeat(ApiResponseBudget.FULL_ROUTE_BYTES + 1), 8192))
        val error = try { api.route("route-fixture"); null } catch (failure: ApiFailure) { failure }
        assertEquals("response_too_large", error?.code)
    }

    @Test fun enlargedDetailAllowanceDoesNotApplyToErrorBodiesOrCataloguePages() = runBlocking {
        val oversized = "x".repeat(ApiResponseBudget.DEFAULT_BYTES + 1)
        server.enqueue(MockResponse().setResponseCode(503).setBody(oversized))
        val error = try { api.route("route-fixture"); null } catch (failure: ApiFailure) { failure }
        assertEquals("response_too_large", error?.code)

        server.enqueue(MockResponse().setChunkedBody(oversized, 8192))
        val pageError = try { api.routePage(); null } catch (failure: ApiFailure) { failure }
        assertEquals("response_too_large", pageError?.code)
    }

    @Test fun ordinaryResponsesRemainBoundedAfterGzipDecompression() = runBlocking {
        val compressed = Buffer()
        GzipSink(compressed).buffer().use { it.writeUtf8("x".repeat(ApiResponseBudget.DEFAULT_BYTES + 1)) }
        assertTrue(compressed.size < ApiResponseBudget.DEFAULT_BYTES)
        server.enqueue(MockResponse().setHeader("Content-Encoding", "gzip").setBody(compressed))
        val error = try { api.accountSummary(); null } catch (failure: ApiFailure) { failure }
        assertEquals("response_too_large", error?.code)
    }

    @Test fun shortRoutePageStillCarriesItsContinuation() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"data":[${routeJson()}],"meta":{"mode":"production","nextCursor":"route-fixture"}}"""))
        val page = api.routePage()
        assertEquals(1, page.routes.size)
        assertEquals("route-fixture", page.cursor)
        assertEquals("/api/v1/routes?limit=25", server.takeRequest(3, TimeUnit.SECONDS)!!.path)

        server.enqueue(MockResponse().setBody("""{"data":[],"meta":{"mode":"production"}}"""))
        val finalPage = api.routePage(page.cursor)
        assertTrue(finalPage.routes.isEmpty())
        assertNull(finalPage.cursor)
        assertEquals("route-fixture", server.takeRequest(3, TimeUnit.SECONDS)!!.requestUrl!!.queryParameter("cursor"))
    }

    @Test fun accountHistoryUsesTheSessionAndTreatsCursorOnlyAsAQueryValue() = runBlocking {
        val item = """{"id":"completed-fixture","routeId":"route-fixture","routeRevisionId":"old-reviewed-revision","routeTitle":"Fixture only","startsAt":"2026-11-05T06:00:00Z","endsAt":"2026-11-05T10:00:00Z","completedAt":"2026-11-05T10:05:00Z","timeZone":"Europe/Moscow","role":"tourist","guideId":"guide-fixture","guideName":"Fixture guide","reviewTargets":["guide"]}"""
        server.enqueue(MockResponse().setBody("""{"data":[$item],"meta":{"mode":"production","nextCursor":"older-position"}}"""))
        val cursor = "position/with?userId=another&x=y"
        val page = api.departureHistory(cursor)
        assertEquals("older-position", page.cursor)
        assertEquals("old-reviewed-revision", page.departures.single().routeRevisionId)
        assertEquals(listOf("guide"), page.departures.single().reviewTargets)
        val request = server.takeRequest(3, TimeUnit.SECONDS)!!
        assertEquals("/api/v1/me/departures", request.requestUrl!!.encodedPath)
        assertEquals(cursor, request.requestUrl!!.queryParameter("cursor"))
        assertNull(request.requestUrl!!.queryParameter("userId"))
        assertEquals("Bearer $token", request.getHeader("Authorization"))
        assertFalse(request.requestUrl.toString().contains(token))
    }
}
