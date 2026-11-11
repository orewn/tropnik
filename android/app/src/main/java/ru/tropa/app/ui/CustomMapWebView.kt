package ru.tropa.app.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebMessage
import android.webkit.WebMessagePort
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.view.ViewGroup
import android.view.MotionEvent
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import ru.tropa.app.BuildConfig
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

internal const val CUSTOM_MAP_ORIGIN = "https://map.tropnik.invalid"
private const val CUSTOM_MAP_DOCUMENT = "$CUSTOM_MAP_ORIGIN/custom-map/index.html"
private const val MAX_MAP_RESOURCE_BYTES = 8 * 1024 * 1024
private const val MAX_ROUTE_BYTES = 16 * 1024 * 1024

/** Closed URL policy shared by the resource broker and focused JVM tests.
 * Remote requests never inherit a session, cookies, account or caller headers. */
internal object CustomMapResourcePolicy {
    fun safePath(path: String): Boolean = path.startsWith('/') && path.length <= 512 &&
        Regex("/[A-Za-z0-9_./-]*").matches(path) && path.split('/').drop(1).all { it.isNotEmpty() && it != "." && it != ".." }

    fun remoteAllowed(value: String): Boolean = runCatching {
        val uri = URI(value)
        if (uri.scheme != "https" || uri.port !in listOf(-1, 443) || uri.userInfo != null || uri.fragment != null || uri.rawQuery != null || uri.rawPath != uri.path || !safePath(uri.path)) return@runCatching false
        when (uri.host) {
            "tiles.openfreemap.org" -> uri.path.startsWith("/planet/")
            "tiles.mapterhorn.com" -> Regex("/\\d{1,2}/\\d{1,7}/\\d{1,7}\\.webp").matches(uri.path)
            "tiles.maps.eox.at" -> Regex("/wmts/1\\.0\\.0/(s2cloudless_3857|bluemarble_3857)/default/g/\\d{1,2}/\\d{1,7}/\\d{1,7}\\.jpg").matches(uri.path)
            else -> false
        }
    }.getOrDefault(false)
}

private data class MapAsset(val path: String, val size: Int, val sha256: String)
private data class CurrentMapRoute(val url: String, val bytes: ByteArray)

/** Each view owns its broker and bounded buffers. Every request is intercepted,
 * including failures; WebView itself is never allowed onto the network. */
private class CustomMapResources(context: Context, private val networkFailure: () -> Unit) {
    private val assets = context.applicationContext.assets
    private val manifest = JSONObject(assets.open("custom-map/manifest.json").bufferedReader().use { it.readText() })
    private val allowed = mutableMapOf<String, MapAsset>()
    private val calls = ConcurrentHashMap.newKeySet<Call>()
    private val networkPermits = Semaphore(3, true)
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(8, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).callTimeout(12, TimeUnit.SECONDS).build()
    private val network = MapNetworkLifetime(
        cancelCalls = { calls.forEach { runCatching { it.cancel() } } },
        releaseNetwork = { try { client.connectionPool.evictAll() } finally { client.dispatcher.executorService.shutdown() } },
    )
    @Volatile private var route: CurrentMapRoute? = null

    init {
        require(manifest.getInt("schemaVersion") == 1 && manifest.getString("runtime") == "tropnik-canvas" && manifest.getString("origin") == CUSTOM_MAP_ORIGIN)
        fun add(url: String, path: String, size: Int, sha: String) {
            require(CustomMapResourcePolicy.safePath(url) && CustomMapResourcePolicy.safePath("/$path") && size in 1..MAX_MAP_RESOURCE_BYTES && Regex("[a-f0-9]{64}").matches(sha))
            require(allowed.put(url, MapAsset(path, size, sha)) == null)
        }
        val files = manifest.getJSONArray("files")
        for (index in 0 until files.length()) {
            val file = files.getJSONObject(index);val path = file.getString("path")
            add("/custom-map/$path", "custom-map/$path", file.getInt("sizeBytes"), file.getString("sha256"))
        }
        val aliases = manifest.getJSONArray("resourceAliases")
        for (index in 0 until aliases.length()) {
            val alias = aliases.getJSONObject(index)
            add(alias.getString("url"), alias.getString("assetPath"), alias.getInt("sizeBytes"), alias.getString("sha256"))
        }
        allowed["/offline-map/manifest.json"] = requireNotNull(allowed["/custom-map/offline-manifest.json"])
    }

