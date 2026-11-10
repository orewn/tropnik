package ru.tropa.app

import android.view.View
import android.view.ViewGroup
import android.view.InputDevice
import android.view.MotionEvent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PointF
import android.graphics.Rect
import android.graphics.RectF
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
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.geojson.Point
import org.maplibre.geojson.Polygon
import ru.tropa.app.data.MAP_LABEL_SOURCE
import ru.tropa.app.data.MapLabelGeometry
import ru.tropa.app.data.withMapLabelCoverage
import ru.tropa.app.ui.NativeMapLabels
import ru.tropa.app.data.Catalog
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Uses only bundled data. Run on an emulator/device with networking disabled too. */
@RunWith(AndroidJUnit4::class)
class LocalExperienceTest {
    @get:Rule val app = createAndroidComposeRule<MainActivity>()

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

    private fun readyMap(): Pair<MapView, MapLibreMap> {
        // The map is the third catalogue item. Bring its full height into view
        // before using the SDK projection; no region-list click or callback is used.
        app.onNodeWithTag("explore_list").performScrollToIndex(2)
        fun findMapView(view: View): MapView? {
            if (view is MapView) return view
            if (view is ViewGroup) for (index in 0 until view.childCount) {
                findMapView(view.getChildAt(index))?.let { return it }
            }
            return null
        }
        var view: MapView? = null
        app.waitUntil(timeoutMillis = 10_000) {
            var attached = false
            app.runOnUiThread {
                view = findMapView(app.activity.window.decorView)
                attached = view?.isAttachedToWindow == true
            }
            attached
        }
        val mapView = requireNotNull(view)
        val ready = CountDownLatch(1)
        var nativeMap: MapLibreMap? = null
        app.runOnUiThread { mapView.getMapAsync { nativeMap = it; ready.countDown() } }
        assertTrue("MapLibre did not initialize", ready.await(10, TimeUnit.SECONDS))
        val map = requireNotNull(nativeMap)
        app.waitUntil(timeoutMillis = 20_000) {
            var loaded = false
            app.runOnUiThread { loaded = map.style?.isFullyLoaded == true }
            loaded && app.onAllNodes(hasText("Открываем карту России…")).fetchSemanticsNodes().isEmpty()
        }
        app.waitForIdle()
        return mapView to map
    }

