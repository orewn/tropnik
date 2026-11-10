package ru.tropa.app.ui

import android.graphics.PointF
import android.view.View
import kotlinx.coroutines.CancellationException
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
import org.maplibre.android.style.sources.GeoJsonSource
import ru.tropa.app.data.MAP_COVERAGE_SOURCE
import ru.tropa.app.data.MAP_LABEL_SOURCE
import ru.tropa.app.data.MapCoverage
import ru.tropa.app.data.MapCoverageBounds
import ru.tropa.app.data.MapLabelGeometry
import ru.tropa.app.data.MapLabelGroup
import kotlin.math.pow

private val coverageWorker = Dispatchers.Default.limitedParallelism(1)
private const val EMPTY_FEATURES = "{\"type\":\"FeatureCollection\",\"features\":[]}"

/** Owns one style generation. Panning cancels obsolete decoding; each settled
 * viewport publishes a complete source frame and its matching label index. */
internal class NativeMapCoverage(
    private val view: MapView,
    private val map: MapLibreMap,
    private val assets: MapCoverage,
    private val groups: List<MapLabelGroup>,
    private val onCoverage: (MapLabelGeometry) -> Unit,
) {
    private val style = map.style
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var job: Job? = null
    private var labels: NativeMapLabels? = null
    private var previous: String? = null
    private var disposed = false
    private var moving = false
    private val moved = MapLibreMap.OnCameraMoveStartedListener { moving = true; job?.cancel() }
    private val idle = MapLibreMap.OnCameraIdleListener { moving = false; schedule() }
    private val resized = View.OnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
        if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) schedule()
    }

    init {
        map.addOnCameraMoveStartedListener(moved)
        map.addOnCameraIdleListener(idle)
        view.addOnLayoutChangeListener(resized)
        schedule()
    }

    private fun schedule() {
        if (disposed || moving || style == null || map.style !== style) return
        job?.cancel()
        job = scope.launch {
            delay(32)
            if (disposed || moving || map.style !== style || view.width <= 0 || view.height <= 0) return@launch
            val camera = map.cameraPosition
            val target = camera.target ?: return@launch
            val points = listOf(PointF(0f, 0f), PointF(view.width.toFloat(), 0f),
                PointF(0f, view.height.toFloat()), PointF(view.width.toFloat(), view.height.toFloat()))
                .map { map.projection.fromScreenLocation(it) }.map { it.longitude to it.latitude }
            // One tile of margin also covers labels whose anchors are just
            // outside the visible rectangle, including a rotated viewport.
            val viewport = MapCoverageBounds.around(target.longitude, points, 360.0 / 2.0.pow(camera.zoom))
            val frame = try {
                withContext(coverageWorker) {
                    val context = currentCoroutineContext()
                    assets.frame(camera.zoom, viewport) { context.ensureActive() }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // The verified overview/previous frame remains opaque. Never
                // remove a mask because an asset failed to decode or verify.
                return@launch
            }
            if (disposed || moving || map.style !== style || frame.key == previous) return@launch
            val source = style.getSourceAs<GeoJsonSource>(MAP_COVERAGE_SOURCE) ?: return@launch
            labels?.dispose()
            style.getSourceAs<GeoJsonSource>(MAP_LABEL_SOURCE)?.setGeoJson(EMPTY_FEATURES)
            source.setGeoJson(frame.json)
            onCoverage(frame.geometry)
            labels = NativeMapLabels(view, map, groups, frame.geometry)
            previous = frame.key
        }
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        scope.cancel()
        labels?.dispose()
        map.removeOnCameraMoveStartedListener(moved)
        map.removeOnCameraIdleListener(idle)
        view.removeOnLayoutChangeListener(resized)
    }
}
