package ru.tropa.app.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged

enum class ConnectionState { ONLINE, LIMITED, OFFLINE }

class ConnectivityMonitor(context: Context) {
    private val manager = context.getSystemService(ConnectivityManager::class.java)

    val changes = callbackFlow {
        val connection = DefaultNetworkConnection<Network>()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { trySend(connection.available(network)) }
            override fun onLost(network: Network) { connection.lost(network)?.let { trySend(it) } }
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                connection.capabilities(network, capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
                    ?.let { trySend(it) }
            }
        }
        // API 26+ delivers capabilities after onAvailable. A synchronous read
        // of activeNetwork inside a callback may still describe the lost
        // network. Start offline and use only the ordered callback payloads.
        trySend(ConnectionState.OFFLINE)
        manager.registerDefaultNetworkCallback(callback)
        awaitClose { manager.unregisterNetworkCallback(callback) }
    }.distinctUntilChanged()
}
