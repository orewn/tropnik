package ru.tropa.app

import android.app.Application
import ru.tropa.app.data.ApiClient
import ru.tropa.app.data.Catalog
import ru.tropa.app.data.ConnectivityMonitor
import ru.tropa.app.data.LocalDatabase
import ru.tropa.app.data.LocationReader
import ru.tropa.app.data.OfflinePacks
import ru.tropa.app.data.SessionVault
import ru.tropa.app.data.PrivateConversations
import ru.tropa.app.ui.CustomMapAssetRegistry

class TropaApplication : Application() {
    internal val mapAssetRegistry = CustomMapAssetRegistry {
        assets.open("custom-map/manifest.json").bufferedReader().use { it.readText() }
    }
    private val bundledCatalog = lazy(LazyThreadSafetyMode.SYNCHRONIZED) { Catalog.load(this) }
    private val catalogStartup = CatalogStartup(bundledCatalog)
    val catalog by bundledCatalog
    internal val catalogReady: Boolean get() = catalogStartup.isReady
    internal suspend fun prepareCatalog(): Catalog = catalogStartup.prepare()
    val database by lazy { LocalDatabase.open(this) }
    val offlinePacks by lazy { OfflinePacks(this, database.dao(), catalog) }
    val connectivity by lazy { ConnectivityMonitor(this) }
    val location by lazy { LocationReader(this) }
    val vault by lazy { SessionVault(this) }
    val api by lazy { ApiClient(vault::serverUrl, vault::bearer) }
    val privateConversations by lazy { PrivateConversations(database.dao(), vault) }
}
