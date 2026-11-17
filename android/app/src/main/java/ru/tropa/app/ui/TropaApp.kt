package ru.tropa.app.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ru.tropa.app.BuildConfig
import java.io.File
import ru.tropa.app.AppState
import ru.tropa.app.MainViewModel
import ru.tropa.app.OnlineViewModel
import ru.tropa.app.Screen
import ru.tropa.app.BrowsePanel
import ru.tropa.app.data.ConnectionState
import ru.tropa.app.data.InstalledPackEntity
import ru.tropa.app.data.PositionState
import ru.tropa.app.data.Region
import ru.tropa.app.data.TrailRoute
import ru.tropa.app.data.browserPlannerTarget
import java.text.DateFormat
import java.util.Date
import java.util.Locale

@Composable
fun TropaApp(model: MainViewModel, online: OnlineViewModel) {
    val state by model.state.collectAsStateWithLifecycle()
    val connected by online.state.collectAsStateWithLifecycle()
    val snackbars = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var showSources by remember { mutableStateOf(false) }
    var landscape by remember(state.routeId) { mutableStateOf(false) }
    val context = LocalContext.current
    val sourceText = remember { context.assets.open("SOURCES.txt").bufferedReader().use { it.readText() } }
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result.values.any { it }) model.locate() else model.locationDenied()
    }
    LaunchedEffect(state.notice) { state.notice?.let { snackbars.showSnackbar(it); model.clearNotice() } }
    LaunchedEffect(connected.notice) { connected.notice?.let { snackbars.showSnackbar(it); online.clearNotice() } }
    BackHandler(!landscape && (state.routeId != null || state.regionId != null || state.search.isNotBlank() ||
        state.browsePanel == BrowsePanel.CONTENT || state.screen != Screen.EXPLORE)) { model.back() }
    val presentation = remember { MapPresentationState(context.getSystemService(android.app.ActivityManager::class.java)?.isLowRamDevice == true) }
    val destinations = rememberSaveableStateHolder()
    val imeVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0

    Scaffold(
        containerColor = Palette.Background,
        bottomBar = {
            if (!landscape && !imeVisible) MobileDestinationBar(state.screen, model::switchScreen)
        },
    ) { padding ->
        val route = model.route(state.routeId)
        val workspaceActive = state.screen == Screen.EXPLORE || route != null || state.offlineSnapshot != null
        val onTrips = {
            if (route?.apiOrigin != null && route.apiOrigin != connected.serverUrl) model.switchScreen(Screen.PROFILE)
            else { online.filterRoute(route?.apiRouteId); model.switchScreen(Screen.TRIPS) }
        }
        val onRecruitment = {
            if (route?.apiOrigin != null && route.apiOrigin != connected.serverUrl) model.switchScreen(Screen.PROFILE)
            else { route?.apiRouteId?.let(online::composeRecruitment); model.switchScreen(Screen.TRIPS) }
        }
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                MobileMapWorkspace(model, state, workspaceActive, presentation, landscape, { landscape = it },
                    serviceMatches = route?.apiOrigin == null || route?.apiOrigin == connected.serverUrl,
                    onTrips = onTrips, onRecruitment = onRecruitment,
                    onLocation = { permissions.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) },
                    modifier = if (workspaceActive) Modifier.fillMaxSize()
                        else Modifier.requiredSize(0.dp).clipToBounds().clearAndSetSemantics { })
                if (!workspaceActive) Column(Modifier.fillMaxSize().background(Palette.Background)) {
                    BrandBar(state, onBack = model::back)
                    destinations.SaveableStateProvider(state.screen.name) {
                        when (state.screen) {
                            Screen.SAVED -> SavedScreen(model, state)
                            Screen.MORE -> MoreScreen(model) { showSources = true }
                            Screen.TRIPS -> OnlineTripsScreen(online, connected, onProfile = { model.switchScreen(Screen.PROFILE) }, onRoute = model::selectPublishedRoute)
                            Screen.PROFILE -> OnlineProfileScreen(online, connected, onSources = { showSources = true })
                            Screen.EXPLORE -> Unit
                        }
                    }
                }
            }
            // Feedback owns measured space above navigation/IME, so it cannot
            // cover Save or the route actions while the next card is opened.
            SnackbarHost(snackbars, Modifier.fillMaxWidth().testTag("app_feedback"))
        }
    }

    if (showSources) TrailDialog(
        onDismissRequest = { showSources = false },
        title = { Text("Источники и лицензии") },
        text = { LazyColumn { item { Text(sourceText, style = MaterialTheme.typography.bodyMedium) }
            item { TrailTextButton(onClick = { scope.launch {
                try {
                    val file = withContext(Dispatchers.IO) {
                        File(context.cacheDir, "licenses/copernicus-glo30.pdf").apply {
                            parentFile?.mkdirs()
                            context.assets.open("maps/terrain-pilot/sources/Copernicus-GLO30-LICENSE.pdf").use { input -> outputStream().use(input::copyTo) }
                        }
                    }
                    val uri = FileProvider.getUriForFile(context, BuildConfig.APPLICATION_ID + ".publicfiles", file)
                    context.startActivity(Intent.createChooser(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/pdf").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Лицензия рельефа"))
                } catch (_: Exception) { snackbars.showSnackbar("Не удалось открыть PDF. Полная атрибуция и адрес источника приведены выше.") }
            } }) { Text("Полная лицензия рельефа (PDF)") } }
        } },
        confirmButton = { TrailTextButton(onClick = { showSources = false }) { Text("Понятно") } },
    )
}

