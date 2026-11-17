package ru.tropa.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import ru.tropa.app.AppState
import ru.tropa.app.BrowsePanel
import ru.tropa.app.MainViewModel
import ru.tropa.app.Screen
import ru.tropa.app.destination
import ru.tropa.app.data.TrailRoute
import ru.tropa.app.data.browserPlannerTarget

/** The map has one composition slot, outside every scrolling list. Lists and
 * route details use the remaining viewport only in settled panel states. */
@Composable
internal fun MobileMapWorkspace(
    model: MainViewModel,
    state: AppState,
    active: Boolean,
    presentation: MapPresentationState,
    landscape: Boolean,
    onLandscapeChange: (Boolean) -> Unit,
    serviceMatches: Boolean,
    onTrips: () -> Unit,
    onRecruitment: () -> Unit,
    onLocation: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val catalogue = model.displayCatalog
    val route = model.route(state.routeId)
    val region = model.region(state.regionId ?: route?.regionId)
    val mapRegions = remember(catalogue, state.catalogTerritories) {
        catalogue.regions.filter { it.territory == state.catalogTerritories }
    }
    val trails = remember(catalogue, state.search, region?.id) {
        catalogue.referenceRoutes(state.search, region?.id)
    }
    val holder = rememberSaveableStateHolder()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val fontScale = LocalDensity.current.fontScale
    val showMap = active && !landscape && state.browsePanel == BrowsePanel.MAP
    val mapAction = {
        focus.clearFocus()
        keyboard?.hide()
        model.showBrowsePanel(BrowsePanel.MAP)
    }
    val contentAction = { model.showBrowsePanel(BrowsePanel.CONTENT) }
    BoxWithConstraints(modifier.testTag("map_workspace")) {
        val compact = maxHeight < 480.dp || fontScale >= 1.6f
        val sideBySide = maxWidth >= 600.dp && maxWidth > maxHeight
        Column(Modifier.fillMaxSize().background(Palette.Background)) {
            if (active && !landscape) {
                if (route == null) {
                    Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (state.regionId != null) TrailIconButton(onClick = { focus.clearFocus(); keyboard?.hide(); model.back() },
                            modifier = Modifier.testTag("go_back")) { TropaIcon(Glyph.BACK, description = "Назад к районам") }
                        OutlinedTextField(state.search, model::search,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("region_search")
                                .semantics { contentDescription = "Поиск района или маршрута" }
                                .onFocusChanged { if (it.isFocused) contentAction() },
                            singleLine = true, placeholder = { Text(if (region == null) "Район или маршрут" else "Маршрут в этом районе", style = MaterialTheme.typography.bodyMedium) },
                            leadingIcon = { TropaIcon(Glyph.SEARCH) },
                            trailingIcon = if (state.search.isNotEmpty()) {{ TrailIconButton(onClick = { model.search("") }) {
                                TropaIcon(Glyph.CLOSE, description = "Очистить поиск")
                            } }} else null,
                            shape = RoundedCornerShape(12.dp),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                            keyboardActions = KeyboardActions(onSearch = { focus.clearFocus(); keyboard?.hide(); contentAction() }),
                        )
                    }
                } else {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TrailIconButton(onClick = model::back, modifier = Modifier.testTag("go_back")) { TropaIcon(Glyph.BACK, description = "Назад к результатам") }
                        Text(region?.name ?: "Маршрут", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall,
                            maxLines = 2, overflow = TextOverflow.Ellipsis)
                        if (!showMap) TrailTextButton(onClick = mapAction, modifier = Modifier.testTag("show_map")) { Text("На карту") }
                    }
                }
            }
            // The first slot always owns the same map. The second receives
            // a settled amount of real space: below in portrait, beside it in
            // landscape. Nothing covers the WebView or changes per drag frame.
            MapViewportLayout(visible = showMap, sideBySide = sideBySide,
                peekHeight = if (route == null) { if (fontScale >= 1.6f) 128.dp else 88.dp }
                    else if (compact) 160.dp else if (route.currentAdvisory != null) 196.dp else 164.dp,
                modifier = if (showMap) Modifier.fillMaxWidth().weight(1f)
                    else Modifier.fillMaxWidth().height(0.dp).clipToBounds().clearAndSetSemantics { },
                map = {
                    TropaMap(mapRegions, region, route, state.position, state.connection,
                        onSelectRegion = if (state.offlineSnapshot == null) ({ model.selectRegion(it, BrowsePanel.MAP) }) else null,
                        visibleTrails = trails, onSelectTrail = { model.selectRoute(it, BrowsePanel.MAP) },
                        active = showMap, presentation = presentation, focusScope = state.screen.destination().name, onLocation = onLocation,
                        modifier = Modifier.fillMaxSize().testTag(if (route == null) "explore_map" else "route_map"))
                }, peek = {
                    Surface(Modifier.fillMaxSize().testTag("map_context"), color = Palette.Surface, tonalElevation = 0.dp) {
                        Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (route == null) {
                                Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                                        Text(region?.name ?: "Маршруты по России", style = MaterialTheme.typography.titleSmall,
                                            maxLines = if (compact) 1 else 2, overflow = TextOverflow.Ellipsis)
                                        Text("${trails.size} ${routeCountLabel(trails.size)}", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                                    }
                                    TrailButton(onClick = contentAction, modifier = Modifier.testTag("show_results")) { Text("Список") }
                                }
                            } else {
                                Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()),
                                    verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Text(route.title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                    if (!compact) RouteEssentialMetrics(route)
                                    val advisoryLabel = route.currentStatusLabel
                                        ?: if (route.accessStatus == "closed") "Посещение приостановлено"
                                        else if (route.currentAdvisory != null) "Есть условия посещения — откройте карточку" else null
                                    advisoryLabel?.let { Text(it, style = MaterialTheme.typography.bodySmall,
                                        color = if (route.accessStatus == "closed") Palette.Alert else Palette.Ochre) }
                                }
                                RouteActionBar(route, model, state, onDetails = contentAction)
                            }
                        }
                    }
                })
            if (active && !showMap) {
                if (route != null) {
                    Column(Modifier.weight(1f)) {
                        Box(Modifier.weight(1f)) {
                            holder.SaveableStateProvider("route:${state.screen}:${route.id}") {
                                RouteDetail(route, model, state, serviceMatches, onTrips, onRecruitment, landscape, onLandscapeChange)
                            }
                        }
                        if (!landscape) Surface(color = Palette.Surface) {
                            RouteActionBar(route, model, state, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
                        }
                    }
                } else {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(region?.name ?: if (state.search.isNotBlank()) "Результаты поиска" else "Выберите район",
                                style = MaterialTheme.typography.titleSmall)
                            if (region != null || state.search.isNotBlank()) Text("${trails.size} ${routeCountLabel(trails.size)}",
                                style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                        }
                        TrailTextButton(onClick = mapAction, modifier = Modifier.testTag("show_map")) { Text("На карту") }
                    }
                    Box(Modifier.weight(1f)) {
                        holder.SaveableStateProvider("results:${state.regionId}:${state.catalogTerritories}") {
                            ExploreScreen(model, state)
                        }
                    }
                }
            }
        }
    }
}

