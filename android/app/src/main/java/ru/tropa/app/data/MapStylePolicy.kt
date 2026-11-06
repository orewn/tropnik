package ru.tropa.app.data

import org.json.JSONArray
import org.json.JSONObject

/** Map connectivity does not imply that the social API is configured or ready. */
internal fun canUseOnlineMap(connection: ConnectionState, requested: Boolean, failed: Boolean): Boolean =
    connection == ConnectionState.ONLINE && requested && !failed

/** Remove remote sources, not only their layers, so a local style needs no TileJSON request. */
internal fun mapStyleForConnection(rawStyle: String, online: Boolean): String {
    val style = JSONObject(rawStyle)
    if (!online) {
        val sources = style.getJSONObject("sources")
        sources.keys().asSequence().filter { it.startsWith("online-") }.toList().forEach(sources::remove)
        val original = style.getJSONArray("layers")
        val local = JSONArray()
        for (index in 0 until original.length()) {
            val layer = original.getJSONObject(index)
            if (!layer.getString("id").startsWith("online-") && !layer.optString("source").startsWith("online-")) local.put(layer)
        }
        style.put("layers", local)
    }
    return style.toString()
}
