package ru.tropa.app.ui

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test

class MapNetworkLifetimeTest {
    @Test(timeout = 5_000) fun closeRevokesImmediatelyAndClosesSocketsOnceAwayFromTheCaller() {
        val caller = Thread.currentThread()
        val allowIo = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val thread = AtomicReference<Thread>()
        val closes = AtomicInteger()
        val lifetime = MapNetworkLifetime(
            cancelCalls = { thread.set(Thread.currentThread());allowIo.await() },
            releaseNetwork = { closes.incrementAndGet();finished.countDown() },
        )
        try {
            lifetime.setOnline(true)
            lifetime.close()
            assertTrue(lifetime.isClosed)
            assertFalse(lifetime.isOnline)
            lifetime.setOnline(true)
            lifetime.close()
            assertFalse("Late state must not revive a released broker", lifetime.isOnline)
            assertEquals("The UI must not wait for socket work", 1L, finished.count)
        } finally { allowIo.countDown();lifetime.close() }
        assertTrue(finished.await(3, TimeUnit.SECONDS))
        assertNotSame(caller, thread.get())
        assertEquals(1, closes.get())
    }

    @Test(timeout = 5_000) fun offlineCancellationAlsoRunsAwayFromTheCallingThread() {
        val caller = Thread.currentThread()
        val cancelled = CountDownLatch(1)
        val released = CountDownLatch(1)
        val thread = AtomicReference<Thread>()
        val lifetime = MapNetworkLifetime(
            cancelCalls = { thread.set(Thread.currentThread());cancelled.countDown() },
            releaseNetwork = { released.countDown() },
        )
        try {
            lifetime.setOnline(true)
            lifetime.setOnline(false)
            assertFalse(lifetime.isOnline)
            assertTrue(cancelled.await(3, TimeUnit.SECONDS))
            assertNotSame(caller, thread.get())
        } finally { lifetime.close() }
        assertTrue(released.await(3, TimeUnit.SECONDS))
    }
}