@Composable
private fun BrandBar(state: AppState, onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (state.screen == Screen.TRIPS || state.screen == Screen.PROFILE) {
            TrailIconButton(onClick = onBack, Modifier.testTag("go_back")) { TropaIcon(Glyph.BACK, description = "Назад") }
        }
        Text(when (state.screen) {
            Screen.SAVED -> "Сохранено"
            Screen.TRIPS -> "Походы"
            Screen.PROFILE -> "Профиль"
            else -> "Ещё"
        }, Modifier.weight(1f).padding(8.dp), style = MaterialTheme.typography.titleLarge)
        if (state.connection != ConnectionState.ONLINE) StatusPill(
            if (state.connection == ConnectionState.LIMITED) "Сеть ограничена" else "Без сети", caution = true)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ExploreScreen(model: MainViewModel, state: AppState) {
    val catalogue = model.displayCatalog
    val selected = model.region(state.regionId)
    val showTerritories = state.catalogTerritories
    val mapRegions = remember(catalogue, showTerritories) { catalogue.regions.filter { it.territory == showTerritories } }
    val regions = remember(catalogue, showTerritories, state.search) {
        val choices = if (state.search.isBlank()) mapRegions else catalogue.regions
        choices.filter { state.search.isBlank() || (it.name + " " + it.subtitle).contains(state.search.trim(), ignoreCase = true) }
    }
    val regionRoutes = remember(catalogue, state.search, selected?.id) { catalogue.referenceRoutes(state.search, selected?.id) }
    val savedRouteIds = remember(state.savedRoutes) { state.savedRoutes.mapTo(mutableSetOf()) { it.routeId } }
    val resultsList = rememberLazyListState()
    var scrolledQuery by rememberSaveable { mutableStateOf(state.search) }
    LaunchedEffect(state.search) {
        if (scrolledQuery != state.search) { resultsList.scrollToItem(0); scrolledQuery = state.search }
    }
    LazyColumn(
        Modifier.fillMaxSize().testTag("explore_list"), state = resultsList,
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        if (state.offlineSnapshot != null) item {
            Text("Сохранённая область · карточки и линии на этом телефоне", Modifier.testTag("saved_region_snapshot"),
                style = MaterialTheme.typography.bodySmall, color = Palette.Forest)
        }
        if (selected == null) {
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    TrailChoice(selected = !showTerritories, onClick = { model.showTerritories(false) }, label = { Text("Направления") }, modifier = Modifier.testTag("catalog_directions"))
                    TrailChoice(selected = showTerritories, onClick = { model.showTerritories(true) }, label = { Text("Территории") }, modifier = Modifier.testTag("catalog_territories"))
                }
            }
            item { SectionHeading("Куда отправимся", "Выберите регион на карте или в списке") }
            if (regions.isEmpty()) item { EmptyCard("Регион не найден", "Попробуйте другое название: например, «Алтай», «Карелия» или «Крым».", Glyph.SEARCH) }
            items(regions, key = { it.id }) { region -> RegionCard(region) { model.selectRegion(region.id) } }
            if (state.search.isNotBlank()) {
                item { SectionHeading("Найденные маршруты", "Выберите карточку, чтобы узнать больше") }
                if (regionRoutes.isEmpty()) item { EmptyCard("Маршрут не найден", "Попробуйте название места или другой запрос.", Glyph.SEARCH) }
                items(regionRoutes, key = { "search_${it.id}" }) { route -> RouteCard(route, saved = route.id in savedRouteIds) { model.selectRoute(route.id) } }
            }
            item { InfoCard("Карта помогает выбрать направление. Проверка конкретной тропы, условий и гида выполняется перед походом.") }
        } else {
            item { SectionHeading("Маршруты района", "Выберите тропу для следующего похода") }
            if (regionRoutes.isEmpty()) item { EmptyCard(if (state.search.isBlank()) "Маршруты ещё готовятся" else "Маршрут не найден", "Попробуйте другое название или соседний район.", Glyph.MOUNTAIN) }
            items(regionRoutes, key = { it.id }) { route -> RouteCard(route, saved = route.id in savedRouteIds) { model.selectRoute(route.id) } }
            item { OfflineAction(selected, model, state) }
            item { Text(selected.description, style = MaterialTheme.typography.bodyLarge) }
            item { InfoCard("Поход начинается с группы минимум из 4 человек, включая проверенного гида. Число мест и допустимое соотношение участников определяются для конкретного маршрута.") }
        }

    }
}

