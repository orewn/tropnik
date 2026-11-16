package ru.tropa.app

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

class CatalogStartupTest {
    private fun assertOriginalFailure(expected: Exception, actual: Exception) {
        // Coroutine debug stacktrace recovery may wrap the original exception
        // when JVM assertions are enabled, as they are in Gradle unit tests.
        assertEquals(expected.javaClass, actual.javaClass)
        assertEquals(expected.message, actual.message)
        assertTrue(generateSequence<Throwable>(actual) { it.cause }.any { it === expected })
    }

    @Test(timeout = 15_000) fun coldPreparationLeavesTheCallerFreeWhileReadingAndParsing() {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val readingThread = AtomicReference<Thread>()
        val expected = Any()
        val startup = CatalogStartup(lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
            readingThread.set(Thread.currentThread())
            started.countDown()
            check(release.await(10, TimeUnit.SECONDS))
            expected
        })
        val caller = Executors.newSingleThreadExecutor { Thread(it, "catalogue-ui-fixture") }.asCoroutineDispatcher()
        try {
            runBlocking {
                val load = async(caller) { startup.prepare() }
                assertTrue(started.await(5, TimeUnit.SECONDS))
                assertFalse("A partial catalogue must never be ready", startup.isReady)
                // The same single caller thread must run another task before
                // the deliberately blocked catalogue initializer can finish.
                val pulse = async(caller) { Thread.currentThread() }
                assertNotSame(readingThread.get(), withTimeout(5_000) { pulse.await() })
                assertFalse(load.isCompleted)
                release.countDown()
                assertSame(expected, load.await())
                assertTrue(startup.isReady)
            }
        } finally { release.countDown();caller.close() }
    }

    @Test(timeout = 15_000) fun concurrentOwnersPublishOneWholeCatalogueAndReuseItsIdentity() {
        val reads = AtomicInteger()
        val started = CountDownLatch(1)
        val callers = CountDownLatch(24)
        val release = CountDownLatch(1)
        val expected = Any()
        val startup = CatalogStartup(lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
            reads.incrementAndGet()
            started.countDown()
            check(release.await(10, TimeUnit.SECONDS))
            expected
        })
        try {
            runBlocking {
                val results = (0 until 24).map {
                    async(Dispatchers.Default) { callers.countDown();startup.prepare() }
                }
                assertTrue(started.await(5, TimeUnit.SECONDS))
                assertTrue(callers.await(5, TimeUnit.SECONDS))
                assertFalse(startup.isReady)
                release.countDown()
                results.awaitAll().forEach { assertSame(expected, it) }
                repeat(100) { assertSame(expected, startup.prepare()) }
                assertEquals(1, reads.get())
                assertTrue(startup.isReady)
            }
        } finally { release.countDown() }
    }

    @Test fun readAndValidationFailuresStayUnreadyAndCanBeRetried() = runBlocking {
        val reads = AtomicInteger()
        val expected = Any()
        val readFailure = IOException("fixture read failed")
        val parseFailure = IllegalArgumentException("fixture catalogue invalid")
        val startup = CatalogStartup(lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
            when (reads.incrementAndGet()) {
                1 -> throw readFailure
                2 -> throw parseFailure
                else -> expected
            }
        })
        assertFalse(startup.isReady)
        for (failure in listOf(readFailure, parseFailure)) {
            try { startup.prepare();fail("Failed preparation must not return a catalogue") }
            catch (actual: Exception) { assertOriginalFailure(failure, actual) }
            assertFalse("Failures must not poison the success-only cache", startup.isReady)
        }
        assertSame(expected, startup.prepare())
        assertTrue(startup.isReady)
        assertSame(expected, startup.prepare())
        assertEquals(3, reads.get())
    }

    @Test fun warmCatalogueIsImmediatelyReadyWithoutAnotherReadOrDispatcherHop() = runBlocking {
        val reads = AtomicInteger()
        val expected = Any()
        val catalog = lazy(LazyThreadSafetyMode.SYNCHRONIZED) { reads.incrementAndGet();expected }
        assertSame(expected, catalog.value)
        val rejectingDispatcher = object : CoroutineDispatcher() {
            override fun dispatch(context: CoroutineContext, block: Runnable) {
                fail("An already prepared catalogue must not be dispatched or reloaded")
            }
        }
        val startup = CatalogStartup(catalog, rejectingDispatcher)
        assertTrue(startup.isReady)
        repeat(100) { assertSame(expected, startup.prepare()) }
        assertEquals(1, reads.get())
    }

    @Test(timeout = 15_000) fun cancelledOwnerCannotPublishReadyButTheCompletedAssetRemainsReusable() {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val returnedToOwner = AtomicBoolean(false)
        val reads = AtomicInteger()
        val expected = Any()
        val startup = CatalogStartup(lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
            reads.incrementAndGet()
            started.countDown()
            check(release.await(10, TimeUnit.SECONDS))
            expected
        })
        try {
            runBlocking {
                val owner = launch(Dispatchers.Default) { startup.prepare();returnedToOwner.set(true) }
                assertTrue(started.await(5, TimeUnit.SECONDS))
                owner.cancel()
                release.countDown()
                owner.join()
                assertTrue(owner.isCancelled)
                assertFalse(returnedToOwner.get())
                assertTrue(startup.isReady)
                assertSame(expected, startup.prepare())
                assertEquals(1, reads.get())
            }
        } finally { release.countDown() }
    }

    @Test fun initializerCancellationPropagatesAndNeverBecomesCachedFailureOrSuccess() = runBlocking {
        val reads = AtomicInteger()
        val expected = Any()
        val cancellation = CancellationException("fixture cancelled")
        val startup = CatalogStartup(lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
            if (reads.incrementAndGet() == 1) throw cancellation
            expected
        })
        try { startup.prepare();fail("Cancellation must propagate") }
        catch (actual: CancellationException) { assertOriginalFailure(cancellation, actual) }
        assertFalse(startup.isReady)
        assertSame(expected, startup.prepare())
        assertTrue(startup.isReady)
        assertEquals(2, reads.get())
    }
}
