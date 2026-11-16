package ru.tropa.app

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Prepares the application's existing success-only lazy without blocking its caller. */
internal class CatalogStartup<T>(
    private val catalog: Lazy<T>,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    val isReady: Boolean get() = catalog.isInitialized()

    suspend fun prepare(): T {
        // A retained application already owns the complete catalogue. Do not
        // insert a loading frame or another dispatcher hop on a warm return.
        if (isReady) return catalog.value
        return withContext(ioDispatcher) { catalog.value }
    }
}
