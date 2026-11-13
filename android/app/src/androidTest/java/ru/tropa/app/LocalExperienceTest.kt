package ru.tropa.app

import android.view.View
import android.view.ViewGroup
import android.view.InputDevice
import android.view.MotionEvent
import android.view.KeyEvent
import android.view.ViewConfiguration
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.net.ConnectivityManager
import android.os.SystemClock
import android.os.ParcelFileDescriptor
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import androidx.compose.ui.test.*
import androidx.activity.compose.setContent
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.runner.RunWith
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import ru.tropa.app.data.Catalog
import ru.tropa.app.data.ConnectionState
import ru.tropa.app.data.InstalledPackEntity
import ru.tropa.app.ui.CustomMapWebView
import ru.tropa.app.ui.OnlineProfileScreen
import ru.tropa.app.ui.TropaTheme
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Uses only bundled data. Run on an emulator/device with networking disabled too. */
@RunWith(AndroidJUnit4::class)
class LocalExperienceTest {
    @get:Rule val app = createAndroidComposeRule<MainActivity>()

    @Test fun sessionTransitionsFailClosedAndDiscardLatePrivateWork() {
        fun mount(fixture: SessionFaultHarness, seed: Boolean = true) {
            if (seed) fixture.seed()
            app.runOnUiThread {
                val model = fixture.createModel()
                app.activity.setContent { TropaTheme {
                    val state by model.state.collectAsState()
                    OnlineProfileScreen(model, state) { }
                } }
            }
            app.waitUntil(10_000) {
                if (seed) fixture.model.state.value.cachedConversations.size == 1 else fixture.model.state.value.sessionTransitionPending
            }
        }
        fun awaitFailure(fixture: SessionFaultHarness) {
            app.waitUntil(10_000) { fixture.model.state.value.let { !it.busy && it.sessionTransitionPending && it.error != null } }
            val state = fixture.model.state.value
            assertNull(state.session)
            assertNull(state.conversation)
            assertTrue(state.messages.isEmpty() && state.pending.isEmpty() && state.cachedConversations.isEmpty())
            assertTrue(!state.canUseNetwork)
            assertNull(fixture.vault.bearer(fixture.origin))
            assertNull(fixture.vault.bearer(fixture.nextOrigin))
        }
        fun retry() {
            app.onNodeWithTag("profile_list").performScrollToNode(hasTestTag("retry_session_transition"))
            app.onNodeWithTag("retry_session_transition").assertIsEnabled().performClick()
        }
        fun awaitComplete(fixture: SessionFaultHarness) {
            app.waitUntil(10_000) { fixture.model.state.value.let { !it.busy && !it.sessionTransitionPending } }
            assertNull(fixture.model.state.value.error)
            assertNull(fixture.model.state.value.session)
            assertEquals(0, fixture.pendingCount())
            assertEquals(0, fixture.conversationCount())
        }
        fun close(fixture: SessionFaultHarness) {
            app.runOnUiThread { fixture.stopModel() }
            fixture.close()
        }

        val room = SessionFaultHarness(app.activity.application)
        try {
            mount(room)
            val delayedRead = SessionFaultHarness.Pause()
            room.dao.readPause = delayedRead
            var reading: Job? = null
            app.runOnUiThread { reading = room.model.openChat(room.conversation) }
            delayedRead.awaitEntered()
            room.dao.failConversations = true
            room.dao.failOutbox = true
            app.runOnUiThread { room.model.logout() }
            awaitFailure(room)
            assertEquals(1, room.conversationCount())
            assertEquals(1, room.pendingCount())
            delayedRead.resume.complete(Unit)
            runBlocking { withTimeout(10_000) { reading!!.join() } }
            assertNull("An old chat result must not restore the closed identity", room.model.state.value.conversation)
            assertTrue(room.model.state.value.messages.isEmpty())
            val marker = room.persisted.getString("pending-private-cleanup", null)!!
            assertTrue(!marker.contains(room.session.token) && !marker.contains("token"))
            app.runOnUiThread { room.stopModel() }
            room.recreateStorageFromDisk()
            mount(room, seed = false)
            assertNull(room.model.state.value.session)
            assertTrue("Restart must not enable login while the old queue remains", !room.model.state.value.canUseNetwork)
            assertTrue(runCatching { room.vault.saveSession(room.session) }.isFailure)
            assertEquals(1, room.pendingCount())
            retry()
            awaitFailure(room)
            assertEquals(0, room.conversationCount())
            assertEquals(1, room.pendingCount())
            retry()
            awaitComplete(room)
            assertNull(room.persisted.getString("pending-private-cleanup", null))
        } finally { close(room) }

        for (changeServer in listOf(true, false)) {
            val persistence = SessionFaultHarness(app.activity.application)
            try {
                mount(persistence)
                persistence.preferences.failNextCommit = true
                app.runOnUiThread {
                    if (changeServer) persistence.model.configureServer(persistence.nextOrigin) else persistence.model.logout()
                }
                awaitFailure(persistence)
                assertEquals("An uncertain in-memory preference must not become an API destination", "", persistence.vault.serverUrl())
                assertEquals(persistence.origin, persistence.persisted.getString("server", null))
                assertNotNull("The failed commit must not masquerade as persisted logout", persistence.persisted.getString("session", null))
                assertTrue(persistence.model.state.value.error!!.contains("Не удалось сохранить"))
                retry()
                awaitComplete(persistence)
                assertEquals(if (changeServer) persistence.nextOrigin else persistence.origin, persistence.vault.serverUrl())
                assertNull(persistence.persisted.getString("session", null))
            } finally { close(persistence) }
        }

        val writing = SessionFaultHarness(app.activity.application)
        try {
            mount(writing)
            var opening: Job? = null
            app.runOnUiThread { opening = writing.model.openChat(writing.conversation) }
            runBlocking { withTimeout(10_000) { opening!!.join() } }
            assertEquals(1, writing.model.state.value.messages.size)
            val delayedWrite = SessionFaultHarness.Pause()
            writing.dao.enqueuePause = delayedWrite
            var queued = false
            var sending: Job? = null
            app.runOnUiThread { sending = writing.model.sendMessage("Late local fixture") { queued = true } }
            delayedWrite.awaitEntered()
            app.runOnUiThread { writing.model.logout() }
            app.waitUntil(10_000) { writing.vault.session() == null }
            assertTrue("Cleanup waits for the already started private write", writing.model.state.value.busy)
            delayedWrite.resume.complete(Unit)
            runBlocking { withTimeout(10_000) { sending!!.join() } }
            awaitComplete(writing)
            assertTrue("A stale enqueue must not report a successful new-session action", !queued)
            val staleWrite = runBlocking(Dispatchers.IO) {
                runCatching { writing.privateStore.enqueue(writing.session, writing.conversation, "Must not return") }
            }
            assertTrue("A late write cannot repopulate erased private data", staleWrite.isFailure)
            assertEquals(0, writing.pendingCount())
            assertEquals(0, writing.conversationCount())
        } finally { close(writing) }

        val queueFailure = SessionFaultHarness(app.activity.application)
        try {
            mount(queueFailure)
            queueFailure.dao.failPendingRead = true
            app.runOnUiThread { queueFailure.connections.value = ConnectionState.ONLINE }
            app.waitUntil(10_000) { queueFailure.model.state.value.chatError != null && !queueFailure.model.state.value.busy }
            assertEquals(1, queueFailure.pendingCount())
            assertNotNull(queueFailure.model.state.value.session)
            app.runOnUiThread { queueFailure.connections.value = ConnectionState.OFFLINE; queueFailure.model.closeChat() }
            app.waitUntil(10_000) { queueFailure.model.state.value.connection == ConnectionState.OFFLINE }
            queueFailure.dao.failPendingUpdate = true
            app.runOnUiThread { queueFailure.connections.value = ConnectionState.ONLINE }
            app.waitUntil(10_000) { queueFailure.dao.pendingUpdateFailures == 1 && queueFailure.model.state.value.chatError != null }
            assertEquals(1, queueFailure.pendingCount())
            assertNotNull(queueFailure.model.state.value.session)
        } finally { close(queueFailure) }

        File(app.activity.filesDir, "qa/session-transitions.json").apply { parentFile!!.mkdirs() }.writeText(JSONObject()
            .put("roomConversationDeleteFailureHandled", true).put("roomOutboxDeleteFailureHandled", true)
            .put("serverCommitFalseHandled", true).put("logoutCommitFalseHandled", true)
            .put("lateChatReadDiscarded", true).put("lateQueueWriteErased", true)
            .put("durableCleanupSurvivesRecreation", true).put("outboxReadFailureHandled", true).put("outboxStatusFailureHandled", true)
            .put("stalePrivateWriteRejected", true).put("nativeRetryButtonVerified", true)
            .put("externalNetworkUsed", false).toString(2))
    }

