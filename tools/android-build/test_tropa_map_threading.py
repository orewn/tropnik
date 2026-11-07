from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "android/app/src/main/java/ru/tropa/app/ui/TropaMap.kt"


def between(text: str, start: str, end: str) -> str:
    try:
        return text.split(start, 1)[1].split(end, 1)[0]
    except IndexError as error:
        raise AssertionError(f"Missing reviewed source boundary: {start!r} .. {end!r}") from error


class TropaMapThreadingSourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = SOURCE.read_text()

    def test_focus_effect_keeps_io_off_main_and_maplibre_on_main(self) -> None:
        effect = between(
            self.source,
            "LaunchedEffect(map, styleRevision, displayArea, selected?.id, route?.id) {",
            "LaunchedEffect(map, styleRevision, displayArea, position) {",
        )
        io_marker = "withContext(Dispatchers.IO)"
        ui_marker = "withContext(Dispatchers.Main.immediate) ui@{"
        self.assertIn(io_marker, effect)
        self.assertIn(ui_marker, effect)
        self.assertLess(effect.index(io_marker), effect.index(ui_marker))

        ui_block = effect.split(ui_marker, 1)[1]
        self.assertNotIn("return@LaunchedEffect", ui_block)
        self.assertIn("val style = nativeMap.style ?: return@ui", ui_block)
        self.assertIn("if (lastFittedFocus == focusKey) return@ui", ui_block)
        self.assertIn("nativeMap.setLatLngBoundsForCameraTarget", ui_block)
        self.assertIn("nativeMap.animateCamera", ui_block)

    def test_position_effect_mutates_map_only_from_main_dispatcher(self) -> None:
        effect = between(
            self.source,
            "LaunchedEffect(map, styleRevision, displayArea, position) {",
            "Box(modifier.background(Palette.Water)) {",
        )
        ui_marker = "withContext(Dispatchers.Main.immediate) {"
        self.assertIn(ui_marker, effect)
        self.assertIn(
            "\n        withContext(Dispatchers.Main.immediate) {\n"
            "            val ready = position as? PositionState.Ready",
            effect,
        )
        before_ui, ui_block = effect.split(ui_marker, 1)
        self.assertNotIn("getSourceAs<GeoJsonSource>", before_ui)
        self.assertNotIn("animateCamera", before_ui)
        self.assertIn('getSourceAs<GeoJsonSource>("position")', ui_block)
        self.assertIn("nativeMap.animateCamera", ui_block)

    def test_compose_map_controls_post_native_callbacks_to_map_view(self) -> None:
        self.assertIn(
            "mapView.post { map?.animateCamera(CameraUpdateFactory.zoomIn(), 180) }",
            self.source,
        )
        self.assertIn(
            "mapView.post { map?.animateCamera(CameraUpdateFactory.zoomOut(), 180) }",
            self.source,
        )
        self.assertIn(
            "mapView.post { map?.let { current -> current.animateCamera",
            self.source,
        )
        self.assertIn(
            "withContext(Dispatchers.Main.immediate) { mapView.setMaximumFps",
            self.source,
        )


if __name__ == "__main__":
    unittest.main()
