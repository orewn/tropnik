package ru.tropa.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CustomMapResourcePolicyTest {
    @Test fun onlyTheReviewedPublicMapProvidersAndTilePathsMayReachTheBroker() {
        for (url in listOf(
            "https://tiles.openfreemap.org/planet/latest",
            "https://tiles.openfreemap.org/planet/20261106_001001_pt/12/2500/1400.pbf",
            "https://tiles.mapterhorn.com/12/2500/1400.webp",
            "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/12/1400/2500.jpg",
            "https://tiles.maps.eox.at/wmts/1.0.0/bluemarble_3857/default/g/4/6/10.jpg",
        )) assertTrue(url, CustomMapResourcePolicy.remoteAllowed(url))
    }

    @Test fun credentialsRedirectDestinationsPrivateApisAndEncodedTraversalAreRejected() {
        for (url in listOf(
            "http://tiles.openfreemap.org/planet/latest",
            "https://tiles.openfreemap.org.evil.invalid/planet/latest",
            "https://tiles.openfreemap.org@evil.invalid/planet/latest",
            "https://user:secret@tiles.openfreemap.org/planet/latest",
            "https://tiles.openfreemap.org:444/planet/latest",
            "https://tiles.openfreemap.org/planet/latest?token=secret",
            "https://tiles.openfreemap.org/planet/latest#fragment",
            "https://tiles.openfreemap.org/planet/../private",
            "https://tiles.openfreemap.org/planet/%2e%2e/private",
            "https://tiles.openfreemap.org/planet/a%2fb",
            "https://tiles.openfreemap.org/api/private",
            "https://tiles.mapterhorn.com/private",
            "https://tiles.maps.eox.at/wmts/1.0.0/unreviewed/default/g/1/0/0.jpg",
            "https://127.0.0.1/planet/latest", "file:///data/data/ru.tropa.app.preview/private",
            "content://ru.tropa.app.preview/private", "data:text/html,private",
        )) assertFalse(url, CustomMapResourcePolicy.remoteAllowed(url))
    }

    @Test fun virtualAssetNamesCannotEscapeTheManifestRegistry() {
        assertTrue(CustomMapResourcePolicy.safePath("/custom-map/workers/tiles-aBC123.js"))
        for (path in listOf("/", "relative", "/../secret", "/custom-map/./secret", "/custom-map//secret", "/custom-map/a%2fb", "/custom-map/a\\b", "/custom-map/a?x", "/custom-map/" + "a".repeat(600))) {
            assertFalse(path, CustomMapResourcePolicy.safePath(path))
        }
    }
}
