package ru.tropa.app.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebChromeClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import ru.tropa.app.data.MAX_LANDSCAPE_BYTES
import ru.tropa.app.data.loadLandscapeDocument
import ru.tropa.app.R

internal data class LocalLandscapeDocument(val html: String? = null, val error: String? = null)

/** Preload and verify while the route preview is visible, before the user taps 3D. */
@Composable
internal fun rememberLandscapeDocument(enabled: Boolean): State<LocalLandscapeDocument> {
    val context = LocalContext.current.applicationContext
    return produceState(LocalLandscapeDocument(), context, enabled) {
        if (!enabled) value = LocalLandscapeDocument()
        if (enabled) value = withContext(Dispatchers.IO) {
            runCatching {
                val document = loadLandscapeDocument { path ->
                    context.assets.open(path).use { input ->
                        val output = ByteArrayOutputStream()
                        val buffer = ByteArray(16 * 1024)
                        while (true) {
                            val length = input.read(buffer)
                            if (length < 0) break
                            require(output.size() + length <= MAX_LANDSCAPE_BYTES) { "Landscape asset is too large" }
                            output.write(buffer, 0, length)
                        }
                        output.toByteArray()
                    }
                }
                LocalLandscapeDocument(html = document)
            }.getOrElse { LocalLandscapeDocument(error = "Рельеф пока не открывается. Вернитесь к сохранённой карте.") }
        }
    }
}

/** One bounded WebView belongs to one route preview, including its hidden warmup.
 * All commands below are fixed lifecycle messages. No native object is exposed
 * to JavaScript, and no account, location or server data enters this document.
 */
internal class LocalLandscapeViewer(private val context: Context) {
    var browser by mutableStateOf<WebView?>(null)
        private set
    var ready by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    val canRetry: Boolean get() = !disposed && lastDocument?.html != null

    private val handler = Handler(Looper.getMainLooper())
    private var disposed = false
    private var loaded = false
    private var pageLoaded = false
    private var resumed = false
    private var visible = false
    private var webResumed = false
    private var lastActive: Boolean? = null
    private var visualRequest = 0L
    private var visualPending = false
    private var probeInFlight = false
    private var probeRequest = 0L
    private var probePending: Runnable? = null
    private var warmupTimeout: Runnable? = null
    private var lastDocument: LocalLandscapeDocument? = null