    fun setOnline(value: Boolean) {
        network.setOnline(value)
    }

    fun setRoute(url: String?, bytes: ByteArray?) {
        require(bytes == null || bytes.size in 1..MAX_ROUTE_BYTES)
        route = if (url != null && bytes != null) CurrentMapRoute(url, bytes) else null
    }

    private fun response(bytes: ByteArray, mime: String, status: Int = 200): WebResourceResponse = WebResourceResponse(
        mime, if (mime.contains("json") || mime.startsWith("text/") || mime.contains("javascript")) "UTF-8" else null,
        status, if (status == 200) "OK" else "Unavailable", mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff",
            "Access-Control-Allow-Origin" to CUSTOM_MAP_ORIGIN, "Cross-Origin-Resource-Policy" to "same-origin"), ByteArrayInputStream(bytes))

    private fun denied() = response(ByteArray(0), "text/plain", 403)
    private fun mime(path: String) = when {
        path.endsWith(".html") -> "text/html"
        path.endsWith(".js") -> "text/javascript"
        path.endsWith(".css") -> "text/css"
        path.endsWith(".json") || path.endsWith(".geojson") -> "application/json"
        path.endsWith(".png") -> "image/png"
        path.endsWith(".webp") -> "image/webp"
        path.endsWith(".jpg") -> "image/jpeg"
        path.endsWith(".woff2") -> "font/woff2"
        path.endsWith(".pbf") -> "application/x-protobuf"
        else -> "application/octet-stream"
    }

    fun intercept(request: WebResourceRequest): WebResourceResponse {
        if (network.isClosed || request.method != "GET") return denied()
        val url = request.url
        if (url.scheme == "https" && url.host == "map.tropnik.invalid" && url.port == -1 && url.userInfo == null && url.fragment == null) {
            val path = url.path ?: return denied()
            if (!CustomMapResourcePolicy.safePath(path) || url.encodedPath != path || url.query != null) return denied()
            route?.let { if (url.toString() == it.url) return response(it.bytes, "application/json") }
            val asset = allowed[path] ?: return denied()
            return runCatching {
                val bytes = assets.open(asset.path).use { input ->
                    val result = ByteArray(asset.size)
                    var offset = 0
                    while (offset < result.size) {val count = input.read(result, offset, result.size - offset);check(count > 0);offset += count}
                    check(input.read() == -1);result
                }
                val actual = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                check(actual == asset.sha256)
                response(bytes, mime(asset.path))
            }.getOrElse { denied() }
        }
        if (!network.isOnline || !CustomMapResourcePolicy.remoteAllowed(url.toString())) return denied()
        if (!runCatching {networkPermits.tryAcquire(1, TimeUnit.SECONDS)}.getOrDefault(false)) return denied()
        val call = client.newCall(Request.Builder().url(url.toString()).get().build())
        calls.add(call)
        return try {
            if (!network.isOnline || network.isClosed) return denied()
            call.execute().use { result ->
                if (!result.isSuccessful || !network.isOnline || network.isClosed) {networkFailure();return denied()}
                val body = result.body ?: return denied()
                if (body.contentLength() > MAX_MAP_RESOURCE_BYTES) return denied()
                val bytes = ByteArrayOutputStream()
                body.byteStream().use { input ->
                    val buffer = ByteArray(16 * 1024)
                    while (true) {
                        val count = input.read(buffer);if (count < 0) break
                        if (!network.isOnline || network.isClosed || bytes.size() + count > MAX_MAP_RESOURCE_BYTES) return denied()
                        bytes.write(buffer, 0, count)
                    }
                }
                val type = if (url.path == "/planet/latest") "application/json" else mime(url.path.orEmpty())
                response(bytes.toByteArray(), type)
            }
        } catch (_: Exception) {if (network.isOnline && !network.isClosed) networkFailure();denied()}
        finally {calls.remove(call);networkPermits.release()}
    }

    fun close() {
        route = null;network.close()
    }
}

