"""Guard native UI/worker boundaries; real rendering remains a device gate."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
UI = ROOT / "android/app/src/main/java/ru/tropa/app/ui"


def between(text: str, start: str, end: str) -> str:
    try:
        return text.split(start, 1)[1].split(end, 1)[0]
    except IndexError as error:
        raise AssertionError(f"Missing reviewed source boundary: {start!r} .. {end!r}") from error


class TropaMapThreadingSourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = (UI / "TropaMap.kt").read_text()
        cls.host = (UI / "CustomMapWebView.kt").read_text()

    def test_full_route_io_and_parsing_leave_main_before_native_bridge_update(self) -> None:
        effect = between(self.source,
            "LaunchedEffect(mapView, mapReady, countryBounds, selected?.id, route?.id, route?.apiRevisionId, route?.geometryAsset, route?.inlineGeometry) {",
            "LaunchedEffect(mapView, mapReady, position) {")
        read = effect.index("withContext(Dispatchers.IO)")
        parse = effect.index("withContext(Dispatchers.Default)")
        update = effect.index("mapView.setRoute(route?.id, routeData?.utf8)")
        self.assertLess(effect.index("mapView.setRoute(route?.id, null)"), read)
        self.assertLess(read, parse)
        self.assertLess(parse, update)
        # Compose resumes on Main after each scoped background data operation.
        # A route revision refreshes its bytes without refitting a user's pan.
        self.assertNotIn("withContext(Dispatchers.IO)", effect[update:])
        self.assertNotIn("withContext(Dispatchers.Default)", effect[update:])
        self.assertIn("if (lastFittedFocus == focusKey) return@LaunchedEffect", effect[update:])
        self.assertIn('mapView.command("fit"', effect[update:])

    def test_source_changes_refresh_route_without_coupling_to_marker_filter(self) -> None:
        key = self.source.split("LaunchedEffect(mapView, mapReady, countryBounds, selected?.id", 1)[1].split(" {", 1)[0]
        for field in ("route?.id", "route?.apiRevisionId", "route?.geometryAsset", "route?.inlineGeometry"):
            self.assertIn(field, key)
        self.assertNotIn("regions", key)
        self.assertNotIn("hashCode", key)
        effect = between(self.source, "LaunchedEffect(mapView, regions, selected?.id) {",
                         "LaunchedEffect(mapView, mapReady, countryBounds")
        self.assertIn("mapView.setMarkers", effect)
        self.assertNotIn("setRoute", effect)
        self.assertNotIn('command("fit"', effect)

    def test_bridge_enforces_main_thread_and_keeps_route_out_of_messages(self) -> None:
        command = between(self.host, "fun command(", "fun setMarkers(")
        self.assertIn("check(Looper.myLooper() == Looper.getMainLooper())", command)
        self.assertIn("Handler(Looper.getMainLooper())", self.host)
        registry_load = between(self.host, "resourceLoader.execute {", "private fun fail(")
        self.assertIn("CustomMapResources(context)", registry_load)
        self.assertIn("else handler.post", registry_load)
        self.assertIn("brokerReference.getAndSet(null)?.close()", self.host)
        self.assertIn("resourceLoader.shutdownNow()", self.host)
        broker_close = between(self.host, "    fun close() {", "/** Restricted main-map host")
        self.assertIn("network.close()", broker_close)
        self.assertNotIn("evictAll", broker_close)
        self.assertNotIn(".cancel()", broker_close)
        self.assertIn("private val network = MapNetworkLifetime(", self.host)
        self.assertIn("}, handler)", self.host)
        route = between(self.host, "fun setRoute(id:", "fun setOnline(")
        self.assertIn("assetBroker?.setRoute", route)
        self.assertIn('command("route",', route)
        self.assertNotIn('.put("geometry"', route)
        self.assertNotIn("evaluateJavascript", self.host)
        self.assertNotIn("addJavascriptInterface", self.host)

    def test_controls_and_position_use_typed_commands_with_owned_lifecycle(self) -> None:
        for action in ("zoom", "north", "pitch", "eco", "layers", "position"):
            self.assertIn(f'mapView.command("{action}"', self.source)
        position = between(self.source, "LaunchedEffect(mapView, mapReady, position) {", "Box(modifier.background")
        self.assertIn("lastPositionTime != point.measuredAt", position)
        self.assertIn("mapView.release()", self.source)
        self.assertIn("mapView.setActive(false)", self.source)
        self.assertIn("requestDisallowInterceptTouchEvent(true)", self.host)
        self.assertIn("MotionEvent.ACTION_CANCEL", self.host)
        self.assertIn("requestDisallowInterceptTouchEvent(false)", self.host)


if __name__ == "__main__":
    unittest.main()