/** Two stable composition slots with an actual free canvas rectangle. */
@Composable
private fun MapViewportLayout(visible: Boolean, sideBySide: Boolean, peekHeight: Dp,
    modifier: Modifier, map: @Composable () -> Unit, peek: @Composable () -> Unit) {
    Layout(content = {
        Box(Modifier.clipToBounds()) { map() }
        if (visible) Box(Modifier.clipToBounds()) { peek() }
    }, modifier = modifier) { children, constraints ->
        val width = constraints.maxWidth
        val height = constraints.maxHeight
        val sideWidth = if (visible && sideBySide) minOf(288.dp.roundToPx(), (width * .4f).toInt()) else 0
        val bottomHeight = if (visible && !sideBySide) minOf(peekHeight.roundToPx(), height) else 0
        val mapWidth = (width - sideWidth).coerceAtLeast(0)
        val mapHeight = (height - bottomHeight).coerceAtLeast(0)
        val mapPlaceable = children[0].measure(Constraints.fixed(mapWidth, mapHeight))
        val peekPlaceable = if (visible) children[1].measure(Constraints.fixed(
            if (sideBySide) sideWidth else width, if (sideBySide) height else bottomHeight)) else null
        layout(width, height) {
            mapPlaceable.placeRelative(0, 0)
            peekPlaceable?.placeRelative(if (sideBySide) mapWidth else 0, if (sideBySide) 0 else mapHeight)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun RouteEssentialMetrics(route: TrailRoute) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(route.distanceMeters?.let(::distance) ?: "Длина не указана", style = MaterialTheme.typography.labelMedium)
        Text(route.durationText ?: route.durationMinutes?.let { "$it мин" } ?: "Время не указано", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
        route.ascentMeters?.let { Text("Подъём ${it.toInt()} м", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted) }
    }
}

@Composable
private fun RouteActionBar(route: TrailRoute, model: MainViewModel, state: AppState,
    modifier: Modifier = Modifier, onDetails: (() -> Unit)? = null) {
    val saved = state.savedRoutes.any { it.routeId == route.id }
    val largeText = LocalDensity.current.fontScale >= 1.6f
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        val saveModifier = if (largeText && onDetails != null) Modifier.width(56.dp) else Modifier.weight(1f)
        TrailButton(onClick = { model.toggleSaved(route) }, enabled = state.busyId == null,
            modifier = saveModifier.testTag("save_route").semantics {
                contentDescription = if (saved) "Убрать маршрут из сохранённого" else "Сохранить маршрут на телефоне"
                stateDescription = if (saved) "Сохранено" else "Не сохранено"
            }) {
            TropaIcon(if (saved) Glyph.CHECK else Glyph.BOOKMARK, color = Palette.Surface)
            if (!largeText || onDetails == null) {
                Spacer(Modifier.width(8.dp))
                Text(if (state.busyId == "bookmark:${route.id}") "Сохраняем…" else if (saved) "Сохранено" else "Сохранить")
            }
        }
        if (onDetails != null) TrailOutlineButton(onClick = onDetails,
            modifier = Modifier.weight(1f).testTag("show_route_details")) { Text("Карточка") }
    }
}

@Composable
internal fun MoreScreen(model: MainViewModel, onSources: () -> Unit) {
    LazyColumn(Modifier.fillMaxSize().testTag("more_list"), contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text("Всё для похода", style = MaterialTheme.typography.headlineMedium) }
        item { TrailOutlineButton(onClick = { model.switchScreen(Screen.TRIPS) }, modifier = Modifier.fillMaxWidth().testTag("nav_trips")) {
            TropaIcon(Glyph.PEOPLE); Spacer(Modifier.width(12.dp)); Text("Походы и группы", Modifier.weight(1f)); TropaIcon(Glyph.NEXT)
        } }
        item { TrailOutlineButton(onClick = { model.switchScreen(Screen.PROFILE) }, modifier = Modifier.fillMaxWidth().testTag("nav_profile")) {
            TropaIcon(Glyph.USER); Spacer(Modifier.width(12.dp)); Text("Профиль", Modifier.weight(1f)); TropaIcon(Glyph.NEXT)
        } }
        item { BrowserPlannerCard(requireNotNull(model.catalog.browserPlannerTarget()), "open_planner") }
        item { TrailOutlineButton(onClick = onSources, modifier = Modifier.fillMaxWidth().testTag("show_sources")) {
            TropaIcon(Glyph.INFO); Spacer(Modifier.width(12.dp)); Text("Источники карты", Modifier.weight(1f)); TropaIcon(Glyph.NEXT)
        } }
        item { InfoCard("Карта, поиск и сохранённые маршруты доступны без аккаунта. Для записи в группу и общения понадобится подключение к сервису.") }
        item { TrailTextButton(onClick = { model.switchScreen(Screen.EXPLORE); model.selectRoute("learning-route") },
            modifier = Modifier.fillMaxWidth().testTag("open_learning")) { Text("Как сохранить маршрут") } }
    }
}

private fun routeCountLabel(count: Int): String = when {
    count % 100 in 11..14 -> "маршрутов"
    count % 10 == 1 -> "маршрут"
    count % 10 in 2..4 -> "маршрута"
    else -> "маршрутов"
}