    @Test fun savedRegionPackCanInstallVerifyOpenRefreshAndRemoveOffline() {
        val application = app.activity.application as TropaApplication
        val dao = application.database.dao()
        lateinit var model: MainViewModel
        app.runOnUiThread { model = ViewModelProvider(app.activity)[MainViewModel::class.java] }
        // This case exercises the native buttons with Android connectivity
        // disabled, as well as the renderer's own observed offline state.
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        for (command in listOf("svc wifi disable", "svc data disable")) {
            ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand(command)).use { it.readBytes() }
        }
        val connectivity = application.getSystemService(ConnectivityManager::class.java)
        val connectionStates = mutableListOf<String>()
        var disconnected = false
        try {
            app.waitUntil(timeoutMillis = 15_000) {
                val state = model.state.value.connection
                if (connectionStates.lastOrNull() != state.name) connectionStates.add(state.name)
                disconnected = connectivity.activeNetwork == null && state == ConnectionState.OFFLINE
                disconnected
            }
        } finally {
            File(app.activity.filesDir, "qa/saved-pack-connectivity.json").apply { parentFile!!.mkdirs() }
                .writeText(JSONObject().put("offlineVerified", disconnected)
                    .put("androidHasActiveNetwork", connectivity.activeNetwork != null)
                    .put("nativeStates", JSONArray(connectionStates)).put("nativeState", model.state.value.connection.name)
                    .toString(2))
            if (!disconnected) screenshot("saved-pack-connectivity-failed")
        }
        val regionId = "altai"
        val sourceRoute = application.catalog.referenceRoutes(regionId = regionId).first { it.geometryAsset != null }
        fun readPack() = runBlocking(Dispatchers.IO) { dao.pack(regionId) }
        fun awaitPublished(previousDirectory: String? = null): InstalledPackEntity {
            var current: InstalledPackEntity? = null
            app.waitUntil(timeoutMillis = 45_000) {
                current = readPack()
                current != null && current?.directory != previousDirectory && model.state.value.busyId == null &&
                    model.state.value.packs.any { it.directory == current?.directory }
            }
            return requireNotNull(current)
        }
        fun savedAction(tag: String) {
            app.onNodeWithTag("saved_list").performScrollToNode(hasTestTag(tag))
            app.onNodeWithTag(tag).assertIsEnabled().performClick()
        }
        fun verifyThroughButton() {
            savedAction("verify_pack_$regionId")
            app.waitUntil(timeoutMillis = 15_000) {
                app.onAllNodesWithText("Сохранённые карточки и линии доступны. Обзорная карта встроена в приложение.").fetchSemanticsNodes().isNotEmpty()
            }
            app.waitUntil(timeoutMillis = 10_000) { model.state.value.busyId == null }
        }
        fun refreshThroughButtons(previousDirectory: String): InstalledPackEntity {
            savedAction("update_pack_$regionId")
            app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("save_pack"))
            app.onNodeWithTag("save_pack").assertIsEnabled().performClick()
            return awaitPublished(previousDirectory)
        }
        assertNull("A clean device must not already have this region", readPack())
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("region_$regionId"))
        app.onNodeWithTag("region_$regionId").performClick()
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("save_pack"))
        app.onNodeWithTag("save_pack").assertIsEnabled().performClick()
        val installed = awaitPublished()
        val directory = File(installed.directory)
        val manifest = JSONObject(File(directory, "manifest.json").readText())
        assertEquals(2, manifest.getInt("schemaVersion"))
        val paths = manifest.getJSONArray("assets").let { entries ->
            (0 until entries.length()).map { entries.getJSONObject(it).getString("path") }.toSet()
        }
        assertEquals(setOf("catalog.json", "SOURCES.txt") + application.catalog.referenceRoutes(regionId = regionId).mapNotNull { it.geometryAsset }, paths)
        assertTrue("Shared renderer/tiles must not be copied into every region", paths.all { it == "catalog.json" || it == "SOURCES.txt" || it.startsWith("maps/routes/") })
        val runtimeBytes = app.activity.assets.open("custom-map/manifest.json").use { it.readBytes() }
        val runtimeDigest = MessageDigest.getInstance("SHA-256").digest(runtimeBytes).joinToString("") { "%02x".format(it) }
        assertEquals(runtimeDigest, manifest.getJSONObject("bundledRuntime").getString("sha256"))
        val geometryFile = File(directory, requireNotNull(sourceRoute.geometryAsset))
        val originalGeometry = geometryFile.readText(Charsets.UTF_8)
        app.onNodeWithTag("nav_saved").performClick()
        verifyThroughButton()
        savedAction("open_pack_$regionId")
        app.waitUntil(timeoutMillis = 15_000) { model.state.value.offlineSnapshot != null && model.state.value.busyId == null }
        app.onNodeWithTag("explore_list").performScrollToIndex(0)
        app.onNodeWithTag("saved_region_snapshot").assertIsDisplayed()
        val snapshot = requireNotNull(model.state.value.offlineSnapshot)
        assertEquals(installed.directory, snapshot.pack.directory)
        assertNotSame(application.catalog, snapshot.catalog)
        assertEquals(application.catalog.referenceRoutes(regionId = regionId).map { it.id }, snapshot.catalog.routes.map { it.id })
        assertEquals(originalGeometry, snapshot.catalog.route(sourceRoute.id)?.inlineGeometry)
        // A verified snapshot must own its bytes. Removing the on-disk source
        // now cannot make card→map fall back to an unverified mutable path.
        assertTrue(geometryFile.delete())
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("route_${sourceRoute.id}"))
        app.onNodeWithTag("route_${sourceRoute.id}").performClick()
        app.onNodeWithTag("saved_route_snapshot").assertExists()
        assertEquals(originalGeometry, model.route(sourceRoute.id)?.inlineGeometry)
        app.onNodeWithTag("route_detail").performScrollToNode(hasTestTag("route_map"))
        val map = awaitReadyMap()
        var opened = JSONObject()
        val openedDeadline = SystemClock.uptimeMillis() + 15_000
        app.waitUntil(timeoutMillis = 15_000) {
            val remaining = openedDeadline - SystemClock.uptimeMillis()
            if (remaining <= 0) return@waitUntil false
            opened = mapSnapshot(map, minOf(5_000L, remaining))
            !opened.optBoolean("online", true) && opened.optString("routeId") == sourceRoute.id && mapInputReady(opened) &&
                SystemClock.uptimeMillis() <= openedDeadline
        }
        val openedPixels = waitForRoutePixels("offline-pack-opened-snapshot", map, originalGeometry, opened, openedDeadline)
        app.onNodeWithTag("route_detail").performScrollToNode(hasTestTag("save_route"))
        app.onNodeWithTag("save_route").assertIsEnabled().performClick()
        app.waitUntil(timeoutMillis = 10_000) {
            runBlocking(Dispatchers.IO) { dao.savedRoute(sourceRoute.id) } != null && model.state.value.busyId == null
        }
        val bookmark = runBlocking(Dispatchers.IO) { dao.savedRoute(sourceRoute.id) }
        app.onNodeWithTag("go_back").performClick()
        assertEquals(installed.directory, model.state.value.offlineSnapshot?.pack?.directory)
        app.onNodeWithTag("go_back").performClick()
        app.onNodeWithTag("nav_saved").assertIsSelected()
        assertNull(model.state.value.offlineSnapshot)
        savedAction("open_pack_$regionId")
        app.waitUntil(timeoutMillis = 15_000) {
            app.onAllNodesWithText("Сохранённые данные повреждены или удалены. Нажмите «Обновить» и сохраните область заново.").fetchSemanticsNodes().isNotEmpty()
        }
        app.onNodeWithTag("saved_list").assertExists()
        assertNull(model.state.value.offlineSnapshot)
        val repaired = refreshThroughButtons(installed.directory)
        assertTrue("Successful replacement should release the old region copy", !directory.exists())
        app.onNodeWithTag("nav_saved").performClick()
        verifyThroughButton()
        // Model an APK runtime revision without damaging the saved cards.
        val revisedManifest = File(repaired.directory, "manifest.json")
        val outdated = JSONObject(revisedManifest.readText())
        outdated.getJSONObject("bundledRuntime").put("sha256", "0".repeat(64))
        revisedManifest.writeText(outdated.toString(2))
        savedAction("open_pack_$regionId")
        app.waitUntil(timeoutMillis = 15_000) {
            app.onAllNodesWithText("Приложение обновилось. Нажмите «Обновить» и сохраните данные области заново.").fetchSemanticsNodes().isNotEmpty()
        }
        assertNull(model.state.value.offlineSnapshot)
        val refreshed = refreshThroughButtons(repaired.directory)
        app.onNodeWithTag("nav_saved").performClick()
        verifyThroughButton()
        savedAction("remove_pack_$regionId")
        app.onNodeWithTag("remove_pack_confirm").assertIsEnabled().performClick()
        app.waitUntil(timeoutMillis = 10_000) { readPack() == null && model.state.value.busyId == null }
        assertTrue(!File(refreshed.directory).exists())
        assertEquals("Removing region data must keep separately saved cards", bookmark,
            runBlocking(Dispatchers.IO) { dao.savedRoute(sourceRoute.id) })
        app.onNodeWithTag("nav_explore").performClick()
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("region_$regionId"))
        app.onNodeWithTag("region_$regionId").performClick()
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("save_pack"))
        app.onNodeWithTag("save_pack").assertIsEnabled().performClick()
        val repeated = awaitPublished(refreshed.directory)
        app.onNodeWithTag("nav_saved").performClick()
        verifyThroughButton()
        savedAction("open_pack_$regionId")
        app.waitUntil(timeoutMillis = 15_000) { model.state.value.offlineSnapshot?.pack?.directory == repeated.directory }
        screenshot("offline-pack-reinstalled")
        File(app.activity.filesDir, "qa/offline-pack-lifecycle.json").apply {
            parentFile!!.mkdirs()
            writeText(JSONObject().put("regionId", regionId).put("routeId", sourceRoute.id).put("schemaVersion", 2)
                .put("runtimeSha256", runtimeDigest).put("savedAssets", JSONArray(paths.sorted()))
                .put("openedMap", opened).put("snapshotSourceBytesVerified", true)
                .put("visibleRoutePixels", openedPixels)
                .put("missingGeometryRejectedOnNextOpen", true).put("oldRuntimeRequiresUpdate", true)
                .put("bookmarkSurvivedRemoval", true).put("reinstalledAndVerified", true)
                .put("networkState", model.state.value.connection.name).toString(2))
        }
    }

    @Test fun nationalTerritoryCatalogueCanOpenSaveAndReturnToItsSourceRoute() {
        val catalogue = Catalog.load(app.activity)
        val route = catalogue.referenceRoutes().first { it.regionId.startsWith("territory-") && it.geometryAsset != null }
        val territory = requireNotNull(catalogue.region(route.regionId))
        assertTrue(territory.territory)
        readyMap()
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("catalog_territories"))
        app.onNodeWithTag("catalog_territories").performClick()
        app.onNodeWithTag("catalog_territories").assertIsSelected()
        tapRegionMarker(territory.id, "catalog-national-map")
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("route_${route.id}"))
        app.onNodeWithTag("route_${route.id}").performClick()
        app.onNodeWithTag("route_detail").assertExists()
        app.onNodeWithText(route.title).assertExists()
        screenshot("catalog-national-route")
        app.onNodeWithTag("route_detail").performScrollToNode(hasTestTag("save_route"))
        app.onNodeWithTag("save_route").assertIsEnabled().performClick()
        app.waitUntil(timeoutMillis = 10_000) {
            app.onAllNodes(hasTestTag("save_route") and hasText("Сохранено · убрать")).fetchSemanticsNodes().isNotEmpty()
        }
        app.onNodeWithTag("go_back").performClick()
        app.onNodeWithTag("explore_list").assertExists()
        app.onNodeWithTag("go_back").performClick()
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("catalog_territories"))
        app.onNodeWithTag("catalog_territories").assertIsSelected()
        screenshot("catalog-national-territories")
    }

    @Test fun browserPlannerExplainsStorageAndCanCancelWithoutLeavingTheApp() {
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("open_planner"))
        app.onNodeWithTag("open_planner").performClick()
        app.onNodeWithTag("planner_explanation").assertExists()
        app.onNodeWithText("Конструктор откроется в браузере. Для загрузки нужна сеть.").assertExists()
        app.onNodeWithText("Планы сохраняются в этом браузере. Для переноса используйте файл JSON; маршрут можно скачать в GPX.").assertExists()
        app.onNodeWithTag("planner_route").assertDoesNotExist()
        app.onNodeWithTag("planner_open_browser").assertIsEnabled()
        screenshot("planner-browser-main-dialog")
        app.onNodeWithTag("planner_cancel").performClick()
        app.onNodeWithTag("planner_explanation").assertDoesNotExist()
        app.onNodeWithTag("nav_explore").assertIsSelected()

        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("region_krasnodar"))
        app.onNodeWithTag("region_krasnodar").performClick()
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("route_kavkaz-8a"))
        app.onNodeWithTag("route_kavkaz-8a").performClick()
        app.onNodeWithTag("route_detail").performScrollToNode(hasTestTag("open_route_planner"))
        app.onNodeWithTag("open_route_planner").performClick()
        app.onNodeWithTag("planner_route").assertTextContains("Бзерпинский", substring = true)
        screenshot("planner-browser-route-dialog")
        app.onNodeWithTag("planner_cancel").performClick()
        app.onNodeWithTag("planner_explanation").assertDoesNotExist()
        app.onNodeWithTag("open_route_planner").assertIsDisplayed()
        app.onNodeWithTag("route_detail").assertExists()
    }

    @Test fun canOpenRegionAndReadOfficialRestrictionWithoutAnAccount() {
        tapRegionMarker("krasnodar")
        app.onNodeWithText("Обзор района").assertExists()
        app.onNodeWithTag("go_back").assertExists()
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("route_kavkaz-8a"))
        app.onNodeWithTag("route_kavkaz-8a").performClick()
        app.onNodeWithText("Ограничение доступа").assertExists()
        app.onNodeWithTag("route_detail").performScrollToNode(hasTestTag("save_route"))
        app.onNodeWithTag("save_route").assertIsEnabled()
    }

    private fun readyMap(): CustomMapWebView {
        app.onNodeWithTag("explore_list").performScrollToIndex(2)
        return awaitReadyMap()
    }

    private fun awaitReadyMap(): CustomMapWebView {
        fun findMap(view: View): CustomMapWebView? {
            if (view is CustomMapWebView) return view
            if (view is ViewGroup) for (index in 0 until view.childCount) findMap(view.getChildAt(index))?.let { return it }
            return null
        }
        var view: CustomMapWebView? = null
        app.waitUntil(timeoutMillis = 25_000) {
            var ready = false
            app.runOnUiThread {
                view = findMap(app.activity.window.decorView)
                ready = view?.isAttachedToWindow == true && view?.ready == true
            }
            ready && app.onAllNodes(hasText("Открываем карту России…")).fetchSemanticsNodes().isEmpty()
        }
        val map = requireNotNull(view)
        val snapshot = mapSnapshot(map)
        assertTrue("The shared map has no actual source frame", snapshot.optBoolean("ready"))
        assertEquals("tropnik-canvas", snapshot.getJSONObject("rendered").getString("engine"))
        assertTrue("The cartographic worker did not decode any tile", snapshot.getJSONObject("state").getInt("residentTiles") > 0)
        return map
    }

    @Test fun nativeCatalogueFiltersLayersAndCoastalTrackStayAvailableOffline() {
        val catalogue = Catalog.load(app.activity)
        val manifest = JSONObject(app.activity.assets.open("catalog-manifest.json").bufferedReader().use { it.readText() })
        val expectedSources = manifest.getJSONObject("trailOverlay").getInt("sourceCount")
        val map = readyMap()
        app.runOnUiThread { map.setOnline(false) }
        var full = JSONObject()
        var catalogueReady = false
        try {
            app.waitUntil(timeoutMillis = 15_000) {
                full = mapSnapshot(map)
                val overlay = full.getJSONObject("rendered").getJSONObject("catalogueOverlay")
                val loader = full.getJSONObject("catalogue").optJSONObject("loader")
                catalogueReady = !full.optBoolean("online") && overlay.optInt("sources") == expectedSources &&
                    overlay.optBoolean("currentViewportReady") && loader?.optInt("pending") == 0 && mapInputReady(full)
                catalogueReady
            }
        } finally {
            File(app.activity.filesDir, "qa/native-catalogue-readiness.json").apply { parentFile!!.mkdirs() }
                .writeText(JSONObject().put("ready", catalogueReady).put("expectedSources", expectedSources)
                    .put("snapshot", full).toString(2))
            if (!catalogueReady) screenshot("native-catalogue-readiness-failed")
        }
        assertEquals(catalogue.referenceRoutes().map { it.id }.toSet(), full.getJSONObject("catalogue").getJSONArray("visibleIds").let { ids -> (0 until ids.length()).map { ids.getString(it) }.toSet() })
        assertTrue(full.getJSONObject("rendered").getJSONObject("catalogueOverlay").getInt("preparedParts") > 0)

        // Inject a recoverable native error after the real catalogue is ready.
        // Touch the displayed controls, rather than invoking their semantics
        // actions: a later overlay must not intercept either retry or close.
        app.runOnUiThread { map.onFailure?.invoke("Линии троп не загрузились. Повторите загрузку карты.", false) }
        app.waitUntil(10_000) { app.onAllNodesWithTag("map_error_panel").fetchSemanticsNodes().isNotEmpty() }
        app.onNodeWithTag("map_retry").assertIsDisplayed().assertIsEnabled()
        app.onNodeWithTag("map_error_close").assertIsDisplayed().assertIsEnabled()
        app.onNodeWithTag("map_paths").assertDoesNotExist()
        app.onNodeWithContentDescription("Приблизить карту").assertDoesNotExist()
        app.onNodeWithContentDescription("Источники карты и рельефа").assertIsDisplayed()
        screenshot("map-recoverable-error-actions")
        app.onNodeWithTag("map_error_close").performTouchInput { click() }
        app.waitUntil(10_000) { app.onAllNodesWithTag("map_error_panel").fetchSemanticsNodes().isEmpty() }
        app.onNodeWithTag("map_paths").assertIsDisplayed()
        app.runOnUiThread { map.onFailure?.invoke("Линия маршрута не загрузилась. Повторите загрузку карты.", false) }
        app.waitUntil(10_000) { app.onAllNodesWithTag("map_retry").fetchSemanticsNodes().isNotEmpty() }
        app.onNodeWithTag("map_retry").assertIsDisplayed().assertIsEnabled().performTouchInput { click() }
        app.waitUntil(10_000) { app.onAllNodesWithTag("map_error_panel").fetchSemanticsNodes().isEmpty() }
        assertTrue("Recoverable native actions moved the map", sameMapView(full, mapSnapshot(map)))
        File(app.activity.filesDir, "qa/map-error-controls.json").apply { parentFile!!.mkdirs() }.writeText(JSONObject()
            .put("recoverableErrorInjected", true).put("closePhysicalTouchVerified", true).put("retryPhysicalTouchVerified", true)
            .put("ordinaryControlsSuppressed", true).put("attributionVisible", true).put("cameraRetained", true).toString(2))

        // Real Compose controls must reach the shared raster, preserve the
        // camera and restore the same catalogue after paths are hidden.
        app.onNodeWithTag("map_paths").assertIsSelected().performClick()
        var hidden = JSONObject()
        app.waitUntil(timeoutMillis = 10_000) {
            hidden = mapSnapshot(map)
            !hidden.getJSONObject("catalogue").getBoolean("paths") &&
                hidden.getJSONObject("rendered").getJSONObject("catalogueOverlay").getInt("preparedSources") == 0
        }
        assertTrue("Hiding trails changed the map camera", sameMapView(full, hidden))
        app.onNodeWithTag("map_paths").performClick()
        app.waitUntil(timeoutMillis = 10_000) {
            val state = mapSnapshot(map)
            state.getJSONObject("catalogue").getBoolean("paths") &&
                state.getJSONObject("rendered").getJSONObject("catalogueOverlay").getInt("sources") == expectedSources
        }

        // No external request or fake image can count as satellite success.
        // The production bridge retains a truthful local relief frame offline.
        app.runOnUiThread { map.command("mode", JSONObject().put("mode", "satellite")) }
        var offlineMode = JSONObject()
        app.waitUntil(timeoutMillis = 10_000) {
            offlineMode = mapSnapshot(map)
            offlineMode.optString("requestedMode") == "satellite" && offlineMode.getJSONObject("state").optString("mode") == "detail"
        }
        assertTrue("An offline mode selection changed the camera", sameMapView(full, offlineMode))
        assertTrue("Offline relief was falsely reported as satellite imagery", offlineMode.getJSONObject("state").optString("committedMode") != "satellite")
        app.runOnUiThread { map.command("mode", JSONObject().put("mode", "detail")) }

        val query = "Чёрный ключ"
        val expectedIds = catalogue.referenceRoutes(query).map { it.id }.toSet()
        assertTrue("The real reviewed route must be discoverable", "kolyma-black-creek" in expectedIds)
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("region_search"))
        app.onNodeWithTag("region_search").performClick().performTextReplacement(query)
        app.waitForIdle()
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        app.onNodeWithTag("explore_list").performScrollToIndex(2)
        var filtered = JSONObject()
        app.waitUntil(timeoutMillis = 10_000) {
            filtered = mapSnapshot(map)
            filtered.getJSONObject("catalogue").getJSONArray("visibleIds").let { ids ->
                (0 until ids.length()).map { ids.getString(it) }.toSet() == expectedIds
            }
        }
        assertEquals("Searching must not refit the country camera", full.getJSONObject("camera").toString(), filtered.getJSONObject("camera").toString())
        val sourceRoute = requireNotNull(catalogue.route("kolyma-black-creek"))
        val sourceGeometry = app.activity.assets.open(requireNotNull(sourceRoute.geometryAsset)).bufferedReader(Charsets.UTF_8).use { it.readText() }
        val source = JSONObject(sourceGeometry)
        val originalLine = source.getJSONArray("features").getJSONObject(0).getJSONObject("geometry").getJSONArray("coordinates").getJSONArray(0)
        val point = originalLine.getJSONArray(originalLine.length() / 2)
        // Only the camera is set up by the test. Selection must come from a
        // trusted native touch on the same actually painted source geometry.
        app.runOnUiThread { map.command("camera", JSONObject().put("camera", JSONObject().put("center", point).put("zoom", 13)).put("animate", false)) }
        var hit = JSONObject()
        app.waitUntil(timeoutMillis = 15_000) {
            hit = mapSnapshot(map)
            hit.optString("centerTrailHit") == sourceRoute.id && mapInputReady(hit) &&
                hit.getJSONObject("rendered").getJSONObject("reviewedCoastal").optInt("overlaySources") > 0
        }
        val touch = tapMapTrail(map, hit, sourceRoute.id)
        app.onNodeWithTag("route_detail").assertExists()
        app.onNodeWithTag("route_detail").performScrollToNode(hasTestTag("route_map"))
        val selectedMap = awaitReadyMap()
        app.runOnUiThread { selectedMap.setOnline(false) }
        var selected = JSONObject()
        app.waitUntil(timeoutMillis = 15_000) {
            selected = mapSnapshot(selectedMap)
            selected.optString("routeId") == "kolyma-black-creek" &&
                selected.getJSONObject("rendered").getJSONObject("reviewedCoastal").optBoolean("selected") && mapInputReady(selected)
        }
        // Terminate the actual WebView renderer after moving away from the
        // automatic route fit. Native recovery must retain that chosen view,
        // then reload the exact selected source into the replacement renderer.
        val movedCamera = JSONObject(selected.getJSONObject("camera").toString()).put("zoom", 13.25).put("bearingDegrees", 12.0)
        app.runOnUiThread { selectedMap.command("camera", JSONObject().put("camera", movedCamera).put("animate", false)) }
        var beforeRecovery = JSONObject()
        app.waitUntil(timeoutMillis = 10_000) {
            beforeRecovery = mapSnapshot(selectedMap)
            mapInputReady(beforeRecovery) && beforeRecovery.getJSONObject("camera").optDouble("zoom") == 13.25 &&
                beforeRecovery.getJSONObject("camera").optDouble("bearingDegrees") == 12.0
        }
        app.runOnUiThread {
            check(android.os.Build.VERSION.SDK_INT >= 29) { "Renderer recovery requires the API 35 device gate" }
            assertTrue("The actual WebView renderer could not be terminated", selectedMap.webViewRenderProcess?.terminate() == true)
        }
        app.waitUntil(timeoutMillis = 10_000) { app.onAllNodesWithText("Открыть карту снова").fetchSemanticsNodes().isNotEmpty() }
        app.onNodeWithTag("map_reopen").assertIsDisplayed().assertIsEnabled()
        app.onNodeWithTag("map_paths").assertDoesNotExist()
        screenshot("map-renderer-error-actions")
        app.onNodeWithTag("map_reopen").performTouchInput { click() }
        val recoveredMap = awaitReadyMap()
        assertTrue("Recovery reused the terminated WebView", recoveredMap !== selectedMap)
        app.runOnUiThread { recoveredMap.setOnline(false) }
        var recovered = JSONObject()
        val recoveryDeadline = SystemClock.uptimeMillis() + 15_000
        app.waitUntil(timeoutMillis = 15_000) {
            val remaining = recoveryDeadline - SystemClock.uptimeMillis()
            if (remaining <= 0) return@waitUntil false
            recovered = mapSnapshot(recoveredMap, minOf(5_000L, remaining))
            mapInputReady(recovered) && sameMapView(beforeRecovery, recovered) &&
                recovered.optString("routeId") == "kolyma-black-creek" &&
                recovered.getJSONObject("rendered").getJSONObject("reviewedCoastal").optBoolean("selected") &&
                SystemClock.uptimeMillis() <= recoveryDeadline
        }
        val recoveredPixels = waitForRoutePixels("map-native-catalogue-coastal", recoveredMap, sourceGeometry, recovered, recoveryDeadline)
        val report = File(app.activity.filesDir, "qa/map-native-catalogue-coastal.json")
        report.parentFile!!.mkdirs()
        report.writeText(JSONObject().put("expectedSources", expectedSources).put("full", full).put("hidden", hidden)
            .put("offlineMode", offlineMode).put("filtered", filtered).put("hit", hit).put("touch", touch).put("selected", selected)
            .put("beforeRendererRecovery", beforeRecovery).put("afterRendererRecovery", recovered).put("rendererRecoveryVerified", true)
            .put("visibleRoutePixels", recoveredPixels)
            .put("onlineSatelliteDeviceVerified", false).toString(2))
    }

    private fun tapMapTrail(map: CustomMapWebView, snapshot: JSONObject, routeId: String): JSONObject {
        val deadline = SystemClock.uptimeMillis() + 10_000
        val receipt = JSONObject().put("routeId", routeId)
        awaitMapDraw(map, deadline, receipt)
        val snapshotBudget = deadline - SystemClock.uptimeMillis()
        assertTrue("No time remains for the completed trail frame", snapshotBudget > 0)
        val current = mapSnapshot(map, minOf(5_000L, snapshotBudget))
        assertTrue("Trail hit coordinates must belong to the completed frame", mapInputReady(current) && sameMapView(snapshot, current))
        assertEquals(routeId, current.getString("centerTrailHit"))
        val viewport = nativeMapViewport(map)
        val x = viewport.x + viewport.width / 2f
        val y = viewport.y + viewport.height / 2f
        assertTrue("Trail target is outside the visible native map", viewport.visible.contains(x.toInt(), y.toInt()))
        receipt.put("coordinateSnapshot", current).put("screenX", x.toDouble()).put("screenY", y.toDouble())
        val lastInput = current.getJSONArray("trustedInput").let { values -> (0 until values.length()).maxOfOrNull { values.getJSONObject(it).optLong("sequence") } ?: 0L }
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val downTime = SystemClock.uptimeMillis()
        var upTime = downTime
        for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
            if (action == MotionEvent.ACTION_UP) {
                val remaining = downTime + 80 - SystemClock.uptimeMillis()
                if (remaining > 0) SystemClock.sleep(remaining)
            }
            val eventTime = SystemClock.uptimeMillis()
            if (action == MotionEvent.ACTION_UP) upTime = eventTime
            val event = MotionEvent.obtain(downTime, eventTime, action, x, y, 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            try { assertTrue("Native trail touch was rejected", automation.injectInputEvent(event, false)) }
            finally { event.recycle() }
        }
        assertTrue("Trail tap became a long press", upTime - downTime < ViewConfiguration.getLongPressTimeout())
        assertTrue("Trail touch exceeded its original deadline", upTime < deadline)
        val clickBudget = deadline - SystemClock.uptimeMillis()
        assertTrue("No time remains for the trusted trail click", clickBudget > 0)
        app.waitUntil(timeoutMillis = clickBudget) {
            var diagnostics = JSONObject()
            app.runOnUiThread { diagnostics = map.debugDiagnostics() }
            val events = diagnostics.getJSONArray("receipts")
            val clicks = (0 until events.length()).map { events.getJSONObject(it) }.filter {
                it.optString("phase") == "trusted-input" && it.optString("type") == "click" &&
                    it.optBoolean("trusted") && it.optLong("sequence") > lastInput && it.optLong("nativeReceivedAt") >= downTime
            }
            receipt.put("trustedClicks", JSONArray(clicks)).put("nativeTouchEvents", diagnostics.getJSONArray("nativeTouchEvents"))
            clicks.isNotEmpty()
        }
        return receipt.put("actualPressMs", upTime - downTime)
    }

    private fun mapSnapshot(view: CustomMapWebView, timeoutMillis: Long = 5_000): JSONObject {
        require(timeoutMillis in 1L..5_000L)
        var requestId = 0L
        app.runOnUiThread {requestId = view.requestDebugSnapshot()}
        var value: JSONObject? = null
        var completed = false
        try {
            app.waitUntil(timeoutMillis = timeoutMillis) {
                app.runOnUiThread {value = view.debugSnapshot}
                value?.optLong("requestId") == requestId
            }
            completed = true
        } finally {
            if (!completed) {
                var diagnostics = JSONObject()
                app.runOnUiThread {diagnostics = view.debugDiagnostics()}
                val report = File(app.activity.filesDir, "qa/map-snapshot-timeout.json")
                report.parentFile!!.mkdirs();report.writeText(diagnostics.toString(2))
            }
        }
        return requireNotNull(value)
    }

    private fun tapRegionMarker(regionId: String, screenshotPrefix: String = "map-region") {
        val region = Catalog.load(app.activity).regions.single { it.id == regionId }
        val map = readyMap()
        // Test setup changes only the viewport. The native callback must still
        // come from a real trusted touch on the rendered shared marker button.
        app.runOnUiThread {
            map.command("camera", JSONObject().put("camera", JSONObject().put("center", JSONArray(listOf(region.longitude, region.latitude))).put("zoom", 6)).put("animate", false))
        }
        var marker: JSONObject? = null
        var snapshot = JSONObject()
        val startedAt = SystemClock.uptimeMillis()
        val deadline = startedAt + 15_000
        val groupTaps = JSONArray()
        var finalTap = JSONObject()
        var lastGroupTap = ""
        var prepared = false
        try {
            app.waitUntil(timeoutMillis = 15_000) {
                val remaining = deadline - SystemClock.uptimeMillis()
                if (remaining <= 0) return@waitUntil false
                snapshot = mapSnapshot(map, minOf(5_000L, remaining))
                if (SystemClock.uptimeMillis() > deadline || !mapInputReady(snapshot)) return@waitUntil false
                val zoom = snapshot.getJSONObject("camera").getDouble("zoom")
                if (zoom < 5.99) return@waitUntil false
                val markers = snapshot.getJSONArray("markers")
                val visible = (0 until markers.length()).map {markers.getJSONObject(it)}.filter { !it.optBoolean("hidden") }
                fun members(value: JSONObject) = value.optString("groupKey", value.getString("id")).split('|')
                marker = visible.firstOrNull {it.optString("id") == regionId && members(it).size == 1}
                if (marker == null) {
                    val group = visible.firstOrNull {regionId in members(it) && members(it).size > 1}
                    if (group != null) {
                        val key = group.getString("groupKey") + "@" + kotlin.math.round(zoom * 100)
                        if (key != lastGroupTap) {
                            val tap = JSONObject().put("groupKey", group.getString("groupKey")).put("zoom", zoom)
                                .put("x", group.getDouble("x")).put("y", group.getDouble("y")).put("elapsedMs", SystemClock.uptimeMillis() - startedAt)
                            groupTaps.put(tap)
                            if (tapMapMarker(map, group, snapshot, deadline, tap)) lastGroupTap = key
                        }
                    }
                }
                if (marker == null || SystemClock.uptimeMillis() > deadline) return@waitUntil false
                screenshot("$screenshotPrefix-before-tap")
                finalTap = JSONObject()
                tapMapMarker(map, requireNotNull(marker), snapshot, deadline, finalTap)
            }
            prepared = true
        } finally {
            var diagnostics = JSONObject()
            app.runOnUiThread { diagnostics = map.debugDiagnostics() }
            val report = File(app.activity.filesDir, "qa/$screenshotPrefix-selection.json")
            report.parentFile!!.mkdirs()
            report.writeText(JSONObject().put("target", regionId).put("prepared", prepared).put("deadlineMs", 15_000)
                .put("elapsedMs", SystemClock.uptimeMillis() - startedAt).put("trustedGroupTaps", groupTaps).put("finalTap", finalTap)
                .put("snapshot", snapshot).put("diagnostics", diagnostics).toString(2))
            if (!prepared || !finalTap.optBoolean("trustedClick")) screenshot("$screenshotPrefix-selection-failed")
        }
        app.waitUntil(timeoutMillis = 10_000) {app.onAllNodes(hasText("Обзор района")).fetchSemanticsNodes().isNotEmpty()}
        app.onNodeWithTag("explore_list").performScrollToIndex(0)
        app.onNodeWithText(region.name).assertExists()
        screenshot("$screenshotPrefix-after-tap")
    }

    private fun sameMapView(first: JSONObject, second: JSONObject): Boolean {
        val a = first.optJSONObject("camera") ?: return false
        val b = second.optJSONObject("camera") ?: return false
        val ac = a.optJSONArray("center") ?: return false
        val bc = b.optJSONArray("center") ?: return false
        val sizeA = first.optJSONObject("size") ?: return false
        val sizeB = second.optJSONObject("size") ?: return false
        return ac.length() == 2 && bc.length() == 2 && ac.optDouble(0) == bc.optDouble(0) && ac.optDouble(1) == bc.optDouble(1) &&
            a.optDouble("zoom") == b.optDouble("zoom") && a.optDouble("bearingDegrees", 0.0) == b.optDouble("bearingDegrees", 0.0) &&
            first.optDouble("pitch") == second.optDouble("pitch") &&
            sizeA.optDouble("width") == sizeB.optDouble("width") && sizeA.optDouble("height") == sizeB.optDouble("height")
    }

    private fun mapInputReady(snapshot: JSONObject): Boolean {
        val painted = snapshot.optJSONObject("painted") ?: return false
        val size = snapshot.optJSONObject("size") ?: return false
        val viewport = snapshot.optJSONObject("viewportSize") ?: return false
        val bounds = snapshot.optJSONObject("viewportBounds") ?: return false
        return snapshot.optBoolean("inputReady") && snapshot.optBoolean("ready") && !snapshot.optBoolean("moving") &&
            painted.optLong("frame") > 0 && painted.optLong("frame") == snapshot.optLong("frame") && sameMapView(snapshot, painted) &&
            size.optDouble("width") == viewport.optDouble("width") && size.optDouble("height") == viewport.optDouble("height") &&
            bounds.optDouble("width") > 0 && bounds.optDouble("height") > 0
    }

    private data class MapViewport(val x: Int, val y: Int, val width: Int, val height: Int, val visible: Rect)

    private fun nativeMapViewport(map: CustomMapWebView): MapViewport {
        var value: MapViewport? = null
        app.runOnUiThread {
            val location = IntArray(2);val visible = Rect()
            map.getLocationOnScreen(location)
            assertTrue("Map must be visible for touch injection", map.isAttachedToWindow && map.getGlobalVisibleRect(visible))
            value = MapViewport(location[0], location[1], map.width, map.height, visible)
        }
        return requireNotNull(value)
    }

    private fun awaitMapDraw(map: CustomMapWebView, deadline: Long, receipt: JSONObject) {
        val visual = CountDownLatch(1)
        var active = true
        var visualAt = 0L
        var drawnAt = 0L
        var countAtVisual = -1L
        val startedAt = SystemClock.uptimeMillis()
        app.runOnUiThread {
            map.postVisualStateCallback(startedAt, object : WebView.VisualStateCallback() {
                override fun onComplete(requestId: Long) {
                    if (!active) return
                    visualAt = SystemClock.uptimeMillis()
                    countAtVisual = map.debugDrawCount
                    map.invalidate()
                    visual.countDown()
                }
            })
        }
        try {
            val remaining = deadline - SystemClock.uptimeMillis()
            assertTrue("The current map DOM did not reach the compositor before the original map deadline", remaining > 0 && visual.await(remaining, TimeUnit.MILLISECONDS))
            val drawRemaining = deadline - SystemClock.uptimeMillis()
            assertTrue("No time remains for the current map frame", drawRemaining > 0)
            app.waitUntil(timeoutMillis = drawRemaining) {
                var drawn = false
                app.runOnUiThread {
                    drawn = map.debugDrawCount > countAtVisual
                    if (drawn) drawnAt = map.debugLastDrawAt
                }
                drawn && SystemClock.uptimeMillis() <= deadline
            }
        } finally {
            app.runOnUiThread {
                active = false
                receipt.put("visualState", JSONObject().put("requestedAt", startedAt).put("callbackAt", visualAt).put("drawnAt", drawnAt).put("countAtCallback", countAtVisual))
            }
        }
    }

    private fun waitForRoutePixels(name: String, map: CustomMapWebView, source: String, expected: JSONObject, deadline: Long): JSONObject {
        val receipt = JSONObject().put("routeId", expected.getString("routeId")).put("deadlineMs", 15_000)
        val probe = RoutePixelProbe(source)
        var pixels = JSONObject().put("passed", false).put("reason", "No screenshot captured")
        var current = JSONObject()
        var bitmap: Bitmap? = null
        var passed = false
        var failure: Throwable? = null
        try {
            // JS onFrame/ready is only submission. The already existing native
            // barrier also requires Android to draw that submitted WebView.
            awaitMapDraw(map, deadline, receipt)
            val snapshotBudget = deadline - SystemClock.uptimeMillis()
            assertTrue("No time remains to confirm the route frame", snapshotBudget > 0)
            current = mapSnapshot(map, minOf(5_000L, snapshotBudget))
            assertTrue("Route pixels must belong to the same completed camera", mapInputReady(current) && sameMapView(expected, current))
            assertEquals(expected.getString("routeId"), current.getString("routeId"))
            val viewport = nativeMapViewport(map)
            val density = app.activity.resources.displayMetrics.density
            val screenshotBudget = deadline - SystemClock.uptimeMillis()
            assertTrue("No time remains for visible route pixels", screenshotBudget > 0)
            app.waitUntil(timeoutMillis = screenshotBudget) {
                assertEquals("A scrolled/resized native viewport cannot reuse route sample coordinates", viewport, nativeMapViewport(map))
                bitmap?.recycle()
                bitmap = null
                bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
                pixels = bitmap?.let { image -> probe.inspect(image, current,
                    Rect(viewport.x, viewport.y, viewport.x + viewport.width, viewport.y + viewport.height), viewport.visible, density) }
                    ?: JSONObject().put("passed", false).put("reason", "Screenshot unavailable")
                passed = pixels.optBoolean("passed") && SystemClock.uptimeMillis() <= deadline
                passed
            }
        } catch (error: AssertionError) { failure = error }
        catch (error: Exception) { failure = error }
        finally {
            receipt.put("passed", passed).put("elapsedMs", SystemClock.uptimeMillis() - (deadline - 15_000))
                .put("snapshot", current).put("pixels", pixels).put("failure", failure?.toString()?.take(1024) ?: JSONObject.NULL)
            // Diagnostic readback may explain a failed compositor/paint, but
            // it can never replace the real on-screen pixel acceptance above.
            if (!passed) receipt.put("canvasDiagnostic", try { routeCanvasDiagnostic(map, pixels) }
                catch (error: Exception) { error.toString().take(1024) })
            val report = File(app.activity.filesDir, "qa/$name-route-pixels.json")
            report.parentFile!!.mkdirs()
            report.writeText(receipt.toString(2))
            bitmap?.let { image ->
                File(app.activity.filesDir, "qa/$name.png").outputStream().use { output ->
                    assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, output))
                }
                image.recycle()
            }
        }
        if (!passed) throw AssertionError("The exact source route has no verified visible line: $pixels", failure)
        return receipt
    }

    private fun routeCanvasDiagnostic(map: CustomMapWebView, pixels: JSONObject): Any {
        val done = CountDownLatch(1)
        var result: Any = "Canvas readback unavailable"
        val samples = pixels.optJSONArray("samples") ?: JSONArray()
        val coordinates = JSONArray((0 until minOf(128, samples.length())).map { index ->
            val point = samples.getJSONObject(index)
            JSONArray(listOf(point.getDouble("cssX"), point.getDouble("cssY")))
        })
        app.runOnUiThread {
            map.evaluateJavascript("""
                (function(){try{
                  var c=document.querySelector('.tropnik-map-canvas');if(!c)return JSON.stringify({error:'Canvas missing'});
                  var ctx=c.getContext('2d'),r=c.getBoundingClientRect(),m=ctx.getTransform(),points=$coordinates;
                  var sx=c.width/r.width,sy=c.height/r.height,hits=points.map(function(p){
                    var x=Math.max(0,Math.floor((p[0]-r.x-2)*sx)),y=Math.max(0,Math.floor((p[1]-r.y-2)*sy));
                    var w=Math.min(c.width-x,Math.ceil(4*sx)+1),h=Math.min(c.height-y,Math.ceil(4*sy)+1),hit=false;
                    if(w>0&&h>0){var data=ctx.getImageData(x,y,w,h).data;for(var i=0;i<data.length;i+=4)
                      if(data[i+3]>=240&&Math.abs(data[i]-36)<=18&&Math.abs(data[i+1]-77)<=18&&Math.abs(data[i+2]-60)<=18){hit=true;break;}}
                    return hit;});
                  return JSON.stringify({width:c.width,height:c.height,rect:{x:r.x,y:r.y,width:r.width,height:r.height},
                    alpha:ctx.globalAlpha,composite:ctx.globalCompositeOperation,transform:{a:m.a,b:m.b,c:m.c,d:m.d,e:m.e,f:m.f},
                    sampleCount:points.length,matchedSamples:hits.filter(Boolean).length,matches:hits});
                }catch(error){return JSON.stringify({error:String(error).slice(0,512)});}})()
            """.trimIndent()) { raw ->
                result = runCatching { JSONObject(JSONTokener(raw).nextValue() as String) }.getOrElse { raw.take(1024) }
                done.countDown()
            }
        }
        done.await(2, TimeUnit.SECONDS)
        return result
    }

    private fun tapMapMarker(map: CustomMapWebView, marker: JSONObject, snapshot: JSONObject, deadline: Long, receipt: JSONObject): Boolean {
        assertTrue("Marker coordinates must belong to the actually drawn camera", mapInputReady(snapshot))
        val initialViewport = nativeMapViewport(map)
        // Confirm that the already coherent frame reached the compositor, then
        // remeasure. A resize or a new camera never reuses old touch coordinates.
        awaitMapDraw(map, deadline, receipt)
        val remainingSnapshot = deadline - SystemClock.uptimeMillis()
        assertTrue("No time remains to confirm map coordinates", remainingSnapshot > 0)
        val current = mapSnapshot(map, minOf(5_000L, remainingSnapshot))
        val viewport = nativeMapViewport(map)
        val markers = current.getJSONArray("markers")
        val target = (0 until markers.length()).map {markers.getJSONObject(it)}.firstOrNull {it.optString("id") == marker.getString("id")}
        val sameMarker = target != null && !target.optBoolean("hidden") && target.optString("groupKey") == marker.optString("groupKey") &&
            listOf("x", "y", "width", "height").all {kotlin.math.abs(target.optDouble(it) - marker.optDouble(it)) < .01}
        receipt.put("coordinateSnapshot", JSONObject().put("requestId", current.getLong("requestId")).put("frame", current.getInt("frame"))
            .put("painted", current.optJSONObject("painted")).put("viewportBounds", current.optJSONObject("viewportBounds")).put("marker", target))
        val initialBounds = snapshot.getJSONObject("viewportBounds")
        val currentBounds = current.getJSONObject("viewportBounds")
        val sameBounds = listOf("x", "y", "width", "height").all {initialBounds.getDouble(it) == currentBounds.getDouble(it)}
        if (!mapInputReady(current) || !sameMapView(snapshot, current) || !sameMarker || !sameBounds || viewport != initialViewport) {
            receipt.put("retryReason", "Drawn camera, marker or native viewport changed before touch")
            return false
        }
        val button = requireNotNull(target)
        val previousInput = current.optJSONArray("trustedInput") ?: JSONArray()
        val lastInputSequence = (0 until previousInput.length()).maxOfOrNull {previousInput.getJSONObject(it).optLong("sequence")} ?: 0L
        receipt.put("markerId", button.getString("id")).put("snapshotRequest", current.getLong("requestId"))
            .put("snapshotFrame", current.getInt("frame")).put("hitAtMarker", button.optJSONObject("hitAtMarker")).put("afterInputSequence", lastInputSequence)
        assertEquals("A visible marker must also be the actual DOM hit target", button.getString("id"), button.getJSONObject("hitAtMarker").getString("markerId"))
        // DOMRect retains subpixel layout at nonintegral Android density;
        // engine.clientWidth intentionally rounds it for the canvas size.
        val scaleX = viewport.width / currentBounds.getDouble("width").toFloat()
        val scaleY = viewport.height / currentBounds.getDouble("height").toFloat()
        val x = viewport.x + button.getDouble("x").toFloat() * scaleX
        val y = viewport.y + button.getDouble("y").toFloat() * scaleY
        receipt.put("screenX", x.toDouble()).put("screenY", y.toDouble()).put("scaleX", scaleX.toDouble()).put("scaleY", scaleY.toDouble())
            .put("viewLocation", JSONArray(listOf(viewport.x, viewport.y))).put("nativeSize", JSONArray(listOf(viewport.width, viewport.height)))
            .put("globalVisible", JSONArray(listOf(viewport.visible.left, viewport.visible.top, viewport.visible.right, viewport.visible.bottom)))
        assertTrue("Rendered marker must be on screen", viewport.visible.contains(x.toInt(), y.toInt()))
        if (nativeMapViewport(map) != viewport) {receipt.put("retryReason", "Native viewport moved before touch");return false}
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val downTime = SystemClock.uptimeMillis()
        val requestedReleaseAt = downTime + 80
        val dispatched = JSONArray()
        receipt.put("nativeInput", dispatched).put("requestedReleaseAt", requestedReleaseAt)
        var upTime = 0L
        for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
            if (action == MotionEvent.ACTION_UP) {
                val remainingHoldMs = requestedReleaseAt - SystemClock.uptimeMillis()
                if (remainingHoldMs > 0) SystemClock.sleep(remainingHoldMs)
            }
            val eventTime = SystemClock.uptimeMillis()
            if (action == MotionEvent.ACTION_DOWN) assertTrue("No time remains for the real touch", eventTime <= deadline)
            else upTime = eventTime
            val event = MotionEvent.obtain(downTime, eventTime, action, x, y, 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            try {
                // The public API may still sync transactions before DOWN.
                // Keep actual timestamps and check the resulting duration;
                // never backdate UP or leave DOWN held when a deadline expires.
                val accepted = automation.injectInputEvent(event, false)
                dispatched.put(JSONObject().put("action", action).put("downTime", downTime).put("eventTime", eventTime)
                    .put("returnedAt", SystemClock.uptimeMillis()).put("accepted", accepted))
                assertTrue("Map touch injection failed", accepted)
            }
            finally { event.recycle() }
        }
        val longPressMs = ViewConfiguration.getLongPressTimeout().toLong()
        receipt.put("actualPressMs", upTime - downTime).put("longPressThresholdMs", longPressMs)
            .put("upDispatchDelayMs", (upTime - requestedReleaseAt).coerceAtLeast(0L))
        assertTrue("The actual native gesture became a long press instead of a tap", upTime - downTime < longPressMs)
        assertTrue("The real touch exceeded the original selection deadline", upTime <= deadline)
        val remaining = deadline - SystemClock.uptimeMillis()
        assertTrue("No time remains for the trusted map click", remaining > 0)
        app.waitUntil(timeoutMillis = remaining) {
            var diagnostics = JSONObject()
            app.runOnUiThread { diagnostics = map.debugDiagnostics() }
            val events = diagnostics.getJSONArray("receipts")
            val recent = (0 until events.length()).map {events.getJSONObject(it)}.filter {
                it.optString("phase") == "trusted-input" && it.optLong("sequence") > lastInputSequence && it.optLong("nativeReceivedAt") >= downTime
            }
            receipt.put("domInput", JSONArray(recent)).put("nativeTouchEvents", diagnostics.getJSONArray("nativeTouchEvents"))
            val clicked = recent.any {it.optString("type") == "click" && it.optBoolean("trusted") && it.optJSONObject("target")?.optString("markerId") == button.getString("id")}
            receipt.put("trustedClick", clicked)
            clicked && SystemClock.uptimeMillis() <= deadline
        }
        return true
    }

    @Test fun nativeLabelsRemainWholeAboveTheMaskAndRejectForeignAnchorsOffline() {
        val map = readyMap()
        app.runOnUiThread {map.setOnline(false);map.command("labelFixture")}
        var snapshot = JSONObject()
        var labelsReady = false
        try {
            // Prepare actual geometry and wait for the submitted fixture frame
            // before starting the separate bounded diagnostic round trip.
            app.waitUntil(timeoutMillis = 20_000) {
                var ready = false
                app.runOnUiThread {ready = map.debugFixtureState?.optString("status") == "ready"}
                ready
            }
            snapshot = mapSnapshot(map)
            assertEquals("ready", snapshot.getJSONObject("labelFixture").getString("status"))
            assertTrue("The exact fixture coverage did not settle", snapshot.getJSONObject("coverage").getBoolean("ready"))
            labelsReady = true
        } finally {
            if (!labelsReady) {
                runCatching {screenshot("map-labels-not-ready")}
                var diagnostics = JSONObject()
                app.runOnUiThread {diagnostics = map.debugDiagnostics()}
                val report = File(app.activity.filesDir, "qa/map-labels-not-ready.json")
                report.parentFile!!.mkdirs();report.writeText(JSONObject().put("snapshot", snapshot).put("diagnostics", diagnostics).toString(2))
            }
        }
        val labels = snapshot.getJSONArray("labels")
        val annotations = (0 until labels.length()).map {labels.getJSONObject(it)}.filter {it.optString("id") in setOf("domestic", "foreign")}
        assertEquals("Both source labels must be retained before admission", setOf("ПРИМОРСК", "ЗАРУБЕЖНЫЙ"), annotations.map {it.getString("label")}.toSet())
        val domestic = annotations.single {it.getString("id") == "domestic"}
        val foreign = annotations.single {it.getString("id") == "foreign"}
        assertEquals("drawn", domestic.getString("reason"))
        assertTrue(domestic.getBoolean("visible"))
        assertEquals("outside-coverage", foreign.getString("reason"))
        assertTrue(!foreign.getBoolean("visible"))
        val boundary = snapshot.getJSONObject("labelFixture").getJSONObject("point")
        assertTrue("The domestic whole-label rectangle must cross the real mask", domestic.getJSONObject("rect").getDouble("right") > boundary.getDouble("x") + 8)
        val probes = snapshot.getJSONArray("outsideLabelProbes")
        assertTrue("No actual outside-mask pixels were sampled", probes.length() > 40)
        val location = IntArray(2);var scaleX = 0.0;var scaleY = 0.0
        app.runOnUiThread {
            map.getLocationOnScreen(location)
            scaleX = map.width / snapshot.getJSONObject("size").getDouble("width")
            scaleY = map.height / snapshot.getJSONObject("size").getDouble("height")
        }
        screenshot("map-labels-cross-mask")
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        assertNotNull("No map screenshot", bitmap)
        try {
            var inkBeyondBorder = 0
            for (index in 0 until probes.length()) {
                val probe = probes.getJSONArray(index)
                val x = (location[0] + probe.getDouble(0) * scaleX).toInt()
                val y = (location[1] + probe.getDouble(1) * scaleY).toInt()
                if (x !in 0 until bitmap.width || y !in 0 until bitmap.height) continue
                val color = bitmap.getPixel(x, y)
                if (Color.red(color) < 70 && Color.green(color) < 90 && Color.blue(color) < 70) inkBeyondBorder++
            }
            val evidence = JSONObject().put("engine", "tropnik-canvas").put("sourceLabels", JSONArray(annotations))
                .put("outsideMaskProbes", probes.length()).put("inkBeyondBorder", inkBeyondBorder).put("snapshot", snapshot)
            val report = File(app.activity.filesDir, "qa/map-labels-cross-mask.json")
            report.parentFile!!.mkdirs();report.writeText(evidence.toString(2))
            assertTrue("Domestic text was clipped by the opaque mask ($inkBeyondBorder ink pixels)", inkBeyondBorder > 20)
        } finally {bitmap.recycle()}
    }

    @Test fun noServerMeansExplicitConfigurationNotInventedSocialActivity() {
        app.onNodeWithTag("nav_profile").performClick()
        app.onNodeWithTag("configure_service").assertExists()
        app.onNodeWithTag("profile_list").performScrollToNode(hasTestTag("auth_submit"))
        app.onNodeWithTag("auth_submit").assertIsNotEnabled()
    }

    @Test fun bundledLandscapeCanOpenAndReturnToTheSameRoute() {
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("region_krasnodar"))
        app.onNodeWithTag("region_krasnodar").performClick()
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("route_kavkaz-8a"))
        app.onNodeWithTag("route_kavkaz-8a").performClick()
        app.onNodeWithTag("route_detail").performScrollToNode(hasTestTag("open_landscape"))
        waitForLandscapeWarmup("scene-warmup")
        var prepared: WebView? = null
        app.runOnIdle {
            prepared = app.activity.findViewById(R.id.landscape_viewer)
            assertNotNull("The first frame must be prepared before opening", prepared)
            assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, prepared!!.importantForAccessibility)
        }
        screenshot("route-preview")
        app.onNodeWithTag("open_landscape").performClick()
        app.onNodeWithTag("landscape_scene").assertExists()
        app.runOnIdle { assertSame(prepared, app.activity.findViewById(R.id.landscape_viewer)) }
        waitForLandscapeFrame("scene-portrait")
        screenshot("scene-portrait")
        app.runOnUiThread { prepared!!.evaluateJavascript("document.getElementById('zoom-in').click()", null) }
        waitForLandscapeFrame("scene-zoom", expectedZoom = 1.2)
        screenshot("scene-zoom")
        val originalOrientation = app.activity.requestedOrientation
        val originalConfiguration = app.activity.resources.configuration.orientation
        try {
            app.runOnUiThread { app.activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            app.waitUntil(timeoutMillis = 10_000) { app.activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE }
            waitForLandscapeFrame("scene-landscape", expectedZoom = 1.2)
            screenshot("scene-landscape")
        } finally {
            app.runOnUiThread { app.activity.requestedOrientation = originalOrientation }
            app.waitUntil(timeoutMillis = 10_000) { app.activity.resources.configuration.orientation == originalConfiguration }
        }
        app.onNodeWithTag("landscape_back").performClick()
        app.onNodeWithTag("route_detail").assertExists()
        app.onNodeWithTag("open_landscape").assertIsDisplayed().assertIsEnabled()
        app.runOnIdle {
            assertSame("Returning must retain the prepared view", prepared, app.activity.findViewById(R.id.landscape_viewer))
            assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, prepared!!.importantForAccessibility)
        }
        app.onNodeWithTag("open_landscape").performClick()
        app.runOnIdle { assertSame("Second opening must reuse its context", prepared, app.activity.findViewById(R.id.landscape_viewer)) }
        waitForLandscapeFrame("scene-reopened", expectedZoom = 1.2)
    }

    @Test fun rendererExitHandlerReleasesTheViewAndKeepsNativeRouteAvailable() {
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("region_krasnodar"))
        app.onNodeWithTag("region_krasnodar").performClick()
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("route_kavkaz-8a"))
        app.onNodeWithTag("route_kavkaz-8a").performClick()
        app.onNodeWithTag("route_detail").performScrollToNode(hasTestTag("open_landscape"))
        waitForLandscapeWarmup("renderer-exit-warmup")
        // Exercise our cleanup callback without crashing a shared WebView process.
        app.runOnIdle {
            val view = requireNotNull(app.activity.findViewById<WebView>(R.id.landscape_viewer))
            assertTrue(view.webViewClient.onRenderProcessGone(view, object : RenderProcessGoneDetail() {
                override fun didCrash() = false
                override fun rendererPriorityAtExit() = WebView.RENDERER_PRIORITY_BOUND
            }))
        }
        app.onNodeWithTag("route_detail").assertExists()
        app.onNodeWithTag("open_landscape").assertIsNotEnabled()
        app.runOnIdle { assertNull(app.activity.findViewById<WebView>(R.id.landscape_viewer)) }
    }

    @Test fun terminalDocumentFailureAfterFirstFrameCanPrepareANewView() {
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("region_krasnodar"))
        app.onNodeWithTag("region_krasnodar").performClick()
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("route_kavkaz-8a"))
        app.onNodeWithTag("route_kavkaz-8a").performClick()
        app.onNodeWithTag("route_detail").performScrollToNode(hasTestTag("open_landscape"))
        waitForLandscapeWarmup("recovery-warmup")
        var original: WebView? = null
        app.runOnIdle { original = app.activity.findViewById(R.id.landscape_viewer) }
        app.onNodeWithTag("open_landscape").performClick()
        waitForLandscapeFrame("recovery-before-error")
        // Exercise the document's real fatal guard. This does not claim to
        // reproduce a physical GPU-driver crash or kill a shared process.
        app.runOnUiThread { original!!.evaluateJavascript("window.dispatchEvent(new Event('error'))", null) }
        app.waitUntil(timeoutMillis = 10_000) {
            app.onAllNodes(hasTestTag("landscape_retry") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
        app.runOnIdle { assertNull(app.activity.findViewById<WebView>(R.id.landscape_viewer)) }
        app.onNodeWithTag("landscape_retry").performClick()
        app.onNodeWithTag("landscape_back").performClick()
        waitForLandscapeWarmup("recovery-retry-warmup")
        app.runOnIdle {
            val replacement = app.activity.findViewById<WebView>(R.id.landscape_viewer)
            assertNotNull(replacement)
            assertNotSame("Retry must create a new graphics session", original, replacement)
        }
        app.onNodeWithTag("open_landscape").performClick()
        waitForLandscapeFrame("recovery-after-retry")
    }

    private fun waitForLandscapeFrame(name: String, expectedZoom: Double = 1.0) {
        try {
            // The document and viewport must be ready before checking actual screen
            // pixels. Neither rAF nor VisualStateCallback proves screen composition.
            app.runOnUiThread {
                app.activity.findViewById<WebView>(R.id.landscape_viewer).evaluateJavascript(
                    "window.__tropnikQaDrawn=false;requestAnimationFrame(function(){requestAnimationFrame(function(){window.__tropnikQaDrawn=true;});});", null)
            }
            app.waitUntil(timeoutMillis = 20_000) {
                val completed = CountDownLatch(1)
                var matched = false
                app.runOnUiThread {
                    val view = app.activity.findViewById<WebView>(R.id.landscape_viewer)
                    if (view == null) completed.countDown()
                    else view.evaluateJavascript("(function(){var c=document.getElementById('terrain-canvas');if(!c)return false;var r=c.getBoundingClientRect();var fitted=innerHeight>0&&[document.documentElement,document.body,c].every(function(n){return Math.abs(n.getBoundingClientRect().height-innerHeight)<=2;});return window.__tropnikQaDrawn===true&&document.documentElement.dataset.sceneState==='ready'&&c.dataset.terrainPending==='false'&&fitted&&c.height>0&&r.height>0&&Math.abs(c.width/c.height-r.width/r.height)<0.02;})()") {
                        matched = it == "true"; completed.countDown()
                    }
                }
                completed.await(2, TimeUnit.SECONDS) && matched
            }
            val drawn = CountDownLatch(1)
            app.runOnUiThread {
                app.activity.findViewById<WebView>(R.id.landscape_viewer).postVisualStateCallback(1, object : WebView.VisualStateCallback() {
                    override fun onComplete(requestId: Long) { drawn.countDown() }
                })
            }
            assertTrue("WebView did not report a drawable document", drawn.await(10, TimeUnit.SECONDS))
            waitForLandscapePixels(name, expectedZoom)
        } catch (error: Throwable) {
            writeLandscapeWaitFailure(name, error)
            throw error
        }
    }

    private fun waitForLandscapeWarmup(name: String) {
        var failure: Throwable? = null
        try {
            app.waitUntil(timeoutMillis = 30_000) {
                app.onAllNodes(hasTestTag("open_landscape") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
            }
        } catch (error: Throwable) {
            failure = error
        }
        val document = documentSceneSnapshot()
        if (failure == null) {
            try {
                // Hidden warmup can retain a queued dirty frame after pause.
                // Its completed frame must still come from the real WebGL path.
                assertLandscapeGraphics(document, expectedZoom = 1.0, allowPending = true)
            } catch (error: Throwable) {
                failure = error
            }
        }
        val diagnostics = JSONObject().put("passed", failure == null).put("phase", "warmup")
            .put("native", nativeSceneSnapshot().details).put("document", document)
            .put("failure", failure?.toString()?.take(1024) ?: JSONObject.NULL)
        val report = File(app.activity.filesDir, "qa/$name-frame.json")
        report.parentFile!!.mkdirs()
        report.writeText(diagnostics.toString(2))
        failure?.let { throw it }
    }

    private fun writeLandscapeWaitFailure(name: String, error: Throwable) {
        // This runs after the original wait has failed; it never extends its
        // deadline, issues input, creates a context or asks GL to synchronize.
        try {
            val diagnostics = JSONObject().put("passed", false).put("phase", "frame-wait")
                .put("failure", error.toString().take(1024))
                .put("native", nativeSceneSnapshot().details).put("document", documentSceneSnapshot())
            val report = File(app.activity.filesDir, "qa/$name-wait-failed.json")
            report.parentFile!!.mkdirs()
            report.writeText(diagnostics.toString(2))
        } catch (diagnosticError: Throwable) {
            error.addSuppressed(diagnosticError)
        }
    }

    private fun assertLandscapeGraphics(document: Any, expectedZoom: Double, allowPending: Boolean = false) {
        val snapshot = document as? JSONObject
        assertNotNull("Missing document graphics snapshot: $document", snapshot)
        val terrain = snapshot!!.optJSONObject("terrain")
        assertNotNull("Missing actual completed-frame metadata: $snapshot", terrain)
        val frame = terrain!!.optJSONObject("frame")
        assertNotNull("Missing actual completed terrain frame: $terrain", frame)
        val completed = frame!!.optLong("frameNumber")
        assertTrue("No completed renderer callback: $frame", completed > 0)
        assertEquals("Frame counter must describe the retained callback", completed, terrain.optLong("completedFrames"))
        assertEquals("The emulator must retain WebGL2", "webgl2", frame.optString("renderer"))
        assertEquals("Canvas backend must match the completed frame", "webgl2", terrain.optString("backend"))
        assertTrue("A graphics fallback cannot count as WebGL success: $frame",
            frame.has("graphicsFallback") && frame.isNull("graphicsFallback"))
        assertTrue("Missing real presentation path: $terrain",
            terrain.optString("presentation") in setOf("deferred-msaa", "direct"))
        assertEquals("Presentation must match the completed frame", frame.optString("presentation"), terrain.optString("presentation"))
        if (!allowPending) assertEquals("A visible captured frame must be complete", "false", terrain.optString("pending"))
        val canvas = snapshot.optJSONObject("canvas")
        assertNotNull("Completed frame has no current DOM canvas", canvas)
        assertTrue("Completed frame backing size must be nonzero", frame.optInt("backingWidth") > 0 && frame.optInt("backingHeight") > 0)
        assertEquals("Completed width must match the current canvas", canvas!!.optInt("width"), frame.optInt("backingWidth"))
        assertEquals("Completed height must match the current canvas", canvas.optInt("height"), frame.optInt("backingHeight"))
        val view = frame.optJSONObject("view")
        assertNotNull("Completed frame has no actual camera view", view)
        assertEquals("The completed view must include the existing zoom input", expectedZoom, view!!.optDouble("zoom"), 0.000000001)
    }

    private data class NativeSceneSnapshot(val bounds: Rect, val details: JSONObject)

    private fun nativeSceneSnapshot(): NativeSceneSnapshot {
        val bounds = Rect()
        val details = JSONObject()
        app.runOnUiThread {
            val activity = app.activity
            val view = activity.findViewById<WebView>(R.id.landscape_viewer)
            details.put("activity", activity.javaClass.name)
                .put("activityResumed", activity.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))
                .put("windowFlags", activity.window.attributes.flags)
                .put("windowHasFocus", activity.hasWindowFocus())
                .put("orientation", activity.resources.configuration.orientation)
                .put("density", activity.resources.displayMetrics.density)
            if (view == null) details.put("missing", true)
            else {
                val location = IntArray(2)
                view.getLocationOnScreen(location)
                bounds.set(location[0], location[1], location[0] + view.width, location[1] + view.height)
                details.put("boundsOnScreen", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom)))
                    .put("layoutParamsWidth", view.layoutParams?.width).put("layoutParamsHeight", view.layoutParams?.height)
                    .put("visibility", view.visibility).put("windowVisibility", view.windowVisibility)
                    .put("alpha", view.alpha).put("shown", view.isShown).put("attached", view.isAttachedToWindow)
                    .put("scrollX", view.scrollX).put("scrollY", view.scrollY)
                    .put("translationX", view.translationX).put("translationY", view.translationY)
                    .put("scaleX", view.scaleX).put("scaleY", view.scaleY)
                val parents = JSONArray()
                var parent = view.parent
                while (parent is View && parents.length() < 5) {
                    parents.put(JSONObject().put("class", parent.javaClass.name)
                        .put("visibility", parent.visibility).put("alpha", parent.alpha)
                        .put("width", parent.width).put("height", parent.height))
                    parent = parent.parent
                }
                details.put("parents", parents)
            }
        }
        return NativeSceneSnapshot(bounds, details)
    }

    private fun landscapePixelReport(bitmap: Bitmap, nativeBounds: Rect): JSONObject {
        val bounds = Rect(nativeBounds)
        if (!bounds.intersect(0, 0, bitmap.width, bitmap.height) || bounds.width() < 64 || bounds.height() < 64) {
            return JSONObject().put("passed", false).put("reason", "WebView has no usable screen rectangle")
        }
        // Middle terrain only: excludes both the native chrome and the HTML
        // heading/controls. Checking the whole WebView could accept UI text on
        // an otherwise blank canvas. Nine tiles also reject a single small mark.
        val roi = Rect(bounds.left + bounds.width() * 20 / 100,
            bounds.top + bounds.height() * 34 / 100,
            bounds.left + bounds.width() * 80 / 100,
            bounds.top + bounds.height() * 78 / 100)
        val colors = mutableMapOf<Int, Int>()
        val tiles = Array(9) { mutableSetOf<Int>() }
        val columns = 64
        val rows = 48
        for (row in 0 until rows) for (column in 0 until columns) {
            val x = roi.left + ((column + 0.5) * roi.width() / columns).toInt()
            val y = roi.top + ((row + 0.5) * roi.height() / rows).toInt()
            val color = bitmap.getPixel(x, y)
            // Quantization ignores subpixel noise and tiny compositor changes.
            val quantized = ((Color.red(color) shr 4) shl 8) or
                ((Color.green(color) shr 4) shl 4) or (Color.blue(color) shr 4)
            colors[quantized] = (colors[quantized] ?: 0) + 1
            tiles[(row * 3 / rows) * 3 + column * 3 / columns].add(quantized)
        }
        val dominantFraction = (colors.values.maxOrNull() ?: 0).toDouble() / (columns * rows)
        val variedTiles = tiles.count { it.size >= 4 }
        val passed = colors.size >= 12 && dominantFraction < 0.95 && variedTiles >= 4
        return JSONObject().put("passed", passed)
            .put("roi", JSONArray(listOf(roi.left, roi.top, roi.right, roi.bottom)))
            .put("sampleCount", columns * rows).put("distinctQuantizedColors", colors.size)
            .put("dominantFraction", dominantFraction).put("variedTiles", variedTiles)
            .put("tileColorCounts", JSONArray(tiles.map { it.size }))
            .put("thresholds", JSONObject().put("minimumColors", 12).put("maximumDominantFractionExclusive", 0.95).put("minimumVariedTiles", 4))
    }

    private fun documentSceneSnapshot(): Any {
        val done = CountDownLatch(1)
        var result: Any = "document probe timed out"
        app.runOnUiThread {
            val view = app.activity.findViewById<WebView>(R.id.landscape_viewer)
            if (view == null) { result = "WebView missing"; done.countDown() }
            else view.evaluateJavascript("""
                (function(){
                  function element(selector){var e=document.querySelector(selector);if(!e)return null;
                    var r=e.getBoundingClientRect(),s=getComputedStyle(e);
                    return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},display:s.display,
                      visibility:s.visibility,opacity:s.opacity,transform:s.transform,
                      position:s.position,background:s.backgroundColor,width:e.width,height:e.height};}
                  var hit=document.elementFromPoint(innerWidth/2,innerHeight/2);
                  var root=document.documentElement,c=document.getElementById('terrain-canvas'),frame=null,frameError=null;
                  try{frame=root.dataset.terrainFrame?JSON.parse(root.dataset.terrainFrame):null;}
                  catch(error){frameError=String(error).slice(0,256);}
                  var terrain={frame:frame,frameError:frameError,completedFrames:Number(root.dataset.terrainFrameCount||0),
                    backend:c?c.dataset.renderer||null:null,presentation:c?c.dataset.terrainPresentation||null:null,
                    pending:c?c.dataset.terrainPending||null:null};
                  return JSON.stringify({sceneState:document.documentElement.dataset.sceneState,terrain:terrain,
                    visibility:document.visibilityState,innerWidth:innerWidth,innerHeight:innerHeight,
                    devicePixelRatio:devicePixelRatio,scrollX:scrollX,scrollY:scrollY,
                    html:element('html'),body:element('body'),landscape:element('.landscape'),
                    canvas:element('#terrain-canvas'),heading:element('.heading'),controls:element('.controls'),
                    centerElement:hit?{tag:hit.tagName,id:hit.id,className:hit.className}:null});
                })()
            """.trimIndent()) { raw ->
                result = runCatching { JSONObject(JSONTokener(raw).nextValue() as String) }.getOrElse { raw }
                done.countDown()
            }
        }
        done.await(3, TimeUnit.SECONDS)
        return result
    }

    private fun waitForLandscapePixels(name: String, expectedZoom: Double) {
        var lastBitmap: Bitmap? = null
        var native = NativeSceneSnapshot(Rect(), JSONObject())
        var pixels = JSONObject().put("passed", false).put("reason", "No screenshot captured")
        var passed = false
        var failure: Throwable? = null
        var document: Any? = null
        try {
            app.waitUntil(timeoutMillis = 12_000) {
                native = nativeSceneSnapshot()
                lastBitmap?.recycle()
                lastBitmap = null
                lastBitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
                pixels = lastBitmap?.let { landscapePixelReport(it, native.bounds) }
                    ?: JSONObject().put("passed", false).put("reason", "Screenshot unavailable")
                passed = pixels.optBoolean("passed") && native.details.optBoolean("shown") && native.details.optBoolean("attached")
                passed
            }
            val completedDocument = documentSceneSnapshot()
            document = completedDocument
            assertLandscapeGraphics(completedDocument, expectedZoom)
        } catch (error: AssertionError) {
            passed = false
            failure = error
        } catch (error: ComposeTimeoutException) {
            passed = false
            failure = error
        } catch (error: Exception) {
            passed = false
            failure = error
        } finally {
            val diagnostics = JSONObject().put("passed", passed).put("native", native.details)
                .put("pixels", pixels).put("document", document ?: documentSceneSnapshot())
                .put("failure", failure?.toString()?.take(1024) ?: JSONObject.NULL)
            val report = File(app.activity.filesDir, "qa/$name-frame.json")
            report.parentFile!!.mkdirs()
            report.writeText(diagnostics.toString(2))
            lastBitmap?.let { bitmap ->
                if (!passed) File(app.activity.filesDir, "qa/$name-frame-failed.png").outputStream().use { output ->
                    assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
                }
                bitmap.recycle()
            }
        }
        if (!passed) throw AssertionError("No visible terrain pixels in the central WebView rectangle: $pixels", failure)
    }

    private fun screenshot(name: String) {
        app.waitForIdle()
        val bitmap = requireNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
        val target = File(app.activity.filesDir, "qa/$name.png")
        target.parentFile!!.mkdirs()
        target.outputStream().use { output -> assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) }
        bitmap.recycle()
    }
}
