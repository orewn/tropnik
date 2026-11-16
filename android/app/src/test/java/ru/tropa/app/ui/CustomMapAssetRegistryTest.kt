package ru.tropa.app.ui

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CustomMapAssetRegistryTest {
    private fun manifest(): String =
        File(requireNotNull(System.getProperty("tropnik.assets")), "custom-map/manifest.json").readText()

    @Test(timeout = 15_000) fun concurrentAndRepeatedViewsReadAndParseOneCompleteRegistry() {
        val source = manifest()
        val reads = AtomicInteger()
        val start = CountDownLatch(1)
        val workers = Executors.newFixedThreadPool(8)
        val registry = CustomMapAssetRegistry { reads.incrementAndGet();source }
        try {
            val results = (0 until 24).map {
                workers.submit<Map<String, MapAsset>> { start.await();registry.entries }
            }
            start.countDown()
            val first = results.first().get(10, TimeUnit.SECONDS)
            results.forEach { assertSame(first, it.get(10, TimeUnit.SECONDS)) }
            repeat(100) { assertSame(first, registry.entries) }
            assertEquals(1, reads.get())
        } finally { start.countDown();workers.shutdownNow() }
    }

    @Test fun everyBundledUrlKeepsItsExactPathSizeAndDigestWithoutExposingMutation() {
        val source = manifest()
        val manifest = JSONObject(source)
        val entries = CustomMapAssetRegistry { source }.entries
        val urls = mutableSetOf<String>()
        val files = manifest.getJSONArray("files")
        for (index in 0 until files.length()) {
            val file = files.getJSONObject(index)
            val path = "custom-map/" + file.getString("path")
            val url = "/$path"
            urls.add(url)
            assertEquals(MapAsset(path, file.getInt("sizeBytes"), file.getString("sha256")), entries[url])
        }
        val aliases = manifest.getJSONArray("resourceAliases")
        for (index in 0 until aliases.length()) {
            val alias = aliases.getJSONObject(index)
            val url = alias.getString("url")
            urls.add(url)
            assertEquals(MapAsset(alias.getString("assetPath"), alias.getInt("sizeBytes"), alias.getString("sha256")), entries[url])
        }
        urls.add("/offline-map/manifest.json")
        assertEquals(urls, entries.keys)
        assertSame(entries["/custom-map/offline-manifest.json"], entries["/offline-map/manifest.json"])
        assertThrows(UnsupportedOperationException::class.java) { (entries as MutableMap).clear() }
        assertEquals(urls, entries.keys)
    }

    @Test fun failedReadsAndInvalidRegistriesNeverPublishOrPoisonTheSuccessfulCache() {
        val source = manifest()
        val attempts = AtomicInteger()
        val registry = CustomMapAssetRegistry {
            when (attempts.incrementAndGet()) {
                1 -> throw java.io.IOException("fixture unavailable")
                2 -> "{}"
                else -> source
            }
        }
        assertThrows(java.io.IOException::class.java) { registry.entries }
        assertThrows(org.json.JSONException::class.java) { registry.entries }
        val valid = registry.entries
        assertTrue(valid.isNotEmpty())
        assertSame(valid, registry.entries)
        assertEquals(3, attempts.get())
    }

    @Test fun malformedPathsDuplicateUrlsBadSizesAndBadDigestsStillReject() {
        val source = manifest()
        val changes: List<(JSONObject) -> Unit> = listOf(
            { it.put("schemaVersion", 2) },
            { it.put("runtime", "other") },
            { it.put("origin", "https://other.invalid") },
            { it.getJSONArray("files").getJSONObject(0).put("path", "../private") },
            { it.getJSONArray("files").getJSONObject(0).put("sizeBytes", 0) },
            { it.getJSONArray("files").getJSONObject(0).put("sizeBytes", MAX_MAP_RESOURCE_BYTES + 1) },
            { it.getJSONArray("files").getJSONObject(0).put("sha256", "z".repeat(64)) },
            { it.getJSONArray("files").put(it.getJSONArray("files").getJSONObject(0)) },
            { it.getJSONArray("resourceAliases").getJSONObject(0).put("url", "/private/../asset") },
            { it.getJSONArray("resourceAliases").getJSONObject(0).put("assetPath", "../private") },
            { value ->
                val files = value.getJSONArray("files")
                for (index in files.length() - 1 downTo 0) {
                    if (files.getJSONObject(index).getString("path") == "offline-manifest.json") files.remove(index)
                }
            },
        )
        for (change in changes) {
            val invalid = JSONObject(source).also(change).toString()
            val reads = AtomicInteger()
            val registry = CustomMapAssetRegistry { reads.incrementAndGet();invalid }
            repeat(2) { assertThrows(IllegalArgumentException::class.java) { registry.entries } }
            assertEquals("A failed validation must not publish a cached value", 2, reads.get())
        }
    }

    @Test fun aDifferentApplicationOwnerGetsItsOwnValidatedAssetIdentity() {
        val source = manifest()
        val updated = JSONObject(source)
        val firstFile = updated.getJSONArray("files").getJSONObject(0)
        firstFile.put("sha256", "a".repeat(64))
        val original = CustomMapAssetRegistry { source }.entries
        val next = CustomMapAssetRegistry { updated.toString() }.entries
        val url = "/custom-map/" + firstFile.getString("path")
        assertNotSame(original, next)
        assertNotEquals(original[url]?.sha256, next[url]?.sha256)
        assertEquals("a".repeat(64), next[url]?.sha256)
        assertEquals(original.keys, next.keys)
    }
}