@Composable
private fun RegionCard(region: Region, onClick: () -> Unit) {
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth().testTag("region_${region.id}"),
        shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = Palette.Surface), border = BorderStroke(1.dp, Palette.Line)) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Box(Modifier.size(48.dp).clip(RoundedCornerShape(12.dp)).background(Palette.Land), contentAlignment = Alignment.Center) { TropaIcon(if (region.id == "karelia") Glyph.MAP else Glyph.MOUNTAIN) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(region.name, style = MaterialTheme.typography.titleMedium)
                Text(region.subtitle, style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
            }
            TropaIcon(Glyph.NEXT)
        }
    }
}

@Composable
private fun RouteCard(route: TrailRoute, saved: Boolean, onClick: () -> Unit) {
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth().testTag("route_${route.id}"), shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = Palette.Surface), border = BorderStroke(1.dp, Palette.Line)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                StatusPill(route.currentStatusLabel ?: if (route.accessStatus == "closed") "Посещение приостановлено"
                    else if (route.illustrative) "Учебный пример" else "Условия уточняются",
                    caution = route.accessStatus in setOf("closed", "restricted") || route.currentAdvisory != null,
                    modifier = Modifier.weight(1f, fill = false))
                if (saved) TropaIcon(Glyph.BOOKMARK, description = "Сохранено на устройстве")
            }
            Text(route.title, style = MaterialTheme.typography.titleMedium)
            RouteEssentialMetrics(route)
            route.distanceNote?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.Muted) }
            Text(route.summary, style = MaterialTheme.typography.bodyMedium, color = Palette.Muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
internal fun RouteDetail(route: TrailRoute, model: MainViewModel, state: AppState, serviceMatches: Boolean,
                        onTrips: () -> Unit, onRecruitment: () -> Unit, landscape: Boolean, onLandscapeChange: (Boolean) -> Unit) {
    val context = LocalContext.current
    val hasLandscape = route.id == "kavkaz-8a"
    val landscapeDocument by rememberLandscapeDocument(hasLandscape)
    val landscapeViewer = rememberLandscapeViewer(landscapeDocument, hasLandscape)
    val detailListState = rememberLazyListState()
    val region = model.region(route.regionId)
    Box(Modifier.fillMaxSize()) {
    if (hasLandscape) LocalLandscapeScene(landscapeViewer, visible = landscape) { onLandscapeChange(false) }
    // An opaque route preview covers the one attached, warming scene. Opening
    // and returning retain its graphics context and the route list position.
    if (!landscape) LazyColumn(Modifier.fillMaxSize().background(Palette.Background).testTag("route_detail"), state = detailListState,
        contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Eyebrow(if (route.illustrative) "УЧЕБНЫЙ ОБРАЗЕЦ" else (region?.name ?: "МАРШРУТ").uppercase(Locale("ru")))
                Text(route.title, style = MaterialTheme.typography.headlineMedium)
                if (state.offlineSnapshot != null) Text("Из сохранённой области",
                    Modifier.testTag("saved_route_snapshot"), style = MaterialTheme.typography.bodySmall, color = Palette.Forest)
                StatusPill(route.currentStatusLabel ?: if (route.accessStatus == "closed") "Посещение приостановлено" else if (route.illustrative) "Учебная карточка" else "Условия уточняются", caution = route.accessStatus in setOf("closed", "restricted") || route.currentAdvisory != null)
                RouteEssentialMetrics(route)
            }
        }
        route.currentAdvisory?.let { advisory -> item {
            CardShell {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    TropaIcon(Glyph.INFO, color = Palette.Alert)
                    Text(if (route.accessStatus in setOf("closed", "restricted")) "Ограничение доступа" else "Условия посещения", style = MaterialTheme.typography.titleLarge, color = Palette.Alert)
                }
                Text(advisory, style = MaterialTheme.typography.bodyLarge)
                route.advisorySourceUrl?.let { url -> TrailTextButton(onClick = {
                    val uri = Uri.parse(url)
                    if (uri.scheme == "https") runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                }) { Text("Источник ограничения"); Spacer(Modifier.width(8.dp)); TropaIcon(Glyph.NEXT) } }
            }
        } }
        item { Text(route.summary, style = MaterialTheme.typography.bodyLarge, color = Palette.Muted) }
        if (route.geometryAsset != null || route.inlineGeometry != null) item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (route.id == "kavkaz-8a") "Направление к закрытому лагерю также показано на карте. Перед выходом уточните разрешённый путь у заповедника." else "Перед выходом уточните путь, доступность тропы и условия посещения.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                if (route.id != "kavkaz-8a") Text("Линия маршрута доступна без интернета. Для подробной карты за пределами Бзерпинского карниза понадобится подключение.", style = MaterialTheme.typography.bodySmall, color = Palette.Ochre)
                if (route.id == "kavkaz-8a") {
                    Text("Посмотрите на горы с разных сторон и познакомьтесь с районом будущего похода.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                    TrailButton(onClick = { onLandscapeChange(true) }, enabled = landscapeViewer.ready,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("open_landscape")) {
                        Text(if (landscapeViewer.ready) "Посмотреть рельеф" else if (landscapeViewer.error == null) "Готовим рельеф…" else "Рельеф пока недоступен")
                    }
                    landscapeViewer.error?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.WarningText)
                        if (landscapeViewer.canRetry) TrailTextButton(onClick = landscapeViewer::retry,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("landscape_retry_card")) {
                            Text("Попробовать снова")
                        }
                    }
                }
            }
        } else item {
            CardShell {
                TropaIcon(Glyph.MOUNTAIN, Modifier.size(48.dp))
                Text(if (route.illustrative) "Учебная карточка" else "Путь пока не добавлен", style = MaterialTheme.typography.titleLarge)
                Text(if (route.illustrative) "Попробуйте сохранить карточку и вернуться к ней без интернета." else "Сейчас доступны описание и источники. Перед походом уточните путь и условия посещения.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
            }
        }
        model.catalog.browserPlannerTarget(route)?.let { target ->
            item { BrowserPlannerCard(target, "open_route_planner") }
        }
        item { InfoCard(if (route.illustrative) "Это учебный пример: запись на настоящий поход не создаётся." else
            "Сложность: ${route.difficulty.lowercase(Locale("ru"))}. Перед выходом проверьте погоду, ограничения и подготовку группы.", tone = Palette.Ochre) }
        item { Text(route.description, style = MaterialTheme.typography.bodyLarge) }
        item {
            CardShell {
                Text("Перед походом", style = MaterialTheme.typography.titleLarge)
                route.notices.forEach { notice -> Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) { TropaIcon(Glyph.INFO, color = Palette.Ochre); Text(notice, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium) } }
                Text("Минимум 4 человека всего, включая гида. Набор запускается для конкретной даты, маршрута и подтверждённого гида.", style = MaterialTheme.typography.bodyMedium)
                if (!serviceMatches) Text("Для записи на этот маршрут восстановите подключение в профиле.", style = MaterialTheme.typography.bodyMedium, color = Palette.Ochre)
                if (route.apiRouteId != null) TrailButton(onClick = onRecruitment, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (serviceMatches) "Начать набор на этот маршрут" else "Подключить сервис карточки") }
                TrailOutlineButton(onClick = onTrips, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), shape = RoundedCornerShape(12.dp)) { Text(if (route.apiRouteId == null) "Найти поход" else "Посмотреть походы по маршруту") }
            }
        }
        if (region != null) item { OfflineAction(region, model, state) }
        item {
            CardShell {
                Eyebrow("ИСТОЧНИКИ")
                Text(route.sourceName, style = MaterialTheme.typography.titleSmall)
                route.sourceUrl?.let { url ->
                    TrailTextButton(onClick = {
                        val uri = Uri.parse(url)
                        if (uri.scheme == "https") runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                    }) { Text("Открыть первоисточник"); Spacer(Modifier.width(8.dp)); TropaIcon(Glyph.NEXT) }
                }
                route.officialEvidenceSummary?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                route.officialEvidenceUrl?.let { url ->
                    TrailTextButton(onClick = {
                        val uri = Uri.parse(url)
                        if (uri.scheme == "https") runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                    }) { Text("Официальное описание"); Spacer(Modifier.width(8.dp)); TropaIcon(Glyph.NEXT) }
                }
                route.additionalSources.distinctBy { it.url }.filter { it.url != route.sourceUrl && it.url != route.officialEvidenceUrl }.forEach { source ->
                    TrailTextButton(onClick = {
                        val uri = Uri.parse(source.url)
                        if (uri.scheme == "https") runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                    }) { Text(source.name); Spacer(Modifier.width(8.dp)); TropaIcon(Glyph.NEXT) }
                }
            }
        }
        item { CardShell { Text("Опыт участников", style = MaterialTheme.typography.titleLarge); Text("Отзывы публикуются в карточках завершённых походов после подтверждения участия.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted); TrailTextButton(onClick = onTrips) { Text("Посмотреть походы") } } }
    }
    }
}

