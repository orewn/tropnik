package ru.tropa.app.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject
import ru.tropa.app.data.MapCameraCheckpoint

/** Activity composition owns this object. It contains no View or Context and
 * keeps a bounded set of completed cameras while cards and tabs change. */
internal class MapPresentationState(initialEco: Boolean = false) {
    var mode by mutableStateOf("detail")
    var paths by mutableStateOf(true)
    var onlineRequested by mutableStateOf(true)
    var eco by mutableStateOf(initialEco)
    private val cameras = linkedMapOf<String, MapCameraCheckpoint>()

    fun rememberCamera(focus: String, camera: JSONObject) {
        val value = MapCameraCheckpoint.capture(focus, camera) ?: return
        cameras.remove(focus)
        cameras[focus] = value
        while (cameras.size > 32) cameras.remove(cameras.keys.first())
    }

    fun cameraFor(focus: String): JSONObject? = cameras[focus]?.cameraFor(focus)
}
