package ru.tropa.app.ui

import android.app.ActivityManager
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.produceState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.onSizeChanged
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

private const val ROUTE_GEOMETRY_ERROR = "Линия маршрута не загрузилась. Карточка и обзорная карта доступны."

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun TropaMap(
    regions: List<Region>,
    selected: Region?,
    route: TrailRoute? = null,
    position: PositionState = PositionState.Idle,
    connection: ConnectionState = ConnectionState.OFFLINE,
    onSelectRegion: ((String) -> Unit)? = null,
    visibleTrails: List<TrailRoute> = emptyList(),
    onSelectTrail: ((String) -> Unit)? = null,
    active: Boolean = true,
    presentation: MapPresentationState? = null,
    focusScope: String = "EXPLORE",
    onLocation: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val density = LocalDensity.current
    var outerHeightDp by remember { mutableFloatStateOf(0f) }
    var viewportHeightDp by remember { mutableFloatStateOf(0f) }
    val viewportReady = viewportHeightDp > 0f
    val compactControls = outerHeightDp < 400f || density.fontScale >= 1.6f
    var retry by remember { mutableStateOf(0) }
    val mapView = remember(context, retry) { CustomMapWebView(context) }
    var mapReady by remember(mapView) { mutableStateOf(false) }
    var error by remember(mapView) { mutableStateOf<String?>(null) }
    var fatal by remember(mapView) { mutableStateOf(false) }
    val session = presentation ?: remember { MapPresentationState(context.getSystemService(ActivityManager::class.java)?.isLowRamDevice == true) }
    val onlineRequested = session.onlineRequested
    var onlineFailed by remember { mutableStateOf(false) }
    // One missing provider tile must not disable all remote sources. The shared
    // renderer owns completeness, retained frames and its explicit retry state.
    val onlineMode = canUseOnlineMap(connection, onlineRequested, failed = false)
    val currentOnlineMode by rememberUpdatedState(onlineMode)
    var lastFittedFocus by remember(mapView) { mutableStateOf<String?>(null) }
    // A restarted renderer must resume the last completed view. The same GPS
    // fix must not immediately override that recovered viewport.
    var lastPositionTime by remember { mutableStateOf<Long?>(null) }
    val mode = session.mode
    val paths = session.paths
    var committedMode by remember(mapView) { mutableStateOf("detail") }
    var effectiveOnline by remember(mapView) { mutableStateOf(false) }
    var imagerySource by remember(mapView) { mutableStateOf("") }
    var loading by remember(mapView) { mutableStateOf(false) }
    var mapError by remember(mapView) { mutableStateOf<String?>(null) }
    var overlayError by remember(mapView) { mutableStateOf<String?>(null) }
    var rasterError by remember(mapView) { mutableStateOf<String?>(null) }
    var routeAttempt by remember(mapView) { mutableStateOf(0) }
    var dismissedError by remember(mapView) { mutableStateOf<String?>(null) }
    val eco = session.eco
    var rotated by remember(mapView) { mutableStateOf(false) }
    var showAttribution by remember { mutableStateOf(false) }
    var showLayers by remember { mutableStateOf(false) }
    val currentActive by rememberUpdatedState(active)
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
                if (currentActive && mapReady && focus != null) session.rememberCamera(focus, camera)
                rotated = kotlin.math.abs(camera.optDouble("bearingDegrees", 0.0)) > 1.0
            }
        }
        mapView.onPosition = { inside, time ->
            scopeNotice = if (!inside && time != null) "Геопозиция получена. Точка находится вне области карты России." else null
            if (inside) lastPositionTime = time
        }
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> mapView.setActive(currentActive)
                Lifecycle.Event.ON_PAUSE, Lifecycle.Event.ON_STOP -> mapView.setActive(false)
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        mapView.setActive(active && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        onDispose {lifecycle.removeObserver(observer);mapView.release()}
    }
    LaunchedEffect(mapView, active) {
        mapView.importantForAccessibility = if (active) android.view.View.IMPORTANT_FOR_ACCESSIBILITY_AUTO else android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        mapView.isEnabled = active
        mapView.setActive(active && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        if (!active) { showLayers = false; showAttribution = false }
    }
    LaunchedEffect(connection) { if (connection == ConnectionState.ONLINE) onlineFailed = false }
    LaunchedEffect(mapView, onlineMode, active) { mapView.setOnline(onlineMode && active) }
    LaunchedEffect(mapView, eco) { mapView.command("eco", JSONObject().put("enabled", eco)) }
    LaunchedEffect(mapView, mode) { mapView.command("mode", JSONObject().put("mode", mode)) }
    LaunchedEffect(mapView, paths) { mapView.command("layers", JSONObject().put("relief", true).put("paths", paths)) }
    LaunchedEffect(mapView, visibleTrailIds, active) { if (active) mapView.setCatalogue(visibleTrailIds) }

    // Changing catalogue mode changes only the points. It neither reloads the
    // full route nor moves the camera, including while a native card is open.
    LaunchedEffect(mapView, regions, selected?.id, active) {
        if (!active) return@LaunchedEffect
        mapView.setMarkers(JSONArray(regions.map { region ->
            JSONObject().put("id", region.id).put("label", region.name).put("kind", "direction")
                .put("coordinate", JSONArray(listOf(region.longitude, region.latitude))).put("active", region.id == selected?.id)
        }))
    }
    LaunchedEffect(mapView, mapReady, active, viewportReady, countryBounds, focusScope, selected?.id, route?.id, route?.apiRevisionId, route?.geometryAsset, route?.inlineGeometry, routeAttempt) {
        if (!mapReady || !active || !viewportReady) return@LaunchedEffect
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
            val fitPadding = (viewportHeightDp / 4f).toInt().coerceIn(4, 48)
            val focusKey = "$focusScope:${selected?.id}:${route?.id}"
            if (lastFittedFocus == focusKey) return@withContext
            lastFittedFocus = focusKey
            scopeNotice = null
            val restored = session.cameraFor(focusKey)
            when {
                restored != null -> mapView.command("camera", JSONObject().put("camera", restored).put("animate", false))
                routeData?.frame != null -> {
                    val frame = routeData.frame
                    mapView.command("fit", JSONObject().put("bounds", JSONArray(listOf(frame.west, frame.south, frame.east, frame.north))).put("padding", fitPadding).put("maxZoom", 17).put("animate", true))
                }
                selected != null -> mapView.command("camera", JSONObject().put("camera", JSONObject().put("center", JSONArray(listOf(selected.longitude, selected.latitude))).put("zoom", selected.zoom)).put("animate", true))
                else -> mapView.command("fit", JSONObject().put("bounds", bounds).put("padding", fitPadding).put("maxZoom", 17).put("animate", true))
            }
        }
    }
    LaunchedEffect(mapView, mapReady, active, position) {
        if (!mapReady || !active) return@LaunchedEffect
        val ready = position as? PositionState.Ready
        val point = ready?.fix
        mapView.command("position", JSONObject().put("coordinate", point?.let {JSONArray(listOf(it.longitude, it.latitude))} ?: JSONObject.NULL)
            .put("measuredAt", point?.measuredAt).put("recenter", point != null && lastPositionTime != point.measuredAt))
    }

    // Controls own layout space. The WebView receives exactly the unobscured
    // rectangle, including on short landscape screens and with larger text.
    val candidate = error ?: scopeError ?: mapError?.takeIf { effectiveOnline || !mapReady } ?: overlayError ?: rasterError
    val problem = candidate?.takeIf { fatal || it != dismissedError }
    LaunchedEffect(problem) { if (problem != null) showLayers = false }
    Column(modifier.background(Palette.Water).onSizeChanged { outerHeightDp = it.height / density.density }) {
        if (active && problem == null && !compactControls) {
            FlowRow(Modifier.fillMaxWidth().background(Palette.Surface).padding(horizontal = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TrailChoice(selected = mode == "detail", onClick = { session.mode = "detail" },
                    label = { Text("Рельеф") }, enabled = mapReady, modifier = Modifier.testTag("map_relief"))
                TrailChoice(selected = mode == "satellite", onClick = {
                    onlineFailed = false; session.onlineRequested = true; session.mode = "satellite"
                }, enabled = mapReady && connection == ConnectionState.ONLINE, label = { Text("Спутник") },
                    modifier = Modifier.testTag("map_satellite"))
            }
        }
        Box(Modifier.fillMaxWidth().weight(1f)) {
            key(mapView) { AndroidView(factory = { mapView }, modifier = Modifier.fillMaxSize().testTag("map_canvas")
                .onSizeChanged { viewportHeightDp = it.height / density.density }) }
            if ((!mapReady || countryBounds == null) && problem == null && active)
                Text("Открываем карту России…", Modifier.align(Alignment.Center).background(Palette.Surface).padding(12.dp),
                    style = MaterialTheme.typography.bodyMedium)
            if (active && problem == null) scopeNotice?.let { Text(it, Modifier.align(Alignment.Center)
                .background(Palette.Surface).padding(12.dp), style = MaterialTheme.typography.bodySmall, color = Palette.Muted) }
            if (active && problem != null) {
                Surface(Modifier.fillMaxSize().testTag("map_error_panel"), color = Palette.Surface, shape = RoundedCornerShape(8.dp)) {
                    Column(Modifier.fillMaxSize()) {
                        Text(problem, Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(12.dp),
                            color = Palette.Alert, style = MaterialTheme.typography.bodyMedium)
                        FlowRow(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (fatal) TrailTextButton(onClick = { retry += 1 }, Modifier.testTag("map_reopen")) { Text("Открыть карту снова") }
                            else TrailTextButton(onClick = {
                                error = null; dismissedError = null; onlineFailed = false; routeAttempt += 1; mapView.command("retry")
                            }, Modifier.testTag("map_retry")) { Text("Повторить загрузку") }
                            if (!fatal && mapReady) TrailTextButton(onClick = { dismissedError = problem },
                                Modifier.testTag("map_error_close")) { Text("Закрыть") }
                        }
                    }
                }
            }
        }
        if (active) {
            FlowRow(Modifier.fillMaxWidth().background(Palette.Surface).padding(horizontal = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (problem == null) {
                    TrailIconButton(onClick = { showLayers = true }, Modifier.testTag("map_layers"), enabled = mapReady) {
                        TropaIcon(Glyph.MAP, description = if (mode == "satellite") "Слои карты. Сейчас спутник" else "Слои карты. Сейчас рельеф")
                    }
                    TrailIconButton(onClick = { mapView.command("zoom", JSONObject().put("delta", 1)) }, modifier = Modifier.testTag("map_zoom_in"), enabled = mapReady) {
                        TropaIcon(Glyph.ZOOM_IN, description = "Приблизить карту")
                    }
                    TrailIconButton(onClick = { mapView.command("zoom", JSONObject().put("delta", -1)) }, modifier = Modifier.testTag("map_zoom_out"), enabled = mapReady) {
                        TropaIcon(Glyph.ZOOM_OUT, description = "Отдалить карту")
                    }
                    if (onLocation != null) TrailIconButton(onClick = onLocation, enabled = mapReady && position != PositionState.Locating,
                        modifier = Modifier.testTag("locate")) { TropaIcon(Glyph.LOCATE, description = "Показать моё местоположение") }
                }
                TrailIconButton(onClick = { showAttribution = true }, modifier = Modifier.testTag("map_sources")) {
                    TropaIcon(Glyph.INFO, description = "Источники карты и рельефа")
                }
            }
            val status = when {
                loading && mode == "satellite" && effectiveOnline -> "Загружаем снимки…"
                loading && effectiveOnline -> "Загружаем рельеф…"
                !effectiveOnline -> "Обзор и линии без сети"
                onlineFailed -> "Часть карты недоступна"
                else -> null
            }
            Column(Modifier.fillMaxWidth().background(Palette.Surface).padding(horizontal = 8.dp, vertical = 4.dp)) {
                if (status != null && !compactControls && problem == null) Text(status, style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                Text(if (committedMode == "satellite") if (imagerySource == "eox-bluemarble") "© OSM · NASA Blue Marble · EOX"
                    else "© OSM · EOX · Sentinel · CC BY 4.0" else "© OpenStreetMap", Modifier.testTag("map_credits"),
                    style = MaterialTheme.typography.labelSmall, color = Palette.Muted)
            }
        }
    }
    if (showLayers && active) ModalBottomSheet(onDismissRequest = { showLayers = false },
        containerColor = Palette.Surface) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Слои карты", style = MaterialTheme.typography.titleLarge)
            if (compactControls) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TrailChoice(selected = mode == "detail", onClick = { session.mode = "detail" },
                    label = { Text("Рельеф") }, enabled = mapReady, modifier = Modifier.testTag("map_relief"))
                TrailChoice(selected = mode == "satellite", onClick = { onlineFailed = false; session.onlineRequested = true; session.mode = "satellite" },
                    enabled = mapReady && connection == ConnectionState.ONLINE, label = { Text("Спутник") }, modifier = Modifier.testTag("map_satellite"))
            }
            if (rotated) TrailOutlineButton(onClick = { mapView.command("north") }, modifier = Modifier.fillMaxWidth()) { Text("Вернуть север наверх") }

            TrailChoice(selected = paths, onClick = { session.paths = !session.paths },
                label = { Text("Тропы") }, modifier = Modifier.fillMaxWidth().testTag("map_paths"))
            TrailChoice(selected = onlineMode, onClick = { onlineFailed = false; session.onlineRequested = !session.onlineRequested },
                enabled = connection == ConnectionState.ONLINE, label = { Text("Загружать подробную карту") },
                modifier = Modifier.fillMaxWidth().testTag("map_network"))
            TrailChoice(selected = eco, onClick = { session.eco = !session.eco },
                label = { Text("Беречь заряд") }, modifier = Modifier.fillMaxWidth().testTag("map_eco"))
            Text(if (connection == ConnectionState.ONLINE) "Спутниковые снимки и подробная карта загружаются по сети."
                else "Сейчас доступны встроенный обзор и сохранённые линии. Для снимков и подробной карты нужна сеть.",
                style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
            TrailButton(onClick = { showLayers = false }, modifier = Modifier.fillMaxWidth().testTag("map_layers_done")) { Text("Готово") }
        }
    }
    if (showAttribution && active) TrailDialog(onDismissRequest = { showAttribution = false },
        title = { Text("Источники карты и рельефа") },
        text = { LazyColumn { item { Text(sourceText, style = MaterialTheme.typography.bodySmall) }
            item { TrailTextButton(onClick = {
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.openstreetmap.org/copyright"))) }
            }) { Text("Условия использования данных карты") } }
        } },
        confirmButton = { TrailTextButton(onClick = { showAttribution = false }) { Text("Понятно") } })
}
