package ru.tropa.app.data

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

data class PositionFix(val latitude: Double, val longitude: Double, val accuracy: Float, val ageSeconds: Long, val measuredAt: Long)

sealed interface PositionState {
    data object Idle : PositionState
    data object Locating : PositionState
    data class Ready(val fix: PositionFix) : PositionState
    data class Problem(val message: String) : PositionState
}

class LocationReader(private val context: Context) {
    private val manager = context.getSystemService(LocationManager::class.java)

    @Suppress("MissingPermission")
    suspend fun read(): PositionState {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!granted) return PositionState.Problem("Доступ к геопозиции не разрешён. Карту можно изучать без него.")
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }
        if (providers.isEmpty()) return PositionState.Problem("Геолокация выключена. Включите её в настройках телефона.")
        val last = providers.mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }
            .filter { age(it) in 0..30 }.minByOrNull { it.accuracy }
        if (last != null) return PositionState.Ready(last.toFix())
        val result = withTimeoutOrNull(20_000) {
            suspendCancellableCoroutine<Location?> { continuation ->
                val listener = object : LocationListener {
                    override fun onLocationChanged(location: Location) {
                        if (age(location) in 0..30 && continuation.isActive) {
                            manager.removeUpdates(this)
                            continuation.resume(location)
                        }
                    }
                    override fun onProviderEnabled(provider: String) = Unit
                    override fun onProviderDisabled(provider: String) = Unit
                    @Deprecated("Legacy Android callback")
                    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
                }
                continuation.invokeOnCancellation { manager.removeUpdates(listener) }
                var subscriptions = 0
                providers.forEach { provider ->
                    try {
                        manager.requestLocationUpdates(provider, 1_000L, 0f, listener, Looper.getMainLooper())
                        subscriptions++
                    } catch (_: SecurityException) { /* Approximate access may exclude the GPS provider. */ }
                }
                if (subscriptions == 0 && continuation.isActive) continuation.resume(null)
            }
        }
        return result?.let { PositionState.Ready(it.toFix()) }
            ?: PositionState.Problem("Точная позиция пока недоступна. Попробуйте на открытом месте.")
    }

    private fun age(location: Location) = (SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1_000_000_000L
    private fun Location.toFix() = PositionFix(latitude, longitude, accuracy, age(this), time)
}
