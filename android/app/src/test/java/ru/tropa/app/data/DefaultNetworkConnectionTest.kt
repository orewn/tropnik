package ru.tropa.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DefaultNetworkConnectionTest {
    @Test fun defaultHandoverRejectsLateCallbacksFromThePreviousNetwork() {
        val connection = DefaultNetworkConnection<String>()
        assertEquals(ConnectionState.LIMITED, connection.available("wifi"))
        assertEquals(ConnectionState.ONLINE, connection.capabilities("wifi", true))
        assertEquals(ConnectionState.LIMITED, connection.available("cellular"))
        assertNull(connection.capabilities("wifi", true))
        assertNull(connection.lost("wifi"))
        assertEquals(ConnectionState.ONLINE, connection.capabilities("cellular", true))
        assertNull(connection.lost("wifi"))
        assertEquals(ConnectionState.OFFLINE, connection.lost("cellular"))
    }

    @Test fun losingTheLastValidatedNetworkCannotRetainItsOnlineState() {
        val connection = DefaultNetworkConnection<String>()
        assertNull(connection.capabilities("wifi", true))
        assertEquals(ConnectionState.LIMITED, connection.available("wifi"))
        assertEquals(ConnectionState.ONLINE, connection.capabilities("wifi", true))
        assertEquals(ConnectionState.LIMITED, connection.capabilities("wifi", false))
        assertEquals(ConnectionState.ONLINE, connection.capabilities("wifi", true))
        assertEquals(ConnectionState.OFFLINE, connection.lost("wifi"))
        assertNull(connection.capabilities("wifi", true))
        assertNull(connection.lost("wifi"))
        assertEquals(ConnectionState.LIMITED, connection.available("cellular"))
        assertEquals(ConnectionState.OFFLINE, connection.lost("cellular"))
    }
}
