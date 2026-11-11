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
import ru.tropa.app.data.PositionState
import ru.tropa.app.data.PreferenceEntity
import ru.tropa.app.data.Region
import ru.tropa.app.data.SavedRouteEntity
import ru.tropa.app.data.ServerState
import ru.tropa.app.data.TrailRoute
import ru.tropa.app.data.toRoute
import ru.tropa.app.data.PublishedRoute
import ru.tropa.app.data.toTrailRoute

enum class Screen { EXPLORE, SAVED, TRIPS, PROFILE }

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
    val server: ServerState = ServerState.NotConfigured,
)

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as TropaApplication
    val catalog = app.catalog
    private val mutableState = MutableStateFlow(AppState(server = if (app.api.configured) ServerState.Idle else ServerState.NotConfigured))
    val state = mutableState.asStateFlow()
    private val loadedPublishedRoutes = mutableMapOf<String, TrailRoute>()

    init {
        viewModelScope.launch { app.database.dao().observeSavedRoutes().collect { list -> mutableState.update { it.copy(savedRoutes = list) } } }
        viewModelScope.launch { app.database.dao().observePacks().collect { list -> mutableState.update { it.copy(packs = list) } } }
        viewModelScope.launch { app.database.dao().observePreference("role").collect { value -> mutableState.update { it.copy(rolePreference = value ?: "tourist") } } }
        viewModelScope.launch { app.connectivity.changes.collect { status -> mutableState.update { it.copy(connection = status) } } }
    }

    fun switchScreen(screen: Screen) { mutableState.update { it.copy(screen = screen, routeId = null, regionId = null, search = "") } }
    fun selectRegion(id: String) {
        if (catalog.region(id) != null) mutableState.update { it.copy(screen = Screen.EXPLORE, regionId = id, routeId = null, search = "") }
    }
    fun selectRoute(id: String) { if (route(id) != null) mutableState.update { it.copy(routeId = id) } }
    fun selectPublishedRoute(route: PublishedRoute) {
        val snapshot = route.toTrailRoute()
        loadedPublishedRoutes[snapshot.id] = snapshot
        mutableState.update { it.copy(routeId = snapshot.id) }
    }
    fun back() { mutableState.update { if (it.routeId != null) it.copy(routeId = null) else it.copy(regionId = null, search = "") } }
    fun search(query: String) { mutableState.update { it.copy(search = query.take(100)) } }
    fun showTerritories(enabled: Boolean) { mutableState.update { it.copy(catalogTerritories = enabled, search = "") } }
    fun clearNotice() { mutableState.update { it.copy(notice = null) } }
    fun region(id: String?) = catalog.region(id)
    fun route(id: String?): TrailRoute? = catalog.route(id)
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
                app.offlinePacks.install(region)
                mutableState.update { it.copy(notice = "Карта «${region.name}» сохранена на телефоне") }
            } catch (cancelled: CancellationException) { throw cancelled
            } catch (_: Exception) { mutableState.update { it.copy(notice = "Не удалось сохранить карту. Освободите место и повторите.") } }
            finally { mutableState.update { it.copy(busyId = null) } }
        }
    }

    fun removePack(pack: InstalledPackEntity) {
        viewModelScope.launch {
            runCatching { app.offlinePacks.remove(pack.regionId) }
                .onSuccess { mutableState.update { it.copy(notice = "Карта удалена. Сохранённые карточки остались.") } }
                .onFailure { mutableState.update { it.copy(notice = "Не удалось удалить карту. Попробуйте ещё раз.") } }
        }
    }

    fun verifyPack(pack: InstalledPackEntity) {
        viewModelScope.launch {
            val valid = app.offlinePacks.verify(pack)
            mutableState.update { it.copy(notice = if (valid) "Сохранённая карта доступна без интернета" else "Сохранённая карта недоступна. Загрузите её заново.") }
        }
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