/** Restricted main-map host, separate from LocalLandscapeScene's fully
 * network-blocked document. The bridge exposes typed map commands only. */
@SuppressLint("SetJavaScriptEnabled")
@Suppress("DEPRECATION")
internal class CustomMapWebView(context: Context) : WebView(context) {
    var onReady: (() -> Unit)? = null
    var onCamera: ((JSONObject) -> Unit)? = null
    var onMarker: ((String) -> Unit)? = null
    var onFailure: ((String, Boolean) -> Unit)? = null
    var onOnlineFailure: (() -> Unit)? = null
    var onPosition: ((Boolean, Long?) -> Unit)? = null
    var onMapState: ((JSONObject) -> Unit)? = null
    var ready = false;private set
    var debugSnapshot: JSONObject? = null;private set
    var debugFixtureState: JSONObject? = null;private set
    var debugDrawCount = 0L;private set
    var debugLastDrawAt = 0L;private set
    private val debugReceipts = java.util.ArrayDeque<JSONObject>()
    private val debugTouchEvents = java.util.ArrayDeque<JSONObject>()
    private var debugSnapshotRequest = 0L
    private var debugSnapshotSentAt = 0L
    private val generation = serial.incrementAndGet()
    private val handler = Handler(Looper.getMainLooper())
    @Volatile private var disposed = false
    private var port: WebMessagePort? = null
    private var sequence = 0L
    private var routeVersion = 0L
    private var pageReady = false
    private var frameReady = false
    private var bridgeCreated = false
    private var active = true
    private var onlineEnabled = false
    private val queued = linkedMapOf<String, JSONObject>()
    private var allowedMarkerIds = emptySet<String>()
    private val brokerReference = AtomicReference<CustomMapResources?>()
    private val assetBroker get() = brokerReference.get()
    private val resourceLoader = Executors.newSingleThreadExecutor { task ->
        Thread(task, "tropnik-map-assets").apply { isDaemon = true }
    }
    private val timeout = Runnable {if (!ready && !disposed) fail("Карта не открылась. Карточки и источники доступны.")}

