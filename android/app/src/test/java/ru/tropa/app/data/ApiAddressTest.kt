package ru.tropa.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ApiAddressTest {
    @Test fun originBecomesVersionedHttpsEndpoint() {
        assertEquals("https://example.org/api/v1", ApiAddress.normalize(" https://EXAMPLE.org/ "))
        assertEquals("https://example.org/tropnik/api/v1", ApiAddress.normalize("https://example.org/tropnik/api/v1/"))
        assertEquals("", ApiAddress.normalize("  "))
    }

    @Test fun rejectsCredentialBearingAndUnencryptedEndpoints() {
        listOf("http://example.org", "https://user:secret@example.org", "https://example.org?token=x",
            "https://example.org#secret", "https://example.org:0", "https://example.org/other").forEach { input ->
            assertThrows("Unsafe endpoint: $input", IllegalArgumentException::class.java) { ApiAddress.normalize(input) }
        }
    }

    @Test fun pathSegmentsCannotChangeEndpointOrQuery() {
        assertEquals("route-uuid_123", ApiAddress.segment("route-uuid_123"))
        listOf("../auth/logout", "x?role=guide", "https://evil.test", "", "x/y", "x%2Fy").forEach { value ->
            assertThrows(IllegalArgumentException::class.java) { ApiAddress.segment(value) }
        }
    }
}
