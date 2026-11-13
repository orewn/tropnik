package ru.tropa.app.data

/** State of the default network, driven by ConnectivityManager's callbacks. */
internal class DefaultNetworkConnection<N : Any> {
    private var current: N? = null

    fun available(network: N): ConnectionState {
        current = network
        return ConnectionState.LIMITED
    }

    fun capabilities(network: N, validated: Boolean): ConnectionState? {
        if (network != current) return null
        return if (validated) ConnectionState.ONLINE else ConnectionState.LIMITED
    }

    fun lost(network: N): ConnectionState? {
        if (network != current) return null
        current = null
        return ConnectionState.OFFLINE
    }
}
