package ru.tropa.app.ui

import android.os.Bundle
import android.app.ActivityManager
import android.graphics.RectF
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.produceState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.geometry.LatLngBounds
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.android.style.layers.Property
import org.maplibre.android.style.layers.PropertyFactory
import ru.tropa.app.data.PositionState
import ru.tropa.app.data.ConnectionState
import ru.tropa.app.data.canUseOnlineMap
import ru.tropa.app.data.mapStyleForConnection
import ru.tropa.app.data.withMapLabelCoverage
import ru.tropa.app.data.MapLabelGroup
import ru.tropa.app.data.MapCoverage
import ru.tropa.app.data.MapLabelGeometry
import org.maplibre.geojson.Point
import ru.tropa.app.data.Region
import ru.tropa.app.data.RussiaDisplayArea
import ru.tropa.app.data.TrailRoute
import ru.tropa.app.data.prepareMapRouteGeometry
import ru.tropa.app.TropaApplication

private const val ROUTE_GEOMETRY_ERROR = "Линия маршрута не загрузилась. Карточка и обзорная карта доступны."

@Composable
fun TropaMap(
    regions: List<Region>,
    selected: Region?,
    route: TrailRoute? = null,
    position: PositionState = PositionState.Idle,
    connection: ConnectionState = ConnectionState.OFFLINE,
    onSelectRegion: ((String) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val application = context.applicationContext as TropaApplication
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val mapView = remember { MapView(context).apply { onCreate(Bundle()) } }
    var map by remember { mutableStateOf<MapLibreMap?>(null) }
    var styleRevision by remember { mutableStateOf(0) }
    var styleGeneration by remember { mutableStateOf(0) }
    var styleLoading by remember { mutableStateOf(true) }
    var labelGroups by remember { mutableStateOf<List<MapLabelGroup>>(emptyList()) }
    var onlineRequested by remember { mutableStateOf(true) }
    var onlineFailed by remember { mutableStateOf(false) }
    val onlineMode = canUseOnlineMap(connection, onlineRequested, onlineFailed)
    val currentOnlineMode by rememberUpdatedState(onlineMode)
    var lastFittedFocus by remember { mutableStateOf<String?>(null) }
    var lastPositionTime by remember { mutableStateOf<Long?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var relief by remember { mutableStateOf(true) }
    var eco by remember { mutableStateOf(context.getSystemService(ActivityManager::class.java)?.isLowRamDevice == true) }
    var zoom by remember { mutableStateOf(2.1) }
    var tilted by remember { mutableStateOf(false) }
    var reliefArea by remember { mutableStateOf(false) }
    var showAttribution by remember { mutableStateOf(false) }
    var scopeNotice by remember { mutableStateOf<String?>(null) }
    var scopeError by remember { mutableStateOf<String?>(null) }
    val sourceText = remember(context) { context.assets.open("SOURCES.txt").bufferedReader().use { it.readText() } }
    val rawStyle by produceState<String?>(null, context) {
        value = withContext(Dispatchers.IO) {
            runCatching { context.assets.open("maps/style.json").bufferedReader().use { it.readText() } }.getOrNull()
        }
        if (value == null) error = "Карта не загрузилась. Карточки и источники доступны ниже."
    }
    val displayArea by produceState<RussiaDisplayArea?>(null, application) {
        val result = withContext(mapCoverageWorker) {
            runCatching { application.mapDisplayArea }
        }
        value = result.getOrNull()
        if (result.isFailure) scopeError = "Обзорная область карты недоступна. Карточки и источники доступны ниже."
    }
    val currentDisplayArea by rememberUpdatedState(displayArea)
    val coverageAssets by produceState<MapCoverage?>(null, application) {
        value = withContext(mapCoverageWorker) { runCatching { application.mapCoverage }.getOrNull() }
    }
    var activeCoverage by remember { mutableStateOf<MapLabelGeometry?>(null) }
    val currentCoverage by rememberUpdatedState(activeCoverage)
    val selectRegion by rememberUpdatedState(onSelectRegion)

    DisposableEffect(lifecycle, mapView) {
        var started = false
        var resumed = false
        var disposed = false
        val loadFailure = MapView.OnDidFailLoadingMapListener {
            if (!disposed) {
                if (currentOnlineMode) onlineFailed = true
                else error = "Карта не загрузилась. Карточки и источники доступны ниже."
            }
        }
        mapView.addOnDidFailLoadingMapListener(loadFailure)
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> if (!started) { mapView.onStart(); started = true }
                Lifecycle.Event.ON_RESUME -> if (!resumed) { mapView.onResume(); resumed = true }
                Lifecycle.Event.ON_PAUSE -> if (resumed) { mapView.onPause(); resumed = false }
                Lifecycle.Event.ON_STOP -> if (started) { mapView.onStop(); started = false }
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        mapView.getMapAsync { nativeMap ->
            if (!disposed) {
                nativeMap.uiSettings.isLogoEnabled = false
                nativeMap.uiSettings.isAttributionEnabled = false // Attribution is rendered in the accessible Compose overlay below.
                nativeMap.uiSettings.isCompassEnabled = true
                nativeMap.uiSettings.isRotateGesturesEnabled = true
                nativeMap.setMinZoomPreference(0.0)
                nativeMap.setMaxZoomPreference(17.0)
                nativeMap.addOnCameraIdleListener {
                    if (!disposed) {
                        val camera = nativeMap.cameraPosition
                        zoom = camera.zoom
                        tilted = camera.tilt > 1.0
                        val target = camera.target
                        reliefArea = target != null && target.longitude in 40.29..40.49 && target.latitude in 43.64..43.82
                        if (camera.zoom < 10 && camera.tilt > 0) nativeMap.moveCamera(CameraUpdateFactory.newCameraPosition(CameraPosition.Builder(camera).tilt(0.0).build()))
                    }
                }
                nativeMap.addOnMapClickListener { coordinate ->
                    val inside = currentCoverage?.contains(Point.fromLngLat(coordinate.longitude, coordinate.latitude))
                        ?: currentDisplayArea?.contains(coordinate.longitude, coordinate.latitude)
                    if (inside != true) return@addOnMapClickListener false
                    val point = nativeMap.projection.toScreenLocation(coordinate)
                    val radius = 24f * context.resources.displayMetrics.density
                    val hits = nativeMap.queryRenderedFeatures(RectF(point.x - radius, point.y - radius, point.x + radius, point.y + radius), "region-markers")
                    val id = hits.firstOrNull { it.hasProperty("regionId") }?.getStringProperty("regionId")
                    if (id != null && selectRegion != null) { selectRegion?.invoke(id); true } else false
                }
                map = nativeMap
            }
        }
        onDispose {
            disposed = true
            styleGeneration += 1 // Ignore callbacks from a style which outlives its MapView.
            lifecycle.removeObserver(observer)
            mapView.removeOnDidFailLoadingMapListener(loadFailure)
            if (resumed) mapView.onPause()
            if (started) mapView.onStop()
            mapView.onDestroy()
        }
    }

    LaunchedEffect(connection) {
        if (connection == ConnectionState.ONLINE) onlineFailed = false
    }
    LaunchedEffect(map, rawStyle, onlineMode) {
        val nativeMap = map ?: return@LaunchedEffect
        val styleText = rawStyle ?: return@LaunchedEffect
        val generation = ++styleGeneration
        styleLoading = true
        activeCoverage = null
        error = null
        val prepared = withContext(Dispatchers.Default) { withMapLabelCoverage(mapStyleForConnection(styleText, onlineMode)) }
        withContext(Dispatchers.Main.immediate) {
            nativeMap.setStyle(Style.Builder().fromJson(prepared.json)) {
                if (styleGeneration == generation) {
                    labelGroups = prepared.groups
                    styleLoading = false
                    error = null
                    styleRevision = generation
                }
            }
        }
        delay(12_000)
        if (styleGeneration == generation && styleLoading) {
            if (onlineMode) onlineFailed = true
            else error = "Локальная карта не открылась. Карточки и источники доступны ниже."
        }
    }
    DisposableEffect(map, mapView, styleRevision, styleLoading, coverageAssets, labelGroups) {
        val nativeMap = map
        val assets = coverageAssets
        val coverage = if (nativeMap != null && assets != null && styleRevision > 0 && !styleLoading)
            NativeMapCoverage(mapView, nativeMap, assets, labelGroups) { activeCoverage = it } else null
        onDispose { coverage?.dispose() }
    }
    LaunchedEffect(eco, mapView) {
        withContext(Dispatchers.Main.immediate) { mapView.setMaximumFps(if (eco) 30 else 60) }
    }
    LaunchedEffect(relief, map, styleRevision) {
        withContext(Dispatchers.Main.immediate) {
            for (layer in listOf("pilot-hillshade", "russia-overview-relief", "online-hillshade")) {
                map?.style?.getLayer(layer)?.setProperties(PropertyFactory.visibility(if (relief) Property.VISIBLE else Property.NONE))
            }
        }
    }

    // Catalogue mode can change without changing the focus or the style.
    // Update only its points so switching lists neither reloads the route nor moves the camera.
    LaunchedEffect(map, styleRevision, styleLoading, regions) {
        val nativeMap = map ?: return@LaunchedEffect
        if (styleRevision == 0 || styleLoading) return@LaunchedEffect
        val data = withContext(Dispatchers.Default) { regionPoints(regions) }
        withContext(Dispatchers.Main.immediate) {
            nativeMap.style?.getSourceAs<GeoJsonSource>("regions")?.setGeoJson(data)
        }
    }

    LaunchedEffect(map, styleRevision, displayArea, selected?.id, route?.id, route?.apiRevisionId, route?.geometryAsset, route?.inlineGeometry) {
        val nativeMap = map ?: return@LaunchedEffect
        if (styleRevision == 0 || styleLoading) return@LaunchedEffect
        val area = displayArea ?: return@LaunchedEffect
        val geometry = route?.inlineGeometry ?: route?.geometryAsset?.let { asset ->
            withContext(Dispatchers.IO) {
                runCatching { context.assets.open(asset).bufferedReader().use { it.readText() } }.getOrNull()
            }
        }
        val prepared = geometry?.let { json ->
            withContext(Dispatchers.Default) { runCatching { prepareMapRouteGeometry(json) } }
        }
        withContext(Dispatchers.Main.immediate) ui@{
            nativeMap.setLatLngBoundsForCameraTarget(area.cameraBounds)
            scopeNotice = null
            val style = nativeMap.style ?: return@ui
            style.getSourceAs<GeoJsonSource>("focus")?.setGeoJson(points(selected?.let { listOf(it.longitude to it.latitude) } ?: emptyList()))
            val routeData = prepared?.getOrNull()
            style.getSourceAs<GeoJsonSource>("route")?.setGeoJson(routeData?.json ?: points(emptyList()))
            if (prepared?.isFailure == true) error = ROUTE_GEOMETRY_ERROR
            else if (error == ROUTE_GEOMETRY_ERROR) error = null
            val focusKey = "${selected?.id}:${route?.id}"
            if (lastFittedFocus == focusKey) return@ui
            lastFittedFocus = focusKey
            if (routeData != null) {
                routeData.frame?.let { frame ->
                    val bounds = LatLngBounds.from(frame.north, frame.east, frame.south, frame.west)
                    nativeMap.animateCamera(CameraUpdateFactory.newLatLngBounds(bounds, 52), 500)
                }
            } else if (selected != null) {
                nativeMap.animateCamera(CameraUpdateFactory.newLatLngZoom(
                    LatLng(selected.latitude, selected.longitude), selected.zoom,
                ), 500)
            } else nativeMap.animateCamera(CameraUpdateFactory.newLatLngBounds(area.fitBounds, 24), 500)
        }
    }

    LaunchedEffect(map, styleRevision, displayArea, activeCoverage, position) {
        val nativeMap = map ?: return@LaunchedEffect
        if (styleRevision == 0 || styleLoading) return@LaunchedEffect
        val area = displayArea ?: return@LaunchedEffect
        withContext(Dispatchers.Main.immediate) {
            val ready = position as? PositionState.Ready
            val inside = ready?.fix?.let { activeCoverage?.contains(Point.fromLngLat(it.longitude, it.latitude))
                ?: area.contains(it.longitude, it.latitude) } == true
            nativeMap.style?.getSourceAs<GeoJsonSource>("position")?.setGeoJson(
                points(if (inside) ready?.fix?.let { listOf(it.longitude to it.latitude) }.orEmpty() else emptyList()))
            scopeNotice = if (ready != null && !inside) "Геопозиция получена. Точка находится вне области карты России." else null
            if (ready != null && inside && lastPositionTime != ready.fix.measuredAt) {
                lastPositionTime = ready.fix.measuredAt
                nativeMap.animateCamera(CameraUpdateFactory.newLatLngZoom(LatLng(ready.fix.latitude, area.cameraLongitude(ready.fix.longitude)), 11.0), 500)
            }
        }
    }

    Box(modifier.background(Palette.Water)) {
        AndroidView(factory = { mapView }, modifier = Modifier.fillMaxSize())
        val problem = error ?: scopeError
        if ((map == null || displayArea == null || styleLoading) && problem == null) Text("Открываем карту России…", Modifier.align(Alignment.Center).background(Palette.Surface).padding(12.dp), style = MaterialTheme.typography.bodyMedium)
        problem?.let { Text(it, Modifier.align(Alignment.Center).padding(16.dp), color = Palette.Alert) }
        scopeNotice?.let { Text(it, Modifier.align(Alignment.Center).background(Palette.Surface).padding(12.dp), style = MaterialTheme.typography.bodySmall, color = Palette.Muted) }
        if (map != null) {
            Surface(Modifier.align(Alignment.CenterEnd).padding(end = 8.dp), color = Palette.Surface, shape = RoundedCornerShape(12.dp)) {
                Column {
                    TrailIconButton(onClick = { mapView.post { map?.animateCamera(CameraUpdateFactory.zoomIn(), 180) } }) { TropaIcon(Glyph.ZOOM_IN, description = "Приблизить карту") }
                    TrailIconButton(onClick = { mapView.post { map?.animateCamera(CameraUpdateFactory.zoomOut(), 180) } }) { TropaIcon(Glyph.ZOOM_OUT, description = "Отдалить карту") }
                }
            }
            Text(when {
                onlineFailed -> "Показана сохранённая карта"
                onlineMode -> "Подробная карта"
                connection == ConnectionState.LIMITED -> "Обзорная карта"
                else -> "Карта без интернета"
            }, Modifier.align(Alignment.BottomCenter).padding(bottom = 104.dp).background(Palette.Surface.copy(alpha = .96f)).padding(horizontal = 8.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelSmall, color = Palette.Muted)
            Row(Modifier.align(Alignment.BottomCenter).padding(bottom = 50.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TrailChoice(selected = onlineMode, onClick = {
                    if (onlineFailed) { onlineFailed = false; onlineRequested = true } else onlineRequested = !onlineRequested
                }, enabled = connection == ConnectionState.ONLINE, label = { Text("Подробная карта") }, modifier = Modifier.heightIn(min = 48.dp))
                TrailChoice(selected = relief, onClick = { relief = !relief }, enabled = zoom < 6 || (reliefArea && zoom >= 7) || (onlineMode && zoom >= 5),
                    label = { Text("Рельеф") }, modifier = Modifier.heightIn(min = 48.dp))
                TrailChoice(selected = tilted, onClick = {
                    mapView.post { map?.let { current -> current.animateCamera(CameraUpdateFactory.newCameraPosition(CameraPosition.Builder(current.cameraPosition).tilt(if (tilted) 0.0 else 40.0).build()), 300) } }
                }, enabled = zoom >= 10, label = { Text("Ракурс") }, modifier = Modifier.heightIn(min = 48.dp))
                TrailChoice(selected = eco, onClick = { eco = !eco }, label = { Text("Беречь заряд") }, modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        Surface(Modifier.align(Alignment.BottomStart), color = Palette.Surface.copy(alpha = .96f), shape = RoundedCornerShape(topEnd = 12.dp)) {
            Row(Modifier.padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("© OpenStreetMap contributors", Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelSmall, color = Palette.Muted)
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

private fun regionPoints(regions: List<Region>): String = JSONObject()
    .put("type", "FeatureCollection")
    .put("features", JSONArray(regions.map { region ->
        JSONObject().put("type", "Feature").put("properties", JSONObject().put("regionId", region.id).put("name", region.name))
            .put("geometry", JSONObject().put("type", "Point").put("coordinates", JSONArray(listOf(region.longitude, region.latitude))))
    })).toString()

private fun points(locations: List<Pair<Double, Double>>): String = JSONObject()
    .put("type", "FeatureCollection")
    .put("features", JSONArray(locations.map { (longitude, latitude) ->
        JSONObject().put("type", "Feature").put("properties", JSONObject())
            .put("geometry", JSONObject().put("type", "Point").put("coordinates", JSONArray(listOf(longitude, latitude))))
    })).toString()
