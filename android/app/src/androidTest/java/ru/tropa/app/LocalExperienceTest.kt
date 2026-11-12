package ru.tropa.app

import android.view.View
import android.view.ViewGroup
import android.view.InputDevice
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.os.SystemClock
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
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
import ru.tropa.app.ui.CustomMapWebView
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Uses only bundled data. Run on an emulator/device with networking disabled too. */
@RunWith(AndroidJUnit4::class)
class LocalExperienceTest {
    @get:Rule val app = createAndroidComposeRule<MainActivity>()

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
            assertTrue("The current map DOM did not reach the compositor before the original selection deadline", remaining > 0 && visual.await(remaining, TimeUnit.MILLISECONDS))
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
