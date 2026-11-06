package ru.tropa.app.data

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files

class OfflinePackPublicationTest {
    private val directories = mutableListOf<File>()
    private fun staged(): File = Files.createTempDirectory("tropnik-publication-").toFile().also {
        directories += it
        File(it, "verified-map.bin").writeText("verified local package")
    }
    @After fun clean() { directories.forEach { it.deleteRecursively() } }

    @Test fun cancellationAfterDatabaseCommitKeepsItsPublishedDirectory() = runBlocking {
        val directory = staged()
        val publication = OfflinePackPublication(directory)
        val committed = CompletableDeferred<Unit>()
        val returnFromDao = CompletableDeferred<Unit>()
        var databaseDirectory: File? = null
        val job = launch {
            try {
                publication.publish {
                    databaseDirectory = directory
                    committed.complete(Unit)
                    // A database may commit before its caller resumes.
                    returnFromDao.await()
                }
            } finally { publication.discardUnpublished() }
        }
        committed.await()
        job.cancel()
        returnFromDao.complete(Unit)
        job.join()
        assertTrue(job.isCancelled)
        assertEquals(directory, databaseDirectory)
        assertTrue(File(databaseDirectory, "verified-map.bin").isFile)
    }

    @Test fun failedDatabaseWriteRemovesOnlyUnpublishedStaging() = runBlocking {
        val previous = staged()
        val directory = staged()
        val publication = OfflinePackPublication(directory)
        var databaseDirectory = previous
        val failure = runCatching {
            try {
                publication.publish { throw IOException("Database rejected the write") }
                databaseDirectory = directory
            } finally { publication.discardUnpublished() }
        }.exceptionOrNull()
        assertTrue(failure is IOException)
        assertEquals(previous, databaseDirectory)
        assertTrue(previous.isDirectory)
        assertFalse(directory.exists())
    }

    @Test fun cleanupFailureAfterPublicationCannotDeleteTheNewPackage() = runBlocking {
        val directory = staged()
        val publication = OfflinePackPublication(directory)
        var databaseDirectory: File? = null
        val failure = runCatching {
            try {
                publication.publish { databaseDirectory = directory }
                throw IOException("Old copy cleanup failed")
            } finally { publication.discardUnpublished() }
        }.exceptionOrNull()
        assertTrue(failure is IOException)
        assertEquals(directory, databaseDirectory)
        assertTrue(File(databaseDirectory, "verified-map.bin").isFile)
    }
}
