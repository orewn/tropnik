package ru.tropa.app.data

import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import java.io.File

/** Ownership changes only after a completed database publication. A cancelled
 * caller must never delete a directory the database can already expose. */
internal class OfflinePackPublication(private val directory: File) {
    private var published = false

    suspend fun publish(commit: suspend () -> Unit) {
        // Only the small database write is protected; copying and verification
        // remain cancellable work outside this section.
        withContext(NonCancellable) {
            commit()
            published = true
        }
    }

    fun discardUnpublished() {
        if (!published) runCatching { directory.deleteRecursively() }
    }
}
