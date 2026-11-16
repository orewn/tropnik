package ru.tropa.app.ui

import java.net.URI

internal const val CUSTOM_MAP_ORIGIN = "https://map.tropnik.invalid"
internal const val MAX_MAP_RESOURCE_BYTES = 8 * 1024 * 1024

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
