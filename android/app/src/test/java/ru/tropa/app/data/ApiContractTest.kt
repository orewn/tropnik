package ru.tropa.app.data

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/** Transport/contract tests use a local TLS fixture, never a real account or service. */
class ApiContractTest {
    private lateinit var server: MockWebServer
    private lateinit var api: ApiClient
    private val token = "t".repeat(43)
    private val conversation = Conversation(ConversationKind.DEPARTURE, "departure-123", "Fixture only")

    @Before fun setup() {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val clientTls = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        server = MockWebServer().apply { useHttps(serverTls.sslSocketFactory(), false); start() }
        val client = OkHttpClient.Builder().sslSocketFactory(clientTls.sslSocketFactory(), clientTls.trustManager)
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).callTimeout(3, TimeUnit.SECONDS).build()
        api = ApiClient({ server.url("/api/v1").toString() }, { token }, client)
    }

    @After fun close() { server.shutdown() }

    @Test fun readyHealthConfirmsApiAndDatabaseWithoutSendingSessionToken() = runBlocking {
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json")
            .setBody("""{"data":{"status":"ready"},"meta":{"mode":"production"}}"""))

        assertEquals(ServerState.Reachable, api.checkHealth())
        val request = server.takeRequest(3, TimeUnit.SECONDS)!!
        assertEquals("GET", request.method)
        assertEquals("/api/v1/health/ready", request.path)
        assertNull(request.getHeader("Authorization"))
    }

    @Test fun unavailableDatabaseNeverReportsConnected() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(503)
            .setBody("""{"error":{"code":"not_ready","message":"База данных недоступна."}}"""))
        val unavailable = api.checkHealth()
        assertTrue(unavailable is ServerState.Unavailable)
        assertEquals("База данных недоступна.", (unavailable as ServerState.Unavailable).reason)

        // Even a misconfigured proxy returning a ready-looking body must not
        // override the HTTP failure from the readiness service.
        server.enqueue(MockResponse().setResponseCode(503)
            .setBody("""{"data":{"status":"ready"},"meta":{"mode":"production"}}"""))
        assertTrue(api.checkHealth() is ServerState.Unavailable)
    }

    @Test fun successfulHttpWithoutValidReadinessEnvelopeIsNotConnected() = runBlocking {
        val invalidEnvelopes = listOf(
            """{"data":{"status":"ok"},"meta":{"mode":"production"}}""", // liveness is insufficient
            """{"data":{"status":"not_ready"},"meta":{"mode":"production"}}""",
            """{"status":"ready"}""",
            """{"data":{"status":"ready"},"meta":{"mode":"preview"}}""",
            """{"data":{"status":"ready"}}""",
            """{"data":{"status":"ready"},"meta":{"mode":"production"},"error":{"code":"not_ready"}}""",
            """{"data":null,"meta":{"mode":"production"}}""",
            "{}",
            "<html>Proxy response</html>",
        )
        for (body in invalidEnvelopes) {
            server.enqueue(MockResponse().setResponseCode(200).setBody(body))
            assertTrue("Unexpected connected state for $body", api.checkHealth() is ServerState.Unavailable)
        }
        server.enqueue(MockResponse().setResponseCode(204))
        assertTrue(api.checkHealth() is ServerState.Unavailable)
        server.enqueue(MockResponse().setResponseCode(202)
            .setBody("""{"data":{"status":"ready"},"meta":{"mode":"production"}}"""))
        assertTrue(api.checkHealth() is ServerState.Unavailable)
    }

    @Test fun messageUsesBearerAndKeepsStableClientIdAcrossRetry() = runBlocking {
        val clientId = "8228b7f2-7399-4a58-9f23-b74bcfe22e2b"
        val response = JSONObject().put("data", JSONObject().put("id", "server-message-1").put("userId", "fixture-user")
            .put("displayName", "Test fixture").put("body", "A local contract test").put("clientId", clientId).put("createdAt", "2026-11-06T10:00:00Z"))
        repeat(2) { server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(response.toString())) }
        repeat(2) {
            val accepted = api.sendMessage(conversation, "A local contract test", clientId)
            assertEquals("server-message-1", accepted.id)
            val request = server.takeRequest(3, TimeUnit.SECONDS)!!
            assertEquals("/api/v1/departures/departure-123/messages", request.path)
            assertEquals("Bearer $token", request.getHeader("Authorization"))
            assertFalse(request.requestUrl.toString().contains(token))
            assertEquals(clientId, JSONObject(request.body.readUtf8()).getString("clientId"))
        }
    }

    @Test fun staleVersionIsAConflictNotASuccess() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":{"code":"version_conflict","message":"Changed on server"}}"""))
        val departure = Departure("departure-123", "route-123", "rev-1", "guide-1", "Fixture", "2026-12-01T06:00:00Z", "2026-12-01T15:00:00Z", "Europe/Moscow", 4, 8, 4, "ready", 7, true, true, "confirmed")
        val error = try { api.transition(departure, "start"); null } catch (failure: ApiFailure) { failure }
        assertEquals(409, error?.status)
        assertFalse(error!!.transient)
        val request = server.takeRequest(3, TimeUnit.SECONDS)!!
        val body = JSONObject(request.body.readUtf8())
        assertEquals(7, body.getInt("expectedVersion"))
        assertEquals("start", body.getString("action"))
    }

    @Test fun logoutAcceptsNoContentAcknowledgement() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))
        api.logout()
        assertEquals("/api/v1/auth/logout", server.takeRequest(3, TimeUnit.SECONDS)?.path)
    }

    @Test fun chatCursorRemainsAQueryValueAndCannotAlterPath() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"data":[],"meta":{"mode":"production","nextCursor":"next"}}"""))
        val cursor = "timestamp/uuid?after=secret&x=y"
        val page = api.messages(conversation, cursor)
        val request = server.takeRequest(3, TimeUnit.SECONDS)!!
        assertEquals("/api/v1/departures/departure-123/messages", request.requestUrl!!.encodedPath)
        assertEquals(cursor, request.requestUrl!!.queryParameter("cursor"))
        assertNull(request.requestUrl!!.queryParameter("after"))
        assertEquals("next", page.cursor)
    }

    @Test fun missingBearerStopsBeforeNetworkRequest() = runBlocking {
        val anonymous = ApiClient({ server.url("/api/v1").toString() }, { null })
        val error = try { anonymous.logout(); null } catch (failure: ApiFailure) { failure }
        assertEquals(401, error?.status)
        assertEquals(0, server.requestCount)
    }
}
