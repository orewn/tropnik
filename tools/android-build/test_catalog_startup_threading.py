"""Guard cold catalogue IO and the real Activity readiness boundary."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "android/app/src/main/java/ru/tropa/app"


class CatalogStartupThreadingSourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.application = (APP / "TropaApplication.kt").read_text()
        cls.startup = (APP / "CatalogStartup.kt").read_text()
        cls.activity = (APP / "MainActivity.kt").read_text()
        cls.device = (ROOT / "android/app/src/androidTest/java/ru/tropa/app/LocalExperienceTest.kt").read_text()

    def test_preparation_owns_the_same_success_only_synchronized_catalogue(self):
        self.assertIn("private val bundledCatalog = lazy(LazyThreadSafetyMode.SYNCHRONIZED) { Catalog.load(this) }", self.application)
        self.assertIn("private val catalogStartup = CatalogStartup(bundledCatalog)", self.application)
        self.assertIn("val catalog by bundledCatalog", self.application)
        self.assertIn("internal suspend fun prepareCatalog(): Catalog = catalogStartup.prepare()", self.application)
        self.assertIn("val isReady: Boolean get() = catalog.isInitialized()", self.startup)
        self.assertIn("private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO", self.startup)
        self.assertIn("if (isReady) return catalog.value", self.startup)
        self.assertIn("return withContext(ioDispatcher) { catalog.value }", self.startup)

    def test_activity_constructs_existing_models_only_after_successful_preparation(self):
        ready_branch = self.activity.split("    if (startupState == CatalogLoadState.Ready) {", 1)[1].split("    } else {", 1)[0]
        for source in ("val model: MainViewModel = viewModel()", "val online: OnlineViewModel = viewModel()", "TropaApp(model, online)"):
            self.assertIn(source, ready_branch)
            self.assertEqual(self.activity.count(source), 1)
        self.assertLess(self.activity.index("application.prepareCatalog()"), self.activity.index("startupState = CatalogLoadState.Ready"))
        self.assertIn("if (application.catalogReady) CatalogLoadState.Ready else CatalogLoadState.Loading", self.activity)
        self.assertNotIn("Catalog.load(", self.activity)
        self.assertNotIn("runBlocking", self.activity)

    def test_cancelled_activity_cannot_publish_ready_or_turn_cancellation_into_retry_error(self):
        effect = self.activity.split("LaunchedEffect(application, attempt) {", 1)[1].split("    if (startupState == CatalogLoadState.Ready) {", 1)[0]
        self.assertLess(effect.index("currentCoroutineContext().ensureActive()"), effect.index("startupState = CatalogLoadState.Ready"))
        self.assertLess(effect.index("catch (cancelled: CancellationException)"), effect.index("catch (error: Exception)"))
        self.assertIn("throw cancelled", effect)
        self.assertIn("startupState = CatalogLoadState.Failed", effect)
        self.assertIn("Log.e(\"TropaStartup\"", effect)
        self.assertIn('"catalog_startup_error" else "catalog_startup_loading"', self.activity)
        retry = self.activity.split("TrailButton(onClick = {", 1)[1].split("}, modifier", 1)[0]
        self.assertIn("startupState = CatalogLoadState.Loading", retry)
        self.assertIn("attempt += 1", retry)
        for mutation in ("routeId", "offlineSnapshot", "navigationVersion", "mutableState", "selectRoute"):
            self.assertNotIn(mutation, retry)

    def test_all_device_scenarios_wait_for_real_startup_without_relaxing_map_readiness(self):
        before = self.device.split("@Before fun waitForCatalogueStartup() {", 1)[1].split("    @Test ", 1)[0]
        self.assertIn("app.waitUntil(timeoutMillis = 15_000)", before)
        self.assertIn('app.onAllNodesWithTag("explore_list").fetchSemanticsNodes().size == 1', before)
        self.assertIn('app.onNodeWithTag("explore_list").assertIsDisplayed()', before)
        self.assertIn('check(app.onAllNodesWithTag("catalog_startup_error").fetchSemanticsNodes().isEmpty())', before)
        for bypass in ("Thread.sleep", "SystemClock.sleep", "assume", "@Ignore", "mapReady", "mapInputReady"):
            self.assertNotIn(bypass, before)
        self.assertEqual(self.device.count("@Test fun "), 11)


if __name__ == "__main__":
    unittest.main()
