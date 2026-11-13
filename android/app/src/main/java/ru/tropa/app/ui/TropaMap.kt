package ru.tropa.app.ui

import android.app.ActivityManager
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.Surface
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.produceState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import ru.tropa.app.data.PositionState
import ru.tropa.app.data.ConnectionState
import ru.tropa.app.data.canUseOnlineMap
import ru.tropa.app.data.Region
import ru.tropa.app.data.TrailRoute
import ru.tropa.app.data.prepareMapRouteGeometry
import ru.tropa.app.data.MapCameraCheckpoint

private const val ROUTE_GEOMETRY_ERROR = "Линия маршрута не загрузилась. Карточка и обзорная карта доступны."

@Composable
fun TropaMap(
    regions: List<Region>,
    selected: Region?,
    route: TrailRoute? = null,
    position: PositionState = PositionState.Idle,
    connection: ConnectionState = ConnectionState.OFFLINE,
    onSelectRegion: ((String) -> Unit)? = null,
    visibleTrails: List<TrailRoute> = emptyList(),
    onSelectTrail: ((String) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var retry by remember { mutableStateOf(0) }
    val mapView = remember(context, retry) { CustomMapWebView(context) }
    var mapReady by remember(mapView) { mutableStateOf(false) }
    var error by remember(mapView) { mutableStateOf<String?>(null) }
    var fatal by remember(mapView) { mutableStateOf(false) }
    var onlineRequested by remember { mutableStateOf(true) }
    var onlineFailed by remember { mutableStateOf(false) }
    // One missing provider tile must not disable all remote sources. The shared
    // renderer owns completeness, retained frames and its explicit retry state.
    val onlineMode = canUseOnlineMap(connection, onlineRequested, failed = false)
    val currentOnlineMode by rememberUpdatedState(onlineMode)
    var lastFittedFocus by remember(mapView) { mutableStateOf<String?>(null) }
    // A restarted renderer must resume the last completed view. The same GPS
    // fix must not immediately override that recovered viewport.
    var cameraCheckpoint by remember { mutableStateOf<MapCameraCheckpoint?>(null) }
    var lastPositionTime by remember { mutableStateOf<Long?>(null) }
    var mode by remember { mutableStateOf("detail") }
    var paths by remember { mutableStateOf(true) }
    var committedMode by remember(mapView) { mutableStateOf("detail") }
    var effectiveOnline by remember(mapView) { mutableStateOf(false) }
    var imagerySource by remember(mapView) { mutableStateOf("") }
    var loading by remember(mapView) { mutableStateOf(false) }
    var mapError by remember(mapView) { mutableStateOf<String?>(null) }
    var overlayError by remember(mapView) { mutableStateOf<String?>(null) }
    var rasterError by remember(mapView) { mutableStateOf<String?>(null) }
    var routeAttempt by remember(mapView) { mutableStateOf(0) }
    var dismissedError by remember(mapView) { mutableStateOf<String?>(null) }
    var eco by remember { mutableStateOf(context.getSystemService(ActivityManager::class.java)?.isLowRamDevice == true) }
    var rotated by remember(mapView) { mutableStateOf(false) }
    var showAttribution by remember { mutableStateOf(false) }
    var scopeNotice by remember(mapView) { mutableStateOf<String?>(null) }
    var scopeError by remember(mapView) { mutableStateOf<String?>(null) }
    val selectRegion by rememberUpdatedState(onSelectRegion)
    val selectTrail by rememberUpdatedState(onSelectTrail)
    val visibleTrailIds = remember(visibleTrails) { visibleTrails.filterNot { it.illustrative }.map { it.id } }
    val sourceText = remember(context) { context.assets.open("SOURCES.txt").bufferedReader().use { it.readText() } }
    val countryBounds by produceState<JSONArray?>(null, context) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                val metadata = JSONObject(context.assets.open("maps/russia/russia-boundaries-provenance.json").bufferedReader().use { it.readText() })
                require(metadata.getJSONObject("validation").getBoolean("passed"))
                val bounds = metadata.getJSONArray("fitBounds")
                JSONArray(listOf(bounds.getJSONArray(0).getDouble(0), bounds.getJSONArray(0).getDouble(1), bounds.getJSONArray(1).getDouble(0), bounds.getJSONArray(1).getDouble(1)))
            }.getOrNull()
        }
        if (value == null) scopeError = "Обзорная область карты недоступна. Карточки и источники доступны ниже."
    }

    DisposableEffect(lifecycle, mapView) {
        mapView.onReady = { mapReady = true; fatal = false }
        mapView.onFailure = { message, terminal -> error = message;fatal = terminal;if (terminal) mapReady = false }
        mapView.onOnlineFailure = { if (currentOnlineMode) onlineFailed = true }
        mapView.onMarker = { id -> selectRegion?.invoke(id) }
        mapView.onTrail = { id -> selectTrail?.invoke(id) }
        mapView.onOverlayError = { overlayError = it.takeIf(String::isNotBlank) }
        mapView.onRasterError = { rasterError = it.takeIf(String::isNotBlank) }
        mapView.onMapState = { state ->
            effectiveOnline = state.optBoolean("online")
            committedMode = state.optString("committedMode", "detail")
            imagerySource = state.optString("imagerySource", "")
            loading = state.optBoolean("loading") || state.optBoolean("imageryLoading")
            mapError = state.optString("error").takeIf(String::isNotBlank)
            if (!loading && mapError == null) onlineFailed = false
        }
        mapView.onCamera = { state ->
            val camera = state.optJSONObject("camera")
            if (camera != null) {
                val focus = lastFittedFocus
                if (mapReady && focus != null) MapCameraCheckpoint.capture(focus, camera)?.let { cameraCheckpoint = it }
                rotated = kotlin.math.abs(camera.optDouble("bearingDegrees", 0.0)) > 1.0
            }
        }
        mapView.onPosition = { inside, time ->
            scopeNotice = if (!inside && time != null) "Геопозиция получена. Точка находится вне области карты России." else null
            if (inside) lastPositionTime = time
        }
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> mapView.setActive(true)
                Lifecycle.Event.ON_PAUSE, Lifecycle.Event.ON_STOP -> mapView.setActive(false)
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        mapView.setActive(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        onDispose {lifecycle.removeObserver(observer);mapView.release()}
    }
    LaunchedEffect(connection) { if (connection == ConnectionState.ONLINE) onlineFailed = false }
    LaunchedEffect(mapView, onlineMode) { mapView.setOnline(onlineMode) }
    LaunchedEffect(mapView, eco) { mapView.command("eco", JSONObject().put("enabled", eco)) }
    LaunchedEffect(mapView, mode) { mapView.command("mode", JSONObject().put("mode", mode)) }
    LaunchedEffect(mapView, paths) { mapView.command("layers", JSONObject().put("relief", true).put("paths", paths)) }
    LaunchedEffect(mapView, visibleTrailIds) { mapView.setCatalogue(visibleTrailIds) }

    // Changing catalogue mode changes only the points. It neither reloads the
    // full route nor moves the camera, including while a native card is open.
    LaunchedEffect(mapView, regions, selected?.id) {
        mapView.setMarkers(JSONArray(regions.map { region ->
            JSONObject().put("id", region.id).put("label", region.name).put("kind", "direction")
                .put("coordinate", JSONArray(listOf(region.longitude, region.latitude))).put("active", region.id == selected?.id)
        }))
    }
    LaunchedEffect(mapView, mapReady, countryBounds, selected?.id, route?.id, route?.apiRevisionId, route?.geometryAsset, route?.inlineGeometry, routeAttempt) {
        if (!mapReady) return@LaunchedEffect
        val bounds = countryBounds ?: return@LaunchedEffect
        // A new card must not retain the previous line during native asset I/O.
        withContext(Dispatchers.Main.immediate) { mapView.setRoute(route?.id, null) }
        val geometry = route?.inlineGeometry ?: route?.geometryAsset?.let { asset ->
            withContext(Dispatchers.IO) {runCatching {context.assets.open(asset).bufferedReader().use {it.readText()}}.getOrNull()}
        }
        val prepared = geometry?.let { json -> withContext(Dispatchers.Default) {runCatching {prepareMapRouteGeometry(json)}} }
        val routeData = prepared?.getOrNull()
        // The Compose test frame interceptor can resume an IO continuation on
        // its worker. The WebView commit always selects Android Main explicitly.
        withContext(Dispatchers.Main.immediate) {
            mapView.setRoute(route?.id, routeData?.utf8)
            if (prepared?.isFailure == true || (route?.geometryAsset != null && geometry == null)) error = ROUTE_GEOMETRY_ERROR
            else if (error == ROUTE_GEOMETRY_ERROR) error = null
            val focusKey = "${selected?.id}:${route?.id}"
            if (lastFittedFocus == focusKey) return@withContext
            lastFittedFocus = focusKey
            scopeNotice = null
            val restored = cameraCheckpoint?.cameraFor(focusKey)
            when {
                restored != null -> mapView.command("camera", JSONObject().put("camera", restored).put("animate", false))
                routeData?.frame != null -> {
                    val frame = routeData.frame
                    mapView.command("fit", JSONObject().put("bounds", JSONArray(listOf(frame.west, frame.south, frame.east, frame.north))).put("padding", 52).put("maxZoom", 17).put("animate", true))
                }
                selected != null -> mapView.command("camera", JSONObject().put("camera", JSONObject().put("center", JSONArray(listOf(selected.longitude, selected.latitude))).put("zoom", selected.zoom)).put("animate", true))
                else -> mapView.command("fit", JSONObject().put("bounds", bounds).put("padding", 24).put("maxZoom", 17).put("animate", true))
            }
        }
    }
    LaunchedEffect(mapView, mapReady, position) {
        if (!mapReady) return@LaunchedEffect
        val ready = position as? PositionState.Ready
        val point = ready?.fix
        mapView.command("position", JSONObject().put("coordinate", point?.let {JSONArray(listOf(it.longitude, it.latitude))} ?: JSONObject.NULL)
            .put("measuredAt", point?.measuredAt).put("recenter", point != null && lastPositionTime != point.measuredAt))
    }

    Box(modifier.background(Palette.Water)) {
        key(mapView) { AndroidView(factory = { mapView }, modifier = Modifier.fillMaxSize()) }
        // Expected remote-detail failures in offline mode are described by the
        // availability label. Local route/overlay and terminal errors remain
        // actionable; they must not be hidden as a connectivity notice.
        val candidate = error ?: scopeError ?: mapError?.takeIf { effectiveOnline || !mapReady } ?: overlayError ?: rasterError
        val problem = candidate?.takeIf { fatal || it != dismissedError }
        if ((!mapReady || countryBounds == null) && problem == null) Text("Открываем карту России…", Modifier.align(Alignment.Center).background(Palette.Surface).padding(12.dp), style = MaterialTheme.typography.bodyMedium)
        problem?.let { message ->
            Column(Modifier.align(Alignment.Center).padding(16.dp).background(Palette.Surface), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(message, Modifier.padding(12.dp), color = Palette.Alert)
                if (fatal) TrailTextButton(onClick = { retry += 1 }) { Text("Открыть карту снова") }
                else TrailTextButton(onClick = {
                    error = null;dismissedError = null;onlineFailed = false;routeAttempt += 1;mapView.command("retry")
                }, Modifier.testTag("map_retry")) { Text("Повторить загрузку") }
                if (!fatal && mapReady) TrailTextButton(onClick = { dismissedError = message }) { Text("Закрыть") }
            }
        }
        scopeNotice?.let { Text(it, Modifier.align(Alignment.Center).background(Palette.Surface).padding(12.dp), style = MaterialTheme.typography.bodySmall, color = Palette.Muted) }
        if (mapReady) {
            Surface(Modifier.align(Alignment.CenterEnd).padding(end = 8.dp), color = Palette.Surface, shape = RoundedCornerShape(12.dp)) {
                Column {
                    TrailIconButton(onClick = { mapView.command("zoom", JSONObject().put("delta", 1)) }) { TropaIcon(Glyph.ZOOM_IN, description = "Приблизить карту") }
                    TrailIconButton(onClick = { mapView.command("zoom", JSONObject().put("delta", -1)) }) { TropaIcon(Glyph.ZOOM_OUT, description = "Отдалить карту") }
                    if (rotated) TrailTextButton(onClick = { mapView.command("north") }) { Text("Север") }
                }
            }
            Text(when {
                loading && mode == "satellite" && effectiveOnline -> "Загружаем спутниковые снимки…"
                committedMode == "satellite" -> if (imagerySource == "eox-bluemarble") "Спутник · Blue Marble" else "Спутник · EOX Sentinel"
                loading && effectiveOnline -> "Загружаем рельеф…"
                !effectiveOnline -> if (committedMode == "detail") "Сохранённый рельеф" else "Обзор без интернета"
                onlineFailed -> "Часть карты недоступна"
                onlineMode -> "Рельеф"
                else -> "Обзор без интернета"
            }, Modifier.align(Alignment.BottomCenter).padding(bottom = 104.dp).background(Palette.Surface.copy(alpha = .96f)).padding(horizontal = 8.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelSmall, color = Palette.Muted)
            Row(Modifier.align(Alignment.BottomCenter).padding(bottom = 50.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TrailChoice(selected = mode == "detail", onClick = { mode = "detail" },
                    label = { Text("Рельеф") }, modifier = Modifier.heightIn(min = 48.dp).testTag("map_relief"))
                TrailChoice(selected = mode == "satellite", onClick = { onlineFailed = false;onlineRequested = true;mode = "satellite" },
                    enabled = connection == ConnectionState.ONLINE, label = { Text("Спутник") }, modifier = Modifier.heightIn(min = 48.dp).testTag("map_satellite"))
                TrailChoice(selected = paths, onClick = { paths = !paths }, label = { Text("Тропы") }, modifier = Modifier.heightIn(min = 48.dp).testTag("map_paths"))
                TrailChoice(selected = onlineMode, onClick = { onlineFailed = false;onlineRequested = !onlineRequested },
                    enabled = connection == ConnectionState.ONLINE, label = { Text("Сеть") }, modifier = Modifier.heightIn(min = 48.dp))
                TrailChoice(selected = eco, onClick = { eco = !eco }, label = { Text("Беречь заряд") }, modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        Surface(Modifier.align(Alignment.BottomStart), color = Palette.Surface.copy(alpha = .96f), shape = RoundedCornerShape(topEnd = 12.dp)) {
            Row(Modifier.padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (committedMode == "satellite") if (imagerySource == "eox-bluemarble") "© OSM · NASA Blue Marble · EOX" else "© OSM · EOX · Sentinel · CC BY 4.0" else "© OpenStreetMap contributors",
                    Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelSmall, color = Palette.Muted)
                Spacer(Modifier.width(4.dp))
                TrailIconButton(onClick = { showAttribution = true }) { TropaIcon(Glyph.INFO, description = "Источники карты и рельефа") }
            }
        }
    }
    if (showAttribution) TrailDialog(onDismissRequest = { showAttribution = false },
        title = { Text("Источники карты и рельефа") },
        text = { LazyColumn { item { Text(sourceText, style = MaterialTheme.typography.bodySmall) }
            item { TrailTextButton(onClick = {
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.openstreetmap.org/copyright"))) }
            }) { Text("Условия использования данных карты") } }
        } },
        confirmButton = { TrailTextButton(onClick = { showAttribution = false }) { Text("Понятно") } })
}
