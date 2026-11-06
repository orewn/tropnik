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
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
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
import ru.tropa.app.data.ConnectionState
import ru.tropa.app.data.InstalledPackEntity
import ru.tropa.app.data.PositionState
import ru.tropa.app.data.Region
import ru.tropa.app.data.TrailRoute
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
    BackHandler(!landscape && (state.routeId != null || state.regionId != null)) { model.back() }

    Scaffold(
        containerColor = Palette.Background,
        snackbarHost = { SnackbarHost(snackbars) },
        bottomBar = {
            if (!landscape) NavigationBar(containerColor = Palette.Surface, tonalElevation = 0.dp) {
                listOf(
                    Triple(Screen.EXPLORE, "Карта", Glyph.MAP),
                    Triple(Screen.SAVED, "Сохранено", Glyph.SAVE),
                    Triple(Screen.TRIPS, "Походы", Glyph.PEOPLE),
                    Triple(Screen.PROFILE, "Профиль", Glyph.USER),
                ).forEach { (screen, label, glyph) ->
                    NavigationBarItem(
                        selected = state.screen == screen,
                        onClick = { model.switchScreen(screen) },
                        icon = { TropaIcon(glyph, color = if (state.screen == screen) Palette.Forest else Palette.Muted) },
                        label = { Text(label, style = MaterialTheme.typography.labelSmall) },
                        colors = NavigationBarItemDefaults.colors(indicatorColor = Palette.Land),
                        modifier = Modifier.testTag("nav_${screen.name.lowercase()}"),
                    )
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (!landscape) BrandBar(state, onBack = model::back)
            val route = model.route(state.routeId)
            if (route != null) RouteDetail(route, model, state, serviceMatches = route.apiOrigin == null || route.apiOrigin == connected.serverUrl, onTrips = {
                if (route.apiOrigin != null && route.apiOrigin != connected.serverUrl) model.switchScreen(Screen.PROFILE)
                else { online.filterRoute(route.apiRouteId); model.switchScreen(Screen.TRIPS) }
            }, onRecruitment = {
                if (route.apiOrigin != null && route.apiOrigin != connected.serverUrl) model.switchScreen(Screen.PROFILE)
                else { route.apiRouteId?.let(online::composeRecruitment); model.switchScreen(Screen.TRIPS) }
            }, landscape = landscape, onLandscapeChange = { landscape = it })
            else when (state.screen) {
                Screen.EXPLORE -> ExploreScreen(model, state) {
                    permissions.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                }
                Screen.SAVED -> SavedScreen(model, state)
                Screen.TRIPS -> OnlineTripsScreen(online, connected, onProfile = { model.switchScreen(Screen.PROFILE) }, onRoute = model::selectPublishedRoute)
                Screen.PROFILE -> OnlineProfileScreen(online, connected, onSources = { showSources = true })
            }
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
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (state.regionId != null || state.routeId != null) {
            TrailIconButton(onClick = onBack, Modifier.testTag("go_back")) { TropaIcon(Glyph.BACK, description = "Назад") }
        } else {
            Box(Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(Palette.Forest), contentAlignment = Alignment.Center) {
                TropaIcon(Glyph.MOUNTAIN, color = Palette.Surface)
            }
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text("ТРОПНИК", style = MaterialTheme.typography.titleLarge, letterSpacing = 3.sp)
            Text("Маршруты и люди", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
        }
        StatusPill(when (state.connection) {
            ConnectionState.ONLINE -> "Есть сеть"
            ConnectionState.LIMITED -> "Сеть ограничена"
            ConnectionState.OFFLINE -> "Без сети"
        }, caution = state.connection != ConnectionState.ONLINE)
    }
}

@Composable
private fun ExploreScreen(model: MainViewModel, state: AppState, onLocation: () -> Unit) {
    val selected = model.region(state.regionId)
    val regions = model.catalog.regions.filter { state.search.isBlank() || (it.name + " " + it.subtitle).contains(state.search.trim(), ignoreCase = true) }
    val regionRoutes = model.catalog.routes.filter { selected?.id in it.regionIds && !it.illustrative }
    LazyColumn(
        Modifier.fillMaxSize().testTag("explore_list"),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Eyebrow(if (selected == null) "РОССИЯ · ПЕРВЫЕ НАПРАВЛЕНИЯ" else "ВЫБИРАЕМ РАЙОН")
                Text(selected?.name ?: "Дальше начинается\nваша история.", style = MaterialTheme.typography.headlineLarge)
                Text(selected?.subtitle ?: "Находите маршрут и людей, с которыми по пути.", color = Palette.Muted, style = MaterialTheme.typography.bodyLarge)
            }
        }
        if (selected == null) item {
            OutlinedTextField(
                value = state.search, onValueChange = model::search,
                modifier = Modifier.fillMaxWidth().testTag("region_search"),
                placeholder = { Text("Найти регион", style = MaterialTheme.typography.bodyLarge) },
                leadingIcon = { TropaIcon(Glyph.SEARCH) }, singleLine = true,
                shape = RoundedCornerShape(12.dp),
                trailingIcon = if (state.search.isNotBlank()) { { TrailIconButton(onClick = { model.search("") }) { TropaIcon(Glyph.CLOSE, description = "Очистить поиск") } } } else null,
            )
        }
        item {
            Box(Modifier.fillMaxWidth().height(if (selected == null) 280.dp else 320.dp).clip(RoundedCornerShape(16.dp))) {
                TropaMap(model.catalog.regions, selected, position = state.position, connection = state.connection, onSelectRegion = model::selectRegion, modifier = Modifier.fillMaxSize())
                Surface(Modifier.align(Alignment.TopStart).padding(12.dp), shape = RoundedCornerShape(8.dp), color = Palette.Surface) {
                    Text(if (selected == null) "Выберите направление ниже" else "Обзор района", Modifier.padding(horizontal = 12.dp, vertical = 8.dp), style = MaterialTheme.typography.labelSmall)
                }
                Surface(Modifier.align(Alignment.TopEnd).padding(12.dp), shape = RoundedCornerShape(12.dp), color = Palette.Surface) {
                    TrailIconButton(onClick = onLocation, enabled = state.position != PositionState.Locating, modifier = Modifier.testTag("locate")) {
                        TropaIcon(Glyph.LOCATE, description = "Показать моё местоположение")
                    }
                }
            }
        }
        when (val position = state.position) {
            PositionState.Locating -> item { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text("Определяем геопозицию…", style = MaterialTheme.typography.bodyMedium) } }
            is PositionState.Problem -> item { InfoCard(position.message, tone = Palette.Ochre) }
            is PositionState.Ready -> item { InfoCard("Позиция на ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(position.fix.measuredAt))}. Точность около ${position.fix.accuracy.toInt()} м. Это разовое измерение; обновите его при перемещении.") }
            else -> Unit
        }
        if (selected == null) {
            item { SectionHeading("Куда отправимся", "Выберите регион на карте или в списке") }
            if (regions.isEmpty()) item { EmptyCard("Регион не найден", "Попробуйте другое название: например, «Алтай», «Карелия» или «Крым».", Glyph.SEARCH) }
            items(regions, key = { it.id }) { region -> RegionCard(region) { model.selectRegion(region.id) } }
            item { InfoCard("Карта помогает выбрать направление. Проверка конкретной тропы, условий и гида выполняется перед походом.") }
        } else {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(selected.description, style = MaterialTheme.typography.bodyLarge)
                    OfflineAction(selected, model, state)
                }
            }
            item { SectionHeading("Маршруты района", "Данные из открытых источников с указанным статусом проверки") }
            if (regionRoutes.isEmpty()) item { EmptyCard("Маршруты ещё готовятся", "Здесь появятся карточки с источниками, сложностью и датой проверки. Непроверенные тропы не выдаются за готовые походы.", Glyph.MOUNTAIN) }
            items(regionRoutes, key = { it.id }) { route -> RouteCard(route, saved = state.savedRoutes.any { it.routeId == route.id }) { model.selectRoute(route.id) } }
            item { InfoCard("Поход начинается с группы минимум из 4 человек, включая проверенного гида. Число мест и допустимое соотношение участников определяются для конкретного маршрута.") }
        }
        item {
            CardShell {
                Eyebrow("ЗНАКОМСТВО С ПРИЛОЖЕНИЕМ")
                Text("Как всё устроено", style = MaterialTheme.typography.titleLarge)
                Text("Попробуйте сохранить учебную карточку. Она останется на телефоне даже без интернета.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                TrailTextButton(onClick = { model.selectRoute("learning-route") }, Modifier.testTag("open_learning")) { Text("Открыть учебную карточку"); Spacer(Modifier.width(8.dp)); TropaIcon(Glyph.NEXT) }
            }
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
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                StatusPill(route.currentStatusLabel ?: if (route.illustrative) "Учебный пример" else "Требует проверки", caution = true)
                if (saved) TropaIcon(Glyph.BOOKMARK, description = "Сохранено на устройстве")
            }
            Text(route.title, style = MaterialTheme.typography.titleLarge)
            Text(route.summary, style = MaterialTheme.typography.bodyMedium, color = Palette.Muted, maxLines = 4, overflow = TextOverflow.Ellipsis)
            route.distanceMeters?.let { Text("${distance(it)} · в описании источника", style = MaterialTheme.typography.labelMedium) }
            Row(verticalAlignment = Alignment.CenterVertically) { Text("Посмотреть карточку", style = MaterialTheme.typography.labelMedium, color = Palette.Forest); Spacer(Modifier.width(8.dp)); TropaIcon(Glyph.NEXT) }
        }
    }
}