@Composable
private fun OfflineAction(region: Region, model: MainViewModel, state: AppState) {
    val installed = state.packs.firstOrNull { it.regionId == region.id }
    val busy = state.busyId == "pack:${region.id}"
    val detailed = remember(model.catalog, region.id) { model.catalog.hasDetailedOfflineMap(region.id) }
    CardShell {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TropaIcon(if (installed != null) Glyph.CHECK else Glyph.SAVE)
            Text(if (installed != null) "Сохранено на телефоне" else "Возьмите карту с собой", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
        }
        Text(if (detailed) "Сохраняются карточки и линии маршрутов. Обзор России и подробная карта района Бзерпинского карниза уже встроены в приложение. Для подробной карты других районов понадобится интернет." else "Сохраняются карточки и линии маршрутов. Обзорная карта уже встроена в приложение; подробная подложка этого района требует интернета.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
        if (installed != null && installed.version != model.catalog.version) Text("После обновления приложения обновите сохранённые данные этой области.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (installed != null) Text(sizeLabel(installed.sizeBytes), style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
        TrailOutlineButton(onClick = { model.saveRegion(region) }, enabled = state.busyId == null,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("save_pack"), shape = RoundedCornerShape(12.dp)) {
            Text(if (busy) "Сохраняем данные…" else if (installed == null) "Сохранить офлайн" else "Обновить сохранённые данные")
        }
        Text("Сохранение карты не подтверждает безопасность и актуальность условий маршрута.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SavedScreen(model: MainViewModel, state: AppState) {
    var remove by remember { mutableStateOf<InstalledPackEntity?>(null) }
    var packsTab by rememberSaveable { mutableStateOf(false) }
    val routeList = rememberLazyListState()
    val packList = rememberLazyListState()
    Column(Modifier.fillMaxSize()) {
        FlowRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            TrailChoice(!packsTab, { packsTab = false }, label = { Text("Маршруты ${state.savedRoutes.size}") },
                modifier = Modifier.testTag("saved_routes_tab"))
            TrailChoice(packsTab, { packsTab = true }, label = { Text("Без сети ${state.packs.size}") },
                modifier = Modifier.testTag("saved_offline_tab"))
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("saved_list"), state = if (packsTab) packList else routeList,
            contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (packsTab) {
                if (state.packs.isEmpty()) item { EmptyCard("Нет сохранённых областей", "Откройте район на карте и выберите «Сохранить офлайн».", Glyph.SAVE) }
                items(state.packs, key = { it.regionId }) { pack ->
                    CardShell {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(pack.title, style = MaterialTheme.typography.titleLarge)
                                Text("${sizeLabel(pack.sizeBytes)} · ${DateFormat.getDateInstance(DateFormat.MEDIUM, Locale("ru")).format(Date(pack.installedAt))}", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                            }
                            TrailIconButton(onClick = { remove = pack }, Modifier.testTag("remove_pack_${pack.regionId}"), enabled = state.busyId == null) { TropaIcon(Glyph.TRASH, description = "Удалить пакет ${pack.title}") }
                        }
                        Text(if (pack.includesTrailGeometry) "Карточки и линии доступны без сети. Обзорная карта встроена в приложение."
                            else "Карточки доступны без сети. Обзорная карта встроена в приложение.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                        if (pack.version != model.catalog.version) Text("Обновите сохранённые данные после обновления приложения.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                        TrailButton(onClick = { model.openPack(pack) }, modifier = Modifier.fillMaxWidth().testTag("open_pack_${pack.regionId}"),
                            enabled = state.busyId == null) { Text("Открыть область") }
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            TrailTextButton(onClick = { model.verifyPack(pack) }, Modifier.testTag("verify_pack_${pack.regionId}"), enabled = state.busyId == null) { Text("Проверить") }
                            TrailTextButton(onClick = { model.selectRegion(pack.regionId) }, Modifier.testTag("update_pack_${pack.regionId}"), enabled = state.busyId == null) { Text("Обновить") }
                        }
                        if (state.busyId?.endsWith(":${pack.regionId}") == true) LinearProgressIndicator(Modifier.fillMaxWidth())
                    }
                }
                item { InfoCard("Сохраняются карточки и линии. Подробная подложка большинства районов требует интернета; условия и погода без сети не обновляются.") }
            } else {
                if (state.savedRoutes.isEmpty()) item {
                    EmptyCard("Здесь будут ваши маршруты", "Нажмите «Сохранить» в карточке. Она останется на телефоне и будет доступна без сети.", Glyph.BOOKMARK)
                    TrailTextButton(onClick = { model.switchScreen(Screen.EXPLORE) }, Modifier.fillMaxWidth()) { Text("Выбрать на карте") }
                }
                items(state.savedRoutes, key = { it.routeId }) { saved -> model.route(saved.routeId)?.let { RouteCard(it, true) { model.selectRoute(it.id) } } }
            }
        }
    }
    remove?.let { pack -> TrailDialog(
        onDismissRequest = { remove = null }, title = { Text("Удалить данные области?") },
        text = { Text("Удаление области «${pack.title}» освободит ${sizeLabel(pack.sizeBytes)}. Отдельно сохранённые карточки останутся.") },
        confirmButton = { TrailTextButton(onClick = { model.removePack(pack); remove = null }, Modifier.testTag("remove_pack_confirm"), enabled = state.busyId == null) { Text("Удалить") } },
        dismissButton = { TrailTextButton(onClick = { remove = null }) { Text("Оставить") } },
    ) }
}

@Composable
internal fun CardShell(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Card(Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = Palette.Surface), border = BorderStroke(1.dp, Palette.Line)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}

@Composable
internal fun InfoCard(message: String, tone: androidx.compose.ui.graphics.Color = Palette.Forest) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Palette.Surface).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        TropaIcon(Glyph.INFO, color = tone)
        Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
    }
}

