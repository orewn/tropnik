package ru.tropa.app

import android.app.Application
import ru.tropa.app.data.ApiClient
import ru.tropa.app.data.Catalog
import ru.tropa.app.data.ConnectivityMonitor
import ru.tropa.app.data.LocalDatabase
import ru.tropa.app.data.LocationReader
import ru.tropa.app.data.MapCoverage
import ru.tropa.app.data.OfflinePacks
import ru.tropa.app.data.RussiaDisplayArea
import ru.tropa.app.data.SessionVault
import ru.tropa.app.data.PrivateConversations

class TropaApplication : Application() {
    val catalog by lazy { Catalog.load(this) }
    // LazyColumn recycles native maps while scrolling. Their immutable display
    // area and bounded coverage cache belong to the application, not each row.
    // TropaMap initializes both on the same worker that owns coverage frames.
    internal val mapDisplayArea by lazy {
        RussiaDisplayArea.load { path -> assets.open(path).bufferedReader().use { it.readText() } }
    }
    internal val mapCoverage by lazy {
        MapCoverage.load(readAsset = { path -> assets.open(path).use { it.readBytes() } }, includeTerritory = false)
    }
    val database by lazy { LocalDatabase.open(this) }
    val offlinePacks by lazy { OfflinePacks(this, database.dao(), catalog) }
    val connectivity by lazy { ConnectivityMonitor(this) }
    val location by lazy { LocationReader(this) }
    val vault by lazy { SessionVault(this) }
    val api by lazy { ApiClient(vault::serverUrl, vault::bearer) }
    val privateConversations by lazy { PrivateConversations(database.dao(), vault) }
}
