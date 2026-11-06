package ru.tropa.app

import android.view.View
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
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
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Uses only bundled data. Run on an emulator/device with networking disabled too. */
@RunWith(AndroidJUnit4::class)
class LocalExperienceTest {
    @get:Rule val app = createAndroidComposeRule<MainActivity>()

    @Test fun canOpenRegionAndReadOfficialRestrictionWithoutAnAccount() {
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("region_krasnodar"))
        app.onNodeWithTag("region_krasnodar").performClick()
        app.onNodeWithTag("explore_list").performScrollToNode(hasTestTag("route_kavkaz-8a"))
        app.onNodeWithTag("route_kavkaz-8a").performClick()
        app.onNodeWithText("Ограничение доступа").assertExists()
        app.onNodeWithTag("route_detail").performScrollToNode(hasTestTag("save_route"))
        app.onNodeWithTag("save_route").assertIsEnabled()
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
        waitForLandscapeFrame()
        screenshot("scene-portrait")
        app.runOnUiThread { prepared!!.evaluateJavascript("document.getElementById('zoom-in').click()", null) }
        waitForLandscapeFrame()
        screenshot("scene-zoom")
        val originalOrientation = app.activity.requestedOrientation
        val originalConfiguration = app.activity.resources.configuration.orientation
        try {
            app.runOnUiThread { app.activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            app.waitUntil(timeoutMillis = 10_000) { app.activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE }
            waitForLandscapeFrame()
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
        waitForLandscapeFrame()
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
        waitForLandscapeFrame()
    }

    private fun waitForLandscapeFrame() {
        // Let the viewport resize and the requested camera frame reach WebView's
        // compositor. This is a QA marker, not a native JavaScript interface.
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
                else view.evaluateJavascript("(function(){var c=document.getElementById('terrain-canvas');if(!c)return false;var r=c.getBoundingClientRect();return window.__tropnikQaDrawn===true&&document.documentElement.dataset.sceneState==='ready'&&c.height>0&&r.height>0&&Math.abs(c.width/c.height-r.width/r.height)<0.02;})()") {
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
        assertTrue("WebView did not commit the frame", drawn.await(10, TimeUnit.SECONDS))
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