    private fun tapRegionMarker(regionId: String) {
        val region = Catalog.load(app.activity).regions.single { it.id == regionId }
        val (mapView, map) = readyMap()
        // Separate nearby region markers at a normal map zoom. This changes
        // only the viewport; selection must still travel through a real touch.
        app.runOnUiThread { map.moveCamera(CameraUpdateFactory.newLatLngZoom(LatLng(region.latitude, region.longitude), 6.0)) }
        var point = PointF()
        app.waitUntil(timeoutMillis = 15_000) {
            var rendered = false
            app.runOnUiThread {
                point = map.projection.toScreenLocation(LatLng(region.latitude, region.longitude))
                val hits = map.queryRenderedFeatures(RectF(point.x - 8, point.y - 8, point.x + 8, point.y + 8), "region-markers")
                rendered = hits.any { it.hasProperty("regionId") && it.getStringProperty("regionId") == regionId }
            }
            rendered
        }
        val location = IntArray(2)
        val visible = Rect()
        app.runOnUiThread {
            mapView.getLocationOnScreen(location)
            assertTrue("Map must be visible for touch injection", mapView.getGlobalVisibleRect(visible))
        }
        val x = location[0] + point.x
        val y = location[1] + point.y
        assertTrue("Projected marker must be on screen", visible.contains(x.toInt(), y.toInt()))
        screenshot("map-region-before-tap")
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val downTime = SystemClock.uptimeMillis()
        for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
            val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            try { assertTrue("Map touch injection failed", automation.injectInputEvent(event, true)) }
            finally { event.recycle() }
        }
        app.waitUntil(timeoutMillis = 10_000) {
            app.onAllNodes(hasText("Обзор района")).fetchSemanticsNodes().isNotEmpty()
        }
        app.onNodeWithTag("explore_list").performScrollToIndex(0)
        app.onNodeWithText(region.name).assertExists()
        screenshot("map-region-after-tap")
    }

    @Test fun nativeLabelsRemainWholeAboveTheMaskAndRejectForeignAnchorsOffline() {
        val (mapView, map) = readyMap()
        val bundled = JSONObject(app.activity.assets.open("maps/style.json").bufferedReader().use { it.readText() })
        // Synthetic boundary/labels isolate symbol placement from a changing
        // upstream tile. The real SDK query, coverage predicate, worker,
        // source update and rasterized glyphs are all exercised offline.
        val fixture = JSONObject().put("version", 8).put("glyphs", bundled.getString("glyphs"))
            .put("sources", JSONObject()
                .put("fixture", JSONObject().put("type", "geojson").put("data", JSONObject("""{"type":"FeatureCollection","features":[
                    {"type":"Feature","id":"domestic","properties":{"name":"ПРИМОРСК"},"geometry":{"type":"Point","coordinates":[29.98,60]}},
                    {"type":"Feature","id":"foreign","properties":{"name":"ЗАРУБЕЖНЫЙ"},"geometry":{"type":"Point","coordinates":[30.18,60]}}
                ]}""")))
                .put("mask", JSONObject().put("type", "geojson").put("data", JSONObject("""{"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":[[[30,58],[40,58],[40,62],[30,62],[30,58]]]}}"""))))
            .put("layers", JSONArray()
                .put(JSONObject("""{"id":"background","type":"background","paint":{"background-color":"#FFFFFF"}}"""))
                .put(JSONObject("""{"id":"fixture-label","type":"symbol","source":"fixture","layout":{"text-field":["get","name"],"text-font":["Noto Sans Regular"],"text-size":24,"text-anchor":"left","text-allow-overlap":true},"paint":{"text-color":"#102018","text-halo-width":0}}"""))
                .put(JSONObject("""{"id":"russia-outside-mask","type":"fill","source":"mask","paint":{"fill-color":"#F5F3E8","fill-opacity":1,"fill-antialias":false}}""")))
        val prepared = withMapLabelCoverage(fixture.toString())
        val coverage = MapLabelGeometry.fromPolygons(listOf(Polygon.fromLngLats(listOf(listOf(
            Point.fromLngLat(29.0, 59.0), Point.fromLngLat(30.0, 59.0), Point.fromLngLat(30.0, 61.0),
            Point.fromLngLat(29.0, 61.0), Point.fromLngLat(29.0, 59.0))))))
        val loaded = CountDownLatch(1)
        var labels: NativeMapLabels? = null
        try {
            app.runOnUiThread {
                map.setStyle(Style.Builder().fromJson(prepared.json)) {
                    labels = NativeMapLabels(mapView, map, prepared.groups, coverage)
                    map.moveCamera(CameraUpdateFactory.newLatLngZoom(LatLng(60.0, 30.0), 8.0))
                    loaded.countDown()
                }
            }
            assertTrue("Synthetic style did not load", loaded.await(20, TimeUnit.SECONDS))
            app.runOnUiThread {
                assertNotNull("The SDK rejected the source-retention layer", map.style?.getLayer("tropnik-label-query-1"))
            }
            var originalCount = 0; var acceptedNames = emptySet<String>(); var renderedCount = 0
            var labelsReady = false
            try {
                app.waitUntil(timeoutMillis = 20_000) {
                    var ready = false
                    app.runOnUiThread {
                        originalCount = map.style?.getSourceAs<GeoJsonSource>("fixture")?.querySourceFeatures(null).orEmpty().size
                        val accepted = map.style?.getSourceAs<GeoJsonSource>(MAP_LABEL_SOURCE)?.querySourceFeatures(null).orEmpty()
                        val rendered = map.queryRenderedFeatures(RectF(0f, 0f, mapView.width.toFloat(), mapView.height.toFloat()), "fixture-label")
                        acceptedNames = accepted.map { it.getStringProperty("name") }.toSet()
                        renderedCount = rendered.size
                        ready = accepted.isNotEmpty() && accepted.all { it.getStringProperty("name") == "ПРИМОРСК" } && rendered.isNotEmpty()
                    }
                    ready
                }
                labelsReady = true
            } finally {
                android.util.Log.i("TropnikLabelTest", "original=$originalCount accepted=$acceptedNames rendered=$renderedCount ready=$labelsReady")
                if (!labelsReady) screenshot("map-labels-not-ready")
            }
            var boundary = PointF(); val location = IntArray(2)
            app.runOnUiThread {
                boundary = map.projection.toScreenLocation(LatLng(60.0, 30.0))
                mapView.getLocationOnScreen(location)
                val original = map.style!!.getSourceAs<GeoJsonSource>("fixture")!!.querySourceFeatures(null)
                assertEquals(setOf("ПРИМОРСК", "ЗАРУБЕЖНЫЙ"), original.map { it.getStringProperty("name") }.toSet())
            }
            screenshot("map-labels-cross-mask")
            val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            assertNotNull("No map screenshot", bitmap)
            try {
                val x = location[0] + boundary.x.toInt(); val y = location[1] + boundary.y.toInt()
                var inkBeyondBorder = 0
                for (px in (x + 8)..minOf(x + 95, bitmap.width - 1)) for (py in maxOf(0, y - 20)..minOf(bitmap.height - 1, y + 20)) {
                    val color = bitmap.getPixel(px, py)
                    if (Color.red(color) < 90 && Color.green(color) < 100 && Color.blue(color) < 90) inkBeyondBorder++
                }
                assertTrue("Domestic text was clipped by the opaque mask ($inkBeyondBorder ink pixels)", inkBeyondBorder > 20)
            } finally { bitmap.recycle() }
        } finally {
            app.runOnUiThread { labels?.dispose() }
        }
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
        app.waitUntil(timeoutMillis = 30_000) {
            app.onAllNodes(hasTestTag("open_landscape") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
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
        waitForLandscapeFrame("scene-zoom")
        screenshot("scene-zoom")
        val originalOrientation = app.activity.requestedOrientation
        val originalConfiguration = app.activity.resources.configuration.orientation
        try {
            app.runOnUiThread { app.activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            app.waitUntil(timeoutMillis = 10_000) { app.activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE }
            waitForLandscapeFrame("scene-landscape")
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
        waitForLandscapeFrame("scene-reopened")
    }

    @Test fun rendererExitHandlerReleasesTheViewAndKeepsNativeRouteAvailable() {
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("region_krasnodar"))
        app.onNodeWithTag("region_krasnodar").performClick()
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("route_kavkaz-8a"))
        app.onNodeWithTag("route_kavkaz-8a").performClick()
        app.onNodeWithTag("route_detail").performScrollToNode(hasTestTag("open_landscape"))
        app.waitUntil(timeoutMillis = 30_000) {
            app.onAllNodes(hasTestTag("open_landscape") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
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
        app.waitUntil(timeoutMillis = 30_000) {
            app.onAllNodes(hasTestTag("open_landscape") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
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
        app.waitUntil(timeoutMillis = 30_000) {
            app.onAllNodes(hasTestTag("open_landscape") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
        app.runOnIdle {
            val replacement = app.activity.findViewById<WebView>(R.id.landscape_viewer)
            assertNotNull(replacement)
            assertNotSame("Retry must create a new graphics session", original, replacement)
        }
        app.onNodeWithTag("open_landscape").performClick()
        waitForLandscapeFrame("recovery-after-retry")
    }

    private fun waitForLandscapeFrame(name: String) {
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
                else view.evaluateJavascript("(function(){var c=document.getElementById('terrain-canvas');if(!c)return false;var r=c.getBoundingClientRect();var fitted=innerHeight>0&&[document.documentElement,document.body,c].every(function(n){return Math.abs(n.getBoundingClientRect().height-innerHeight)<=2;});return window.__tropnikQaDrawn===true&&document.documentElement.dataset.sceneState==='ready'&&fitted&&c.height>0&&r.height>0&&Math.abs(c.width/c.height-r.width/r.height)<0.02;})()") {
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
        waitForLandscapePixels(name)
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
                  return JSON.stringify({sceneState:document.documentElement.dataset.sceneState,
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

    private fun waitForLandscapePixels(name: String) {
        var lastBitmap: Bitmap? = null
        var native = NativeSceneSnapshot(Rect(), JSONObject())
        var pixels = JSONObject().put("passed", false).put("reason", "No screenshot captured")
        var passed = false
        var failure: Throwable? = null
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
        } catch (error: ComposeTimeoutException) {
            failure = error
        } catch (error: Exception) {
            failure = error
        } finally {
            val diagnostics = JSONObject().put("passed", passed).put("native", native.details)
                .put("pixels", pixels).put("document", documentSceneSnapshot())
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