@Composable
internal fun EmptyCard(title: String, message: String, glyph: Glyph) {
    CardShell {
        TropaIcon(glyph, Modifier.size(32.dp), color = Palette.Muted)
        Text(title, style = MaterialTheme.typography.titleLarge)
        Text(message, style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
    }
}

@Composable
internal fun SectionHeading(title: String, subtitle: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) { Text(title, style = MaterialTheme.typography.titleLarge); Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = Palette.Muted) }
}

@Composable
internal fun PageHeading(title: String, subtitle: String) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) { Text(title, style = MaterialTheme.typography.headlineLarge); Text(subtitle, style = MaterialTheme.typography.bodyLarge, color = Palette.Muted) }
}

@Composable
private fun Eyebrow(text: String) { Text(text, style = MaterialTheme.typography.labelSmall, color = Palette.Muted, letterSpacing = 1.sp) }

@Composable
internal fun StatusPill(text: String, caution: Boolean = false, modifier: Modifier = Modifier) {
    Surface(modifier = modifier, shape = RoundedCornerShape(8.dp), color = if (caution) Palette.Ochre.copy(alpha = .09f) else Palette.Land) {
        Text(text, Modifier.padding(horizontal = 8.dp, vertical = 4.dp), style = MaterialTheme.typography.labelSmall, color = if (caution) Palette.WarningText else Palette.Forest)
    }
}

@Composable
private fun Metric(label: String, value: String, modifier: Modifier) {
    Column(modifier.clip(RoundedCornerShape(12.dp)).background(Palette.Surface).padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
        Text(value, style = MaterialTheme.typography.titleLarge)
    }
}

internal fun distance(meters: Double) = if (meters >= 1_000) "${String.format(Locale("ru"), "%.1f", meters / 1_000).removeSuffix(",0")} км" else "${meters.toInt()} м"
private fun sizeLabel(bytes: Long) = if (bytes < 1_048_576) "${bytes / 1024} КБ" else "${String.format(Locale("ru"), "%.1f", bytes / 1_048_576.0)} МБ"
