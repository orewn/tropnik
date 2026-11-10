package ru.tropa.app.ui

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapView
import org.maplibre.android.style.expressions.Expression
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.android.style.sources.VectorSource
import ru.tropa.app.data.MAP_LABEL_SOURCE
import ru.tropa.app.data.MapLabelBatch
import ru.tropa.app.data.MapLabelGeometry
import ru.tropa.app.data.MapLabelGroup
import ru.tropa.app.data.MapLabelProcessor

/** Uses the public 13.7.1 APIs on Main, then filters immutable query results on
 * one background worker. No network requests or camera commands are introduced. */
internal class NativeMapLabels(
    private val view: MapView,
    private val map: MapLibreMap,
    private val groups: List<MapLabelGroup>,
    coverage: MapLabelGeometry,
) {
    private val style = map.style
    private val sourceIds = groups.map { it.source }.toSet()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val worker = Dispatchers.Default.limitedParallelism(1)
    private val processor = MapLabelProcessor(coverage)
    private var job: Job? = null
    private var disposed = false
    private var moving = false
    private var previous: String? = null
    private val moved = MapLibreMap.OnCameraMoveStartedListener { moving = true; job?.cancel() }
    private val idle = MapLibreMap.OnCameraIdleListener { moving = false; schedule() }
    private val changed = MapView.OnSourceChangedListener { source -> if (source in sourceIds) schedule() }
    // Camera idle and source-data changes can precede asynchronous GeoJSON
    // tiling. Retry once the map settles so an early empty query cannot stick.
    private val rendered = MapView.OnDidBecomeIdleListener { schedule() }

    init {
        map.addOnCameraMoveStartedListener(moved)
        map.addOnCameraIdleListener(idle)
        view.addOnSourceChangedListener(changed)
        view.addOnDidBecomeIdleListener(rendered)
        schedule()
    }

    private fun schedule() {
        if (disposed || moving || style == null || map.style !== style) return
        job?.cancel()
        job = scope.launch {
            delay(48)
            if (disposed || moving || map.style !== style) return@launch
            val zoom = map.cameraPosition.zoom
            val batches = groups.mapNotNull { group ->
                val (active, query) = group.query(zoom)
                if (!active) return@mapNotNull null
                val filter = query?.let(Expression::raw)
                val features = runCatching {
                    when (val source = style.getSource(group.source)) {
                        is VectorSource -> source.querySourceFeatures(arrayOf(group.sourceLayer ?: return@mapNotNull null), filter)
                        is GeoJsonSource -> source.querySourceFeatures(filter)
                        else -> return@mapNotNull null
                    }
                }.getOrDefault(emptyList())
                MapLabelBatch(group, features)
            }
            val data = withContext(worker) {
                val context = currentCoroutineContext()
                processor.process(batches) { context.ensureActive() }
            }
            if (!disposed && !moving && map.style === style && data != previous) {
                style.getSourceAs<GeoJsonSource>(MAP_LABEL_SOURCE)?.setGeoJson(data)
                previous = data
            }
        }
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        scope.cancel()
        job = null
        previous = null
        map.removeOnCameraMoveStartedListener(moved)
        map.removeOnCameraIdleListener(idle)
        view.removeOnSourceChangedListener(changed)
        view.removeOnDidBecomeIdleListener(rendered)
    }
}
