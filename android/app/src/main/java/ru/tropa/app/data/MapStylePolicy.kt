package ru.tropa.app.data

/** Map connectivity does not imply that the social API is configured or ready. */
internal fun canUseOnlineMap(connection: ConnectionState, requested: Boolean, failed: Boolean): Boolean =
    connection == ConnectionState.ONLINE && requested && !failed