@Composable
private fun RouteDetail(route: TrailRoute, model: MainViewModel, state: AppState, serviceMatches: Boolean,
                        onTrips: () -> Unit, onRecruitment: () -> Unit, landscape: Boolean, onLandscapeChange: (Boolean) -> Unit) {
    val context = LocalContext.current
    val hasLandscape = route.id == "kavkaz-8a"
    val landscapeDocument by rememberLandscapeDocument(hasLandscape)
    val landscapeViewer = rememberLandscapeViewer(landscapeDocument, hasLandscape)
    val detailListState = rememberLazyListState()
    val region = model.region(route.regionId)
    val saved = state.savedRoutes.any { it.routeId == route.id }
    Box(Modifier.fillMaxSize()) {
    if (hasLandscape) LocalLandscapeScene(landscapeViewer, visible = landscape) { onLandscapeChange(false) }
    // An opaque route preview covers the one attached, warming scene. Opening
    // and returning retain its graphics context and the route list position.
    if (!landscape) LazyColumn(Modifier.fillMaxSize().background(Palette.Background).testTag("route_detail"), state = detailListState,
        contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Eyebrow(if (route.illustrative) "УЧЕБНЫЙ ОБРАЗЕЦ" else (region?.name ?: "МАРШРУТ").uppercase(Locale("ru")))
                Text(route.title, style = MaterialTheme.typography.headlineLarge)
                StatusPill(route.currentStatusLabel ?: if (route.illustrative) "Не является реальной тропой" else "Условия и сложность не подтверждены", caution = true)
                Text(route.summary, style = MaterialTheme.typography.bodyLarge, color = Palette.Muted)
            }
        }
        route.currentAdvisory?.let { advisory -> item {
            CardShell {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    TropaIcon(Glyph.INFO, color = Palette.Alert)
                    Text("Ограничение доступа", style = MaterialTheme.typography.titleLarge, color = Palette.Alert)
                }
                Text(advisory, style = MaterialTheme.typography.bodyLarge)
                route.advisorySourceUrl?.let { url -> TrailTextButton(onClick = {
                    val uri = Uri.parse(url)
                    if (uri.scheme == "https") runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                }) { Text("Источник ограничения"); Spacer(Modifier.width(8.dp)); TropaIcon(Glyph.NEXT) } }
            }
        } }
        if (route.geometryAsset != null || route.inlineGeometry != null) item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.fillMaxWidth().height(320.dp).clip(RoundedCornerShape(16.dp))) {
                    TropaMap(model.catalog.regions, region, route, connection = state.connection, modifier = Modifier.fillMaxSize())
                    Surface(Modifier.align(Alignment.TopStart).padding(12.dp), shape = RoundedCornerShape(8.dp), color = Palette.Surface) {
                        Text(if (route.currentAdvisory != null) "Линия маршрута · доступ ограничен" else if (route.apiRouteId != null) "Геометрия опубликованной версии" else "Справочная геометрия OSM", Modifier.padding(8.dp), style = MaterialTheme.typography.labelSmall)
                    }
                }
                Text(if (route.id == "kavkaz-8a") "На карте показан полный набор сегментов OSM, включая направление к закрытому лагерю. Граница закрытого участка не установлена по геометрии. Линия не является разрешённым навигационным треком." else if (route.apiRouteId != null) "Линия получена от сервиса для указанной версии. Отображение линии не является навигацией, проверкой проходимости или разрешением на выход." else "Линия содержит исходные сегменты и возможные ответвления. Это не готовый навигационный трек.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                if (route.id != "kavkaz-8a") Text("Линия маршрута доступна без интернета. Подробная подложка вне района Бзерпинского карниза подгружается только при включённой «Сети»; автономно остаётся обзорная карта.", style = MaterialTheme.typography.bodySmall, color = Palette.Ochre)
                if (route.id == "kavkaz-8a") {
                    Text("Рельеф рассчитан по реальной модели поверхности. Кнопка «Ракурс» меняет перспективу плоской карты; объёмная модель открывается отдельно.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                    TrailButton(onClick = { onLandscapeChange(true) }, enabled = landscapeViewer.ready,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("open_landscape")) {
                        Text(if (landscapeViewer.ready) "Открыть 3D ландшафт" else if (landscapeViewer.error == null) "Готовим 3D ландшафт…" else "3D сцена недоступна")
                    }
                    landscapeViewer.error?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.WarningText)
                        if (landscapeViewer.canRetry) TrailTextButton(onClick = landscapeViewer::retry,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("landscape_retry_card")) {
                            Text("Подготовить сцену заново")
                        }
                    }
                }
            }
        } else item {
            CardShell {
                TropaIcon(Glyph.MOUNTAIN, Modifier.size(48.dp))
                Text(if (route.illustrative) "Без выдуманной тропы" else "Геометрия ещё не подтверждена", style = MaterialTheme.typography.titleLarge)
                Text(if (route.illustrative) "Образец помогает проверить приложение. У него нет географической линии, которую можно принять за настоящий путь." else "Описание доступно, но линия на карте не показана, пока не получен и не проверен соответствующий источник.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
            }
        }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Metric("Длина", route.distanceMeters?.let(::distance) ?: "Нет данных", Modifier.weight(1f))
                Metric("Набор высоты", route.ascentMeters?.let { "${it.toInt()} м" } ?: "Нет данных", Modifier.weight(1f))
            }
        }
        item { Metric("Длительность по источнику", route.durationText ?: route.durationMinutes?.let { "$it мин" } ?: "Нет данных", Modifier.fillMaxWidth()) }
        item { InfoCard(if (route.illustrative) "Все действия с образцом происходят локально. Никто не записывается на реальный поход." else if (route.apiRouteId != null) "Параметры маршрута получены от сервиса. Сложность: ${route.difficulty.lowercase(Locale("ru"))}. Перед выходом проверьте актуальность условий." else "Параметры приведены только при наличии в источнике. Сумма сегментов OSM может отличаться от длины маршрута из-за веток. Оценка сложности: ${route.difficulty.lowercase(Locale("ru"))}.", tone = Palette.Ochre) }
        item {
            TrailButton(onClick = { model.toggleSaved(route) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("save_route"),
                enabled = state.busyId == null, shape = RoundedCornerShape(12.dp), contentPadding = PaddingValues(12.dp, 8.dp)) {
                TropaIcon(if (saved) Glyph.CHECK else Glyph.BOOKMARK, color = Palette.Surface)
                Spacer(Modifier.width(8.dp)); Text(if (saved) "Сохранено · убрать" else "Сохранить карточку")
            }
        }
        item { Text(route.description, style = MaterialTheme.typography.bodyLarge) }
        item {
            CardShell {
                Text("Перед походом", style = MaterialTheme.typography.titleLarge)
                route.notices.forEach { notice -> Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) { TropaIcon(Glyph.INFO, color = Palette.Ochre); Text(notice, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium) } }
                Text("Минимум 4 человека всего, включая гида. Набор запускается для конкретной даты, маршрута и подтверждённого гида.", style = MaterialTheme.typography.bodyMedium)
                if (!serviceMatches) Text("Карточка сохранена с другого сервиса: ${route.apiOrigin}. Подключите его в профиле, чтобы работать с этим маршрутом.", style = MaterialTheme.typography.bodyMedium, color = Palette.Ochre)
                if (route.apiRouteId != null) TrailButton(onClick = onRecruitment, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (serviceMatches) "Начать набор на этот маршрут" else "Подключить сервис карточки") }
                TrailOutlineButton(onClick = onTrips, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), shape = RoundedCornerShape(12.dp)) { Text(if (route.apiRouteId == null) "Открыть походы сервиса" else "Посмотреть походы по маршруту") }
            }
        }
        if (region != null) item { OfflineAction(region, model, state) }
        item {
            CardShell {
                Eyebrow("ПРОИСХОЖДЕНИЕ ДАННЫХ")
                Text(route.sourceName, style = MaterialTheme.typography.titleSmall)
                Text("Источник просмотрен: ${route.sourceDate}. Это дата проверки источника, не дата осмотра тропы.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                Text(route.sourceLicense, style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                route.sourceUrl?.let { url ->
                    TrailTextButton(onClick = {
                        val uri = Uri.parse(url)
                        if (uri.scheme == "https") runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                    }) { Text("Открыть первоисточник"); Spacer(Modifier.width(8.dp)); TropaIcon(Glyph.NEXT) }
                }
                route.officialEvidenceSummary?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                route.officialEvidenceScope?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.Muted) }
                route.officialEvidenceCheckedAt?.let { Text("Официальный источник просмотрен: $it", style = MaterialTheme.typography.bodySmall, color = Palette.Muted) }
                route.officialEvidenceUrl?.let { url ->
                    TrailTextButton(onClick = {
                        val uri = Uri.parse(url)
                        if (uri.scheme == "https") runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                    }) { Text("Официальное описание"); Spacer(Modifier.width(8.dp)); TropaIcon(Glyph.NEXT) }
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
    CardShell {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TropaIcon(if (installed != null) Glyph.CHECK else Glyph.SAVE)
            Text(if (installed != null) "Сохранено на телефоне" else "Возьмите карту с собой", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
        }
        Text(if (region.id == "krasnodar") "Обзор края и подробная карта только района Бзерпинского карниза. Маршруты рощи в Хосте находятся вне подробного пакета. Пилотная карта уже включена в приложение." else "Сохраняются обзорная карта и доступные карточки. Подробные тропы для этого региона в сборку не включены.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (installed != null) Text("${sizeLabel(installed.sizeBytes)} · версия ${installed.version}", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
        TrailOutlineButton(onClick = { model.saveRegion(region) }, enabled = state.busyId == null,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("save_pack"), shape = RoundedCornerShape(12.dp)) {
            Text(if (busy) "Проверяем файлы…" else if (installed == null) "Сохранить офлайн" else "Обновить локальный пакет")
        }
        Text("Сохранение карты не подтверждает безопасность и актуальность условий маршрута.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
    }
}

@Composable
private fun SavedScreen(model: MainViewModel, state: AppState) {
    var remove by remember { mutableStateOf<InstalledPackEntity?>(null) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { PageHeading("Всё под рукой", "Карточки и карты хранятся на этом телефоне.") }
        item { SectionHeading("Офлайн пакеты", "Проверенные контрольные суммы файлов") }
        if (state.packs.isEmpty()) item { EmptyCard("Пока нет сохранённых областей", "Откройте регион на карте и нажмите «Сохранить офлайн».", Glyph.SAVE) }
        items(state.packs, key = { it.regionId }) { pack ->
            CardShell {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(pack.title, style = MaterialTheme.typography.titleLarge)
                        Text("${sizeLabel(pack.sizeBytes)} · ${DateFormat.getDateInstance(DateFormat.MEDIUM, Locale("ru")).format(Date(pack.installedAt))}", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                    }
                    TrailIconButton(onClick = { remove = pack }) { TropaIcon(Glyph.TRASH, description = "Удалить пакет ${pack.title}") }
                }
                Text(if (pack.includesTrailGeometry) "Обзорная карта и исходные линии маршрута. Полевой проверки нет." else "Обзорная карта. Подробные тропы не включены.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TrailTextButton(onClick = { model.selectRegion(pack.regionId) }) { Text("Открыть") }
                    TrailTextButton(onClick = { model.verifyPack(pack) }) { Text("Проверить файлы") }
                }
            }
        }
        item { SectionHeading("Сохранённые карточки", "Читаются даже после перезапуска без сети") }
        if (state.savedRoutes.isEmpty()) item { EmptyCard("Оставьте место для будущих походов", "Сохраните карточку маршрута, чтобы вернуться к ней позже.", Glyph.BOOKMARK) }
        items(state.savedRoutes, key = { it.routeId }) { saved -> model.route(saved.routeId)?.let { RouteCard(it, true) { model.selectRoute(it.id) } } }
        item { InfoCard("Без интернета не обновляются условия, погода и состав группы. Отправка сообщений и подтверждение участия требуют связи.") }
    }
    remove?.let { pack -> TrailDialog(
        onDismissRequest = { remove = null }, title = { Text("Удалить офлайн пакет?") },
        text = { Text("Пакет «${pack.title}» освободит ${sizeLabel(pack.sizeBytes)}. Сохранённые карточки останутся.") },
        confirmButton = { TrailTextButton(onClick = { model.removePack(pack); remove = null }) { Text("Удалить") } },
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
internal fun StatusPill(text: String, caution: Boolean = false) {
    Surface(shape = RoundedCornerShape(8.dp), color = if (caution) Palette.Ochre.copy(alpha = .09f) else Palette.Land) {
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

private fun distance(meters: Double) = if (meters >= 1_000) "${String.format(Locale("ru"), "%.1f", meters / 1_000).removeSuffix(",0")} км" else "${meters.toInt()} м"
private fun sizeLabel(bytes: Long) = if (bytes < 1_048_576) "${bytes / 1024} КБ" else "${String.format(Locale("ru"), "%.1f", bytes / 1_048_576.0)} МБ"