    @SuppressLint("SetJavaScriptEnabled")
    fun load(document: LocalLandscapeDocument) {
        if (disposed || loaded) return
        lastDocument = document
        error = document.error
        val html = document.html ?: return
        loaded = true
        try {
            val view = WebView(context).apply {
                id = R.id.landscape_viewer
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = false
                settings.databaseEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.allowFileAccessFromFileURLs = false
                settings.allowUniversalAccessFromFileURLs = false
                settings.blockNetworkLoads = true
                settings.blockNetworkImage = true
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                settings.cacheMode = WebSettings.LOAD_NO_CACHE
                settings.javaScriptCanOpenWindowsAutomatically = false
                settings.setSupportMultipleWindows(false)
                settings.setGeolocationEnabled(false)
                settings.setSupportZoom(false)
                settings.safeBrowsingEnabled = true
                // Exactly one viewport-sized, attached view. Its first frame is
                // rendered behind the route card, then rendering is paused.
                settings.offscreenPreRaster = true
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                isFocusable = false
                setOnTouchListener { _, _ -> !visible }
                // Per-view only: do not change global cookies or timers used by
                // other WebViews/auth flows. This origin never carries a login.
                CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
                webChromeClient = object : WebChromeClient() {
                    override fun onPermissionRequest(request: PermissionRequest?) { request?.deny() }
                }
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
                    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? =
                        if (request?.url?.scheme in setOf("data", "blob", "about")) null
                        else WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(byteArrayOf()))
                    override fun onPageFinished(view: WebView?, url: String?) {
                        if (disposed || view !== browser || url != ORIGIN) return
                        pageLoaded = true
                        applyActivity()
                        probe()
                    }
                    override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                        if (request?.isForMainFrame == true && view === browser) fail("Рельеф не открылся. Попробуйте ещё раз.")
                    }
                    override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                        if (view === browser) {
                            cancelProbe()
                            cancelWarmupTimeout()
                            invalidateDocumentState()
                            browser = null
                            ready = false
                            error = "Рельеф закрылся. Откройте его снова или вернитесь к карте."
                        }
                        // A view with a dead renderer must never be resumed or
                        // reused. Remove only this view, not other WebViews.
                        (view?.parent as? ViewGroup)?.removeView(view)
                        view?.destroy()
                        return true
                    }
                }
            }
            browser = view
            view.loadDataWithBaseURL(ORIGIN, html, "text/html", "UTF-8", null)
            applyActivity()
            startWarmupTimeout()
        } catch (_: Exception) {
            fail("Не удалось открыть рельеф на этом телефоне. Сохранённая карта остаётся доступна.")
        }
    }

    fun setVisible(value: Boolean) {
        visible = value
        browser?.apply {
            importantForAccessibility = if (value) View.IMPORTANT_FOR_ACCESSIBILITY_AUTO else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            isFocusable = value
            isFocusableInTouchMode = value
            if (!value) clearFocus()
        }
        applyActivity()
        if (!value && ready) cancelProbe() else probe()
    }

    /** Retry is a new WebView and graphics session, never a reused failed view. */
    fun retry() {
        if (!canRetry) return
        val document = lastDocument ?: return
        releaseView()
        loaded = false
        error = null
        load(document)
    }

    fun setResumed(value: Boolean) {
        if (disposed) return
        resumed = value
        if (!value) { cancelProbe(); cancelWarmupTimeout() }
        else startWarmupTimeout()
        applyActivity()
        if (value) probe()
    }

    private fun applyActivity() {
        val view = browser ?: return
        if (disposed) return
        val active = resumed && (visible || !ready)
        if (active && !webResumed) { view.onResume(); webResumed = true }
        if (pageLoaded && lastActive != active) {
            lastActive = active
            view.evaluateJavascript(if (active) RESUME_SCENE else PAUSE_SCENE, null)
        }
        if (!active && webResumed) { view.onPause(); webResumed = false }
    }

    /** onPageFinished alone does not prove that shaders and the first frame ran. */
    private fun probe() {
        val view = browser ?: return
        if (disposed || !resumed || (!visible && ready) || !pageLoaded || visualPending || probeInFlight || probePending != null) return
        val request = ++probeRequest
        probeInFlight = true
        view.evaluateJavascript("document.documentElement.dataset.sceneState || 'loading'") { result ->
            if (disposed || browser !== view || request != probeRequest) return@evaluateJavascript
            probeInFlight = false
            if (!resumed) return@evaluateJavascript
            when (result) {
                "\"ready\"" -> {
                    if (ready) { scheduleProbe(500); return@evaluateJavascript }
                    visualPending = true
                    view.postVisualStateCallback(++visualRequest, object : WebView.VisualStateCallback() {
                        override fun onComplete(requestId: Long) {
                            if (disposed || browser !== view || requestId != visualRequest) return
                            visualPending = false
                            ready = true
                            cancelWarmupTimeout()
                            applyActivity()
                            scheduleProbe(500)
                        }
                    })
                }
                "\"failed\"" -> fail("Рельеф закрылся. Попробуйте снова или вернитесь к сохранённой карте.")
                else -> {
                    if (ready) { ready = false; startWarmupTimeout(); applyActivity() }
                    scheduleProbe(100)
                }
            }
        }
    }

    private fun scheduleProbe(delayMillis: Long) {
        if (disposed || browser == null || !resumed || (!visible && ready) || probePending != null) return
        val next = Runnable { probePending = null; probe() }
        probePending = next
        handler.postDelayed(next, delayMillis)
    }

    private fun cancelProbe() {
        probePending?.let(handler::removeCallbacks)
        probePending = null
    }

    private fun startWarmupTimeout() {
        val view = browser ?: return
        if (disposed || ready || !resumed || warmupTimeout != null) return
        val timeout = Runnable {
            warmupTimeout = null
            if (!disposed && browser === view && resumed && !ready) {
                fail("Рельеф не открылся. Попробуйте ещё раз или вернитесь к сохранённой карте.")
            }
        }
        warmupTimeout = timeout
        handler.postDelayed(timeout, 30_000)
    }

    private fun cancelWarmupTimeout() {
        warmupTimeout?.let(handler::removeCallbacks)
        warmupTimeout = null
    }

    private fun releaseView() {
        cancelProbe()
        cancelWarmupTimeout()
        val view = browser
        browser = null
        invalidateDocumentState()
        ready = false
        (view?.parent as? ViewGroup)?.removeView(view)
        if (view != null) { view.stopLoading(); view.onPause(); view.removeAllViews(); view.destroy() }
    }

    private fun invalidateDocumentState() {
        ++visualRequest
        ++probeRequest
        visualPending = false
        probeInFlight = false
        pageLoaded = false
        webResumed = false
        lastActive = null
    }

    private fun fail(message: String) {
        error = message
        releaseView()
    }

    fun destroy() {
        if (disposed) return
        disposed = true
        releaseView()
        lastDocument = null
    }

    private companion object {
        const val ORIGIN = "https://appassets.androidplatform.net/landscape/"
        const val RESUME_SCENE = "window.dispatchEvent(new Event('tropnik-scene-resume'))"
        const val PAUSE_SCENE = "window.dispatchEvent(new Event('tropnik-scene-pause'))"
    }
}

