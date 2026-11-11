package ru.tropa.app.ui

import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** The UI revokes access immediately; even TLS socket cancellation/close is IO.
 * At most one cancellation and one final close can wait behind active work. */
internal class MapNetworkLifetime(
    private val cancelCalls: () -> Unit,
    private val releaseNetwork: () -> Unit,
) : AutoCloseable {
    private val lock = Any()
    private val online = AtomicBoolean(false)
    private val closed = AtomicBoolean(false)
    private var cancellationQueued = false
    private val io = Executors.newSingleThreadExecutor { task ->
        Thread(task, "tropnik-map-network-close").apply { isDaemon = true }
    }

    val isOnline: Boolean get() = online.get()
    val isClosed: Boolean get() = closed.get()

    fun setOnline(enabled: Boolean) {
        synchronized(lock) {
            if (closed.get()) return
            online.set(enabled)
            if (!enabled && !cancellationQueued) {
                cancellationQueued = true
                io.execute {
                    synchronized(lock) { cancellationQueued = false }
                    if (!online.get()) cancelCalls()
                }
            }
        }
    }

    override fun close() {
        synchronized(lock) {
            if (closed.getAndSet(true)) return
            online.set(false)
            io.execute {
                try { cancelCalls() } finally { releaseNetwork() }
            }
            // Drain accepted cancellation/close work without joining on UI.
            io.shutdown()
        }
    }
}
