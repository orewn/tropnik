package ru.tropa.app

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONObject
import ru.tropa.app.data.ConnectionState
import ru.tropa.app.data.InstalledPackEntity
import ru.tropa.app.data.OfflinePackAvailability
import ru.tropa.app.data.OfflinePackAssetsUnavailable
import ru.tropa.app.data.OfflineRegionSnapshot
import ru.tropa.app.data.PositionState
import ru.tropa.app.data.PreferenceEntity
import ru.tropa.app.data.Region
import ru.tropa.app.data.SavedRouteEntity
import ru.tropa.app.data.ServerState
import ru.tropa.app.data.TrailRoute
import ru.tropa.app.data.toRoute
import ru.tropa.app.data.PublishedRoute
import ru.tropa.app.data.toTrailRoute

enum class Screen { EXPLORE, SAVED, MORE, TRIPS, PROFILE }

data class AppState(
    val screen: Screen = Screen.EXPLORE,
    val regionId: String? = null,
    val routeId: String? = null,
    val search: String = "",
    val catalogTerritories: Boolean = false,
    val connection: ConnectionState = ConnectionState.OFFLINE,
    val position: PositionState = PositionState.Idle,
    val savedRoutes: List<SavedRouteEntity> = emptyList(),
    val packs: List<InstalledPackEntity> = emptyList(),
    val rolePreference: String = "tourist",
    val busyId: String? = null,
    val notice: String? = null,
    val offlineSnapshot: OfflineRegionSnapshot? = null,
    val server: ServerState = ServerState.NotConfigured,
    val browsePanel: BrowsePanel = BrowsePanel.MAP,
    val routeParentPanel: BrowsePanel = BrowsePanel.MAP,
    val navigationContexts: Map<Screen, BrowsingContext> = emptyMap(),
    val navigationParents: Map<Screen, Screen> = emptyMap(),
)

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as TropaApplication
    val catalog = app.catalog
    private val mutableState = MutableStateFlow(AppState(server = if (app.api.configured) ServerState.Idle else ServerState.NotConfigured))
    val state = mutableState.asStateFlow()
    private val loadedPublishedRoutes = mutableMapOf<String, TrailRoute>()
    private var navigationVersion = 0L
    val displayCatalog get() = mutableState.value.offlineSnapshot?.catalog ?: catalog

    init {
        viewModelScope.launch { app.database.dao().observeSavedRoutes().collect { list -> mutableState.update { it.copy(savedRoutes = list) } } }
        viewModelScope.launch { app.database.dao().observePacks().collect { list -> mutableState.update { it.copy(packs = list) } } }
        viewModelScope.launch { app.database.dao().observePreference("role").collect { value -> mutableState.update { it.copy(rolePreference = value ?: "tourist") } } }
        viewModelScope.launch { app.connectivity.changes.collect { status -> mutableState.update { it.copy(connection = status) } } }
    }

    fun switchScreen(screen: Screen) {
        val next = mutableState.value.navigateTo(screen)
        if (next == mutableState.value) return
        navigationVersion++
        mutableState.update { it.navigateTo(screen) }
    }
    fun showBrowsePanel(panel: BrowsePanel) { mutableState.update { it.copy(browsePanel = panel) } }
    fun selectRegion(id: String, panel: BrowsePanel = BrowsePanel.CONTENT) {
        if (catalog.region(id) != null) { navigationVersion++; mutableState.update { it.navigateTo(Screen.EXPLORE).copy(regionId = id, routeId = null, search = "", offlineSnapshot = null, browsePanel = panel) } }
    }
    fun selectRoute(id: String, panel: BrowsePanel = BrowsePanel.CONTENT) { if (route(id) != null) { navigationVersion++; mutableState.update { it.copy(routeId = id,
        browsePanel = panel, routeParentPanel = if (it.routeId == null) it.browsePanel else it.routeParentPanel,
        offlineSnapshot = it.offlineSnapshot?.takeIf { snapshot -> snapshot.catalog.route(id) != null }) } } }
    fun selectPublishedRoute(route: PublishedRoute) {
        navigationVersion++
        val snapshot = route.toTrailRoute()
        loadedPublishedRoutes[snapshot.id] = snapshot
        mutableState.update { it.copy(routeId = snapshot.id, offlineSnapshot = null,
            browsePanel = BrowsePanel.CONTENT, routeParentPanel = it.browsePanel) }
    }
    fun back() { navigationVersion++; mutableState.update { it.navigateBack() } }
    fun search(query: String) { mutableState.update { it.copy(search = query.take(100), browsePanel = BrowsePanel.CONTENT) } }
    fun showTerritories(enabled: Boolean) { mutableState.update { it.copy(catalogTerritories = enabled, search = "") } }
    fun clearNotice() { mutableState.update { it.copy(notice = null) } }
    fun region(id: String?) = displayCatalog.region(id)
    fun route(id: String?): TrailRoute? = mutableState.value.offlineSnapshot?.catalog?.route(id) ?: catalog.route(id)
        ?: loadedPublishedRoutes[id]
        ?: mutableState.value.savedRoutes.firstOrNull { it.routeId == id }?.let { runCatching { JSONObject(it.snapshotJson).toRoute() }.getOrNull() }

    fun toggleSaved(route: TrailRoute) {
        if (mutableState.value.busyId != null) return
        mutableState.update { it.copy(busyId = "bookmark:${route.id}") }
        viewModelScope.launch {
            try {
                val dao = app.database.dao()
                val already = dao.savedRoute(route.id) != null
                if (already) dao.removeSavedRoute(route.id)
                else dao.putSavedRoute(SavedRouteEntity(route.id, route.title, route.regionId, route.rawJson, System.currentTimeMillis()))
                mutableState.update { it.copy(notice = if (already) "Карточка удалена из сохранённого" else "Карточка сохранена на этом устройстве") }
            } catch (_: Exception) { mutableState.update { it.copy(notice = "Не удалось сохранить карточку. Проверьте свободное место.") } }
            finally { mutableState.update { it.copy(busyId = null) } }
        }
    }

    fun saveRegion(region: Region) {
        if (mutableState.value.busyId != null) return
        mutableState.update { it.copy(busyId = "pack:${region.id}") }
        viewModelScope.launch {
            try {
                val installed = app.offlinePacks.install(catalog.region(region.id) ?: region)
                val refreshed = if (mutableState.value.offlineSnapshot?.pack?.regionId == region.id) app.offlinePacks.open(installed).snapshot else null
                mutableState.update { it.copy(notice = "Данные «${region.name}» сохранены на телефоне",
                    offlineSnapshot = if (it.offlineSnapshot?.pack?.regionId == region.id) refreshed else it.offlineSnapshot) }
            } catch (cancelled: CancellationException) { throw cancelled
            } catch (_: OfflinePackAssetsUnavailable) { mutableState.update { it.copy(notice = "Встроенные данные карты недоступны. Обновите приложение и повторите сохранение.") }
            } catch (_: java.io.IOException) { mutableState.update { it.copy(notice = "Не удалось записать офлайн-данные. Проверьте свободное место и повторите.") }
            } catch (_: Exception) { mutableState.update { it.copy(notice = "Не удалось сохранить офлайн-данные. Предыдущая сохранённая область не заменена.") } }
            finally { mutableState.update { it.copy(busyId = null) } }
        }
    }

    fun removePack(pack: InstalledPackEntity) {
        if (mutableState.value.busyId != null) return
        navigationVersion++
        mutableState.update { it.copy(busyId = "remove:${pack.regionId}") }
        viewModelScope.launch {
            try {
                app.offlinePacks.remove(pack.regionId)
                mutableState.update { current ->
                    val removedOpenRegion = current.offlineSnapshot?.pack?.regionId == pack.regionId
                    current.copy(notice = "Данные области удалены. Сохранённые карточки остались.",
                        screen = if (removedOpenRegion) Screen.SAVED else current.screen,
                        regionId = if (removedOpenRegion) null else current.regionId,
                        routeId = if (removedOpenRegion) null else current.routeId,
                        offlineSnapshot = if (removedOpenRegion) null else current.offlineSnapshot,
                        navigationContexts = current.navigationContexts.mapValues { (_, context) ->
                            if (context.offlineSnapshot?.pack?.regionId == pack.regionId)
                                context.copy(regionId = null, routeId = null, search = "", offlineSnapshot = null)
                            else context
                        })
                }
            } catch (cancelled: CancellationException) { throw cancelled
            } catch (_: Exception) { mutableState.update { it.copy(notice = "Не удалось удалить данные области. Попробуйте ещё раз.") }
            } finally { mutableState.update { it.copy(busyId = null) } }
        }
    }

    fun verifyPack(pack: InstalledPackEntity) {
        if (mutableState.value.busyId != null) return
        mutableState.update { it.copy(busyId = "verify:${pack.regionId}") }
        viewModelScope.launch {
            try {
                val availability = app.offlinePacks.verify(pack)
                mutableState.update { it.copy(notice = availabilityMessage(availability)) }
            } catch (cancelled: CancellationException) { throw cancelled
            } catch (_: Exception) { mutableState.update { it.copy(notice = "Не удалось проверить сохранённую область. Повторите попытку.") }
            } finally { mutableState.update { it.copy(busyId = null) } }
        }
    }

    fun openPack(pack: InstalledPackEntity) {
        if (mutableState.value.busyId != null) return
        val revision = ++navigationVersion
        mutableState.update { it.copy(busyId = "open:${pack.regionId}") }
        viewModelScope.launch {
            try {
                val result = app.offlinePacks.open(pack)
                if (revision != navigationVersion) return@launch
                val snapshot = result.snapshot
                if (snapshot == null) mutableState.update { it.copy(notice = availabilityMessage(result.availability)) }
                else mutableState.update { it.openSavedRegion(snapshot) }
            } catch (cancelled: CancellationException) { throw cancelled
            } catch (_: Exception) { if (revision == navigationVersion) mutableState.update { it.copy(notice = "Сохранённую область не удалось открыть. Повторите попытку.") } }
            finally { mutableState.update { it.copy(busyId = null) } }
        }
    }

    private fun availabilityMessage(availability: OfflinePackAvailability) = when (availability) {
        OfflinePackAvailability.READY -> "Сохранённые карточки и линии доступны. Обзорная карта встроена в приложение."
        OfflinePackAvailability.UPDATE_REQUIRED -> "Приложение обновилось. Нажмите «Обновить» и сохраните данные области заново."
        OfflinePackAvailability.DAMAGED -> "Сохранённые данные повреждены или удалены. Нажмите «Обновить» и сохраните область заново."
        OfflinePackAvailability.APP_DATA_UNAVAILABLE -> "Встроенные данные карты недоступны. Обновите приложение."
    }

    fun preferRole(role: String) {
        if (role !in setOf("tourist", "guide")) return
        viewModelScope.launch {
            app.database.dao().putPreference(PreferenceEntity("role", role))
            mutableState.update { it.copy(notice = "Предпочтение сохранено. Для проведения походов нужно подтвердить квалификацию.") }
        }
    }

    fun locate() {
        if (mutableState.value.position == PositionState.Locating) return
        mutableState.update { it.copy(position = PositionState.Locating) }
        viewModelScope.launch {
            val result = runCatching { app.location.read() }.getOrElse { PositionState.Problem("Геопозиция недоступна. Карту можно изучать без неё.") }
            mutableState.update { it.copy(position = result) }
        }
    }

    fun locationDenied() { mutableState.update { it.copy(position = PositionState.Problem("Геопозиция не разрешена. Карту можно изучать без неё.")) } }

    fun checkServer() {
        if (mutableState.value.server == ServerState.Checking) return
        viewModelScope.launch {
            mutableState.update { it.copy(server = ServerState.Checking) }
            val result = app.api.checkHealth()
            mutableState.update { it.copy(server = result) }
        }
    }
}