    init {
        contentDescription = "Карта России"
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = false
        settings.databaseEnabled = false
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.allowFileAccessFromFileURLs = false
        settings.allowUniversalAccessFromFileURLs = false
        settings.blockNetworkLoads = true
        settings.blockNetworkImage = false // Images are supplied only by the broker.
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.cacheMode = WebSettings.LOAD_NO_CACHE
        settings.setSupportMultipleWindows(false)
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setGeolocationEnabled(false)
        settings.mediaPlaybackRequiresUserGesture = true
        settings.displayZoomControls = false
        settings.builtInZoomControls = false
        isHorizontalScrollBarEnabled = false
        isVerticalScrollBarEnabled = false
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
        setNetworkAvailable(false)
        webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {request.deny()}
            override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: android.webkit.GeolocationPermissions.Callback?) {callback?.invoke(origin, false, false)}
        }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse = assetBroker?.intercept(request)
                ?: WebResourceResponse("text/plain", "UTF-8", 403, "Unavailable", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                if (url != CUSTOM_MAP_DOCUMENT) {view.stopLoading();fail("Карта попыталась открыть неизвестную страницу.")}
            }
            override fun onPageFinished(view: WebView, url: String?) {
                if (disposed || bridgeCreated || url != CUSTOM_MAP_DOCUMENT) return
                bridgeCreated = true
                val ports = createWebMessageChannel();port = ports[0]
                ports[0].setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
                    override fun onMessage(port: WebMessagePort, message: WebMessage?) {receive(message?.data)}
                }, handler)
                postWebMessage(WebMessage(JSONObject().put("type", "tropnik-map-port").put("version", 1).put("generation", generation).put("debug", BuildConfig.DEBUG).toString(), arrayOf(ports[1])), Uri.parse(CUSTOM_MAP_ORIGIN))
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) fail("Карта не загрузилась. Карточки и источники доступны.")
            }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                fail("Карта была остановлена системой. Её можно открыть снова.");release();return true
            }
        }
        handler.postDelayed(timeout, 20_000)
        // The manifest includes every map tile. Parse its registry off Main
        // before opening the document, so no request races an incomplete broker.
        resourceLoader.execute {
            runCatching {CustomMapResources(context) { handler.post { if (!disposed) onOnlineFailure?.invoke() } }}
                .onSuccess { broker ->
                    brokerReference.set(broker)
                    if (disposed) brokerReference.getAndSet(null)?.close()
                    else handler.post {
                        if (!disposed) {broker.setOnline(onlineEnabled);loadUrl(CUSTOM_MAP_DOCUMENT)}
                    }
                }.onFailure {handler.post {fail("Ресурсы карты не загрузились. Карточки и источники доступны.")}}
            resourceLoader.shutdown()
        }
    }

    private fun fail(message: String) {if (!disposed) {ready = false;handler.removeCallbacks(timeout);onFailure?.invoke(message, true)}}

    private fun receive(data: String?) {
        if (disposed || data == null) return
        if (data.length > 256 * 1024) {recordDebugReceipt(JSONObject().put("phase", "message-rejected").put("reason", "message-budget").put("chars", data.length));return}
        val message = runCatching {JSONObject(data)}.getOrNull() ?: return
        if (message.optInt("version") != 1 || message.optLong("generation") != generation) return
        val payload = message.optJSONObject("payload") ?: return
        when (message.optString("type")) {
            "ready" -> {
                pageReady = true
                queued.values.toList().also {queued.clear()}.forEach {send(it)}
                command("active", JSONObject().put("active", active));checkReady()
            }
            "frame" -> {frameReady = payload.optInt("frame") > 0 && payload.optInt("sourceTiles") > 0;checkReady()}
            "camera" -> onCamera?.invoke(payload)
            "marker" -> payload.optString("id").takeIf {it in allowedMarkerIds}?.let {onMarker?.invoke(it)}
            "state" -> onMapState?.invoke(payload)
            "position" -> onPosition?.invoke(payload.optBoolean("inside"), if (payload.has("measuredAt")) payload.optLong("measuredAt") else null)
            "snapshot" -> if (BuildConfig.DEBUG) {
                val requestId = payload.optLong("requestId")
                recordDebugReceipt(JSONObject().put("phase", "snapshot-received").put("requestId", requestId).put("chars", data.length))
                if (requestId == debugSnapshotRequest) debugSnapshot = payload.put("nativeRoundTripMs", SystemClock.uptimeMillis() - debugSnapshotSentAt)
            }
            "debugReceipt" -> recordDebugReceipt(payload)
            "fixture" -> if (BuildConfig.DEBUG) {
                val version = payload.optInt("version")
                if (payload.optString("status") != "ready") debugFixtureState = payload
                else postVisualStateCallback(version.toLong(), object : VisualStateCallback() {
                    override fun onComplete(requestId: Long) {
                        if (!disposed && debugFixtureState?.optInt("version") == version) debugFixtureState = payload
                    }
                })
            }
            "error" -> fail(payload.optString("message").take(240))
            "commandError" -> {recordDebugReceipt(JSONObject().put("phase", "command-error").put("payload", payload));onFailure?.invoke(payload.optString("message").take(240), false)}
        }
    }

    private fun recordDebugReceipt(value: JSONObject) {
        if (!BuildConfig.DEBUG) return
        if (debugReceipts.size == 16) debugReceipts.removeFirst()
        debugReceipts.addLast(value.put("nativeReceivedAt", SystemClock.uptimeMillis()))
    }

    fun debugDiagnostics(): JSONObject {
        check(BuildConfig.DEBUG && Looper.myLooper() == Looper.getMainLooper())
        return JSONObject().put("ready", ready).put("disposed", disposed).put("pageReady", pageReady).put("frameReady", frameReady)
            .put("snapshotRequest", debugSnapshotRequest).put("snapshotSentAt", debugSnapshotSentAt)
            .put("drawCount", debugDrawCount).put("lastDrawAt", debugLastDrawAt)
            .put("fixture", debugFixtureState).put("receipts", JSONArray(debugReceipts.toList()))
            .put("nativeTouchEvents", JSONArray(debugTouchEvents.toList())).put("lastSnapshot", debugSnapshot)
    }

    private fun checkReady() {
        if (!pageReady || !frameReady || disposed || ready) return
        postVisualStateCallback(generation, object : VisualStateCallback() {
            override fun onComplete(requestId: Long) {
                if (disposed || ready || !pageReady || !frameReady) return
                ready = true;handler.removeCallbacks(timeout);onReady?.invoke()
            }
        })
    }

    private fun send(value: JSONObject) {
        if (!disposed) port?.postMessage(WebMessage(value.put("version", 1).put("generation", generation).put("sequence", ++sequence).toString()))
    }

    fun command(type: String, payload: JSONObject = JSONObject()) {
        check(Looper.myLooper() == Looper.getMainLooper()) { "Map commands belong to the main thread" }
        if (disposed || ((!BuildConfig.DEBUG) && type in setOf("snapshot", "labelFixture"))) return
        val value = JSONObject().put("type", type).put("payload", payload)
        if (pageReady) send(value) else {
            // State commands replace older state while the document loads.
            // They never accumulate route geometry or replay user gestures.
            if (queued.size < 32 || queued.containsKey(type)) queued[type] = value
        }
    }

    fun setMarkers(markers: JSONArray) {
        allowedMarkerIds = (0 until markers.length()).map {markers.getJSONObject(it).getString("id")}.toSet()
        command("markers", JSONObject().put("markers", markers))
    }

    fun setRoute(id: String?, geometry: ByteArray?) {
        val version = ++routeVersion
        val url = geometry?.let {"$CUSTOM_MAP_ORIGIN/native-route/$generation-$version.geojson"}
        assetBroker?.setRoute(url, geometry)
        command("route", JSONObject().put("version", version).put("id", id).put("url", url))
    }

    fun setOnline(enabled: Boolean) {onlineEnabled = enabled;assetBroker?.setOnline(enabled);setNetworkAvailable(enabled);command("network", JSONObject().put("enabled", enabled))}
    fun setActive(enabled: Boolean) {
        active = enabled
        handler.removeCallbacks(timeout)
        if (enabled && !ready && !disposed) handler.postDelayed(timeout, 20_000)
        if (enabled) onResume()
        command("active", JSONObject().put("active", enabled))
        if (!enabled) onPause()
    }
    fun requestDebugSnapshot(): Long {
        check(BuildConfig.DEBUG)
        debugSnapshotSentAt = SystemClock.uptimeMillis()
        val request = ++debugSnapshotRequest
        command("snapshot", JSONObject().put("requestId", request))
        return request
    }

    override fun onDraw(canvas: android.graphics.Canvas) {
        super.onDraw(canvas)
        if (BuildConfig.DEBUG) {debugDrawCount++;debugLastDrawAt = SystemClock.uptimeMillis()}
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        // A map gesture owns its stream, including a second finger. Native
        // catalogue scrolling remains available outside this view.
        if (event.actionMasked == MotionEvent.ACTION_DOWN) parent?.requestDisallowInterceptTouchEvent(true)
        val diagnostic = if (BuildConfig.DEBUG && event.actionMasked in setOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL)) {
            JSONObject().put("action", event.actionMasked).put("x", event.x.toDouble()).put("y", event.y.toDouble())
                .put("eventTime", event.eventTime).put("downTime", event.downTime).put("receivedAt", SystemClock.uptimeMillis())
        } else null
        val handled = super.onTouchEvent(event)
        if (diagnostic != null) {
            if (debugTouchEvents.size == 12) debugTouchEvents.removeFirst()
            debugTouchEvents.addLast(diagnostic.put("handled", handled))
        }
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            parent?.requestDisallowInterceptTouchEvent(false)
        }
        return handled
    }

    fun release() {
        if (disposed) return
        command("destroy");disposed = true;ready = false;handler.removeCallbacksAndMessages(null)
        queued.clear();allowedMarkerIds = emptySet();port?.close();port = null
        resourceLoader.shutdownNow();brokerReference.getAndSet(null)?.close()
        stopLoading();onPause();(parent as? ViewGroup)?.removeView(this);removeAllViews();destroy()
        onReady = null;onCamera = null;onMarker = null;onFailure = null;onOnlineFailure = null;onPosition = null;onMapState = null
    }

    companion object {private val serial = AtomicLong()}
}