@Composable
internal fun rememberLandscapeViewer(document: LocalLandscapeDocument, enabled: Boolean): LocalLandscapeViewer {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val viewer = remember(context, enabled, lifecycle) { LocalLandscapeViewer(context) }
    DisposableEffect(viewer, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> viewer.setResumed(true)
                Lifecycle.Event.ON_PAUSE -> viewer.setResumed(false)
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            viewer.destroy()
        }
    }
    LaunchedEffect(viewer, document, enabled) { if (enabled) viewer.load(document) }
    return viewer
}

/** Remains attached behind the route preview so opening and returning reuse it. */
@Composable
internal fun LocalLandscapeScene(viewer: LocalLandscapeViewer, visible: Boolean, onBack: () -> Unit) {
    val compact = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    SideEffect { viewer.setVisible(visible) }
    BackHandler(enabled = visible, onBack = onBack)
    val semantics = if (visible) Modifier.testTag("landscape_scene") else Modifier.clearAndSetSemantics { }
    Column(Modifier.fillMaxSize().then(semantics)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TrailTextButton(onClick = onBack, enabled = visible, modifier = Modifier.heightIn(min = 48.dp).testTag("landscape_back")) { TropaIcon(Glyph.BACK); Spacer(Modifier.width(8.dp)); Text("К карте") }
            Column(Modifier.weight(1f).padding(vertical = 8.dp)) {
                Text("Бзерпинский район", style = MaterialTheme.typography.titleMedium)
                if (!compact) Text("Посмотрите на горы с разных сторон", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
            }
        }
        val browser = viewer.browser
        if (viewer.error != null) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                EmptyCard("Сцена сейчас недоступна", viewer.error!!, Glyph.MOUNTAIN)
                if (viewer.canRetry) TrailButton(onClick = viewer::retry, enabled = visible,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("landscape_retry")) {
                    Text("Попробовать снова")
                }
            }
        } else if (browser == null) {
            LinearProgressIndicator(Modifier.fillMaxWidth())
        } else key(browser) { AndroidView(factory = { browser }, modifier = Modifier.weight(1f).fillMaxWidth().testTag("landscape_webview")) }
        if (!compact) Surface(color = Palette.Surface) {
            Text("Перед походом уточните разрешённый путь и действующие ограничения у заповедника.", Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall, color = Palette.WarningText)
        }
    }
}
