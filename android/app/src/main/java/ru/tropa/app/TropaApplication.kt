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

class TropaApplication : Application() {
    val catalog by lazy { Catalog.load(this) }
    val database by lazy { LocalDatabase.open(this) }
    val offlinePacks by lazy { OfflinePacks(this, database.dao(), catalog) }
    val connectivity by lazy { ConnectivityMonitor(this) }
    val location by lazy { LocationReader(this) }
    val vault by lazy { SessionVault(this) }
    val api by lazy { ApiClient(vault::serverUrl, vault::bearer) }
    val privateConversations by lazy { PrivateConversations(database.dao(), vault) }
}
