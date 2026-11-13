package ru.tropa.app.data

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONObject
import ru.tropa.app.BuildConfig
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Only encrypted bearer/session bytes are persisted. Keys never enter the APK. */
class SessionVault internal constructor(private val preferences: SharedPreferences) {
    constructor(context: Context) : this(context.getSharedPreferences("tropnik-session", Context.MODE_PRIVATE))
    private val alias = "tropnik.local.v1"
    private var confirmedServer = runCatching {
        ApiAddress.normalize(preferences.getString("server", null) ?: BuildConfig.API_BASE_URL)
    }.getOrDefault("")
    @Volatile var persistenceError: String? = null
        private set

    // commit(false) can already have changed SharedPreferences' in-memory map.
    // Until a checked retry succeeds, neither that host nor any bearer is usable.
    @Synchronized fun serverUrl(): String = if (persistenceError == null) confirmedServer else ""

    private fun persist(editor: SharedPreferences.Editor, message: String) {
        val saved = try { editor.commit() } catch (_: Exception) { false }
        if (!saved) {
            persistenceError = message
            throw SessionPersistenceException(message)
        }
        persistenceError = null
    }

    private fun cleanupEditor(editor: SharedPreferences.Editor, cleanup: PrivateAccountScope?): SharedPreferences.Editor {
        if (cleanup != null) editor.putString("pending-private-cleanup", JSONObject()
            .put("origin", cleanup.origin).put("ownerId", cleanup.ownerId).toString())
        return editor
    }

    @Synchronized fun pendingCleanup(): PrivateAccountScope? {
        val encoded = preferences.getString("pending-private-cleanup", null) ?: return null
        return try {
            val json = JSONObject(encoded)
            val origin = json.getString("origin")
            val owner = json.getString("ownerId")
            require(origin.isNotBlank() && ApiAddress.normalize(origin) == origin && owner.isNotBlank() && owner.length <= 128)
            PrivateAccountScope(origin, owner)
        } catch (_: Exception) {
            val message = "Не удалось прочитать состояние очистки личных данных. Доступ к сервису приостановлен."
            persistenceError = message
            throw SessionPersistenceException(message)
        }
    }

    @Synchronized fun finishCleanup(cleanup: PrivateAccountScope) {
        check(pendingCleanup() == cleanup) { "Состояние очистки личных данных изменилось" }
        persist(preferences.edit().remove("pending-private-cleanup"),
            "Не удалось сохранить завершение очистки. Доступ к сервису приостановлен. Повторите завершение действия.")
    }

    @Synchronized fun setServer(value: String, cleanup: PrivateAccountScope? = null) {
        val normalized = ApiAddress.normalize(value)
        persist(cleanupEditor(preferences.edit().putString("server", normalized).remove("session"), cleanup),
            "Не удалось сохранить подключение. Доступ к сервису приостановлен. Повторите сохранение.")
        confirmedServer = normalized
    }
    @Synchronized fun session(): AccountSession? {
        if (persistenceError != null || preferences.getString("pending-private-cleanup", null) != null) return null
        val encoded = preferences.getString("session", null) ?: return null
        return runCatching {
            val j = JSONObject(open(encoded, "account-session"))
            require(j.getString("origin") == serverUrl())
            AccountSession(j.getString("origin"), j.getString("token"), j.getString("expiresAt"), Account.parse(j.getJSONObject("user")))
        }.getOrElse {
            try { clearSession() } catch (_: SessionPersistenceException) { /* Exposed by persistenceError. */ }
            null
        }
    }
    @Synchronized fun saveSession(session: AccountSession) {
        persistenceError?.let { throw SessionPersistenceException(it) }
        if (pendingCleanup() != null) throw SessionPersistenceException("Сначала завершите очистку личных данных в профиле.")
        require(session.origin == serverUrl())
        require(session.token.matches(Regex("[A-Za-z0-9_-]{32,128}")))
        val j = JSONObject().put("origin", session.origin).put("token", session.token).put("expiresAt", session.expiresAt)
            .put("user", JSONObject(session.account.rawJson))
        persist(preferences.edit().putString("session", seal(j.toString(), "account-session")),
            "Не удалось сохранить защищённый вход. Доступ к сервису приостановлен. Повторите завершение входа.")
    }
    @Synchronized fun clearSession(cleanup: PrivateAccountScope? = null) {
        persist(cleanupEditor(preferences.edit().putString("server", confirmedServer).remove("session"), cleanup),
            "Не удалось сохранить выход. Доступ к сервису приостановлен. Повторите завершение выхода.")
    }
    @Synchronized fun bearer(origin: String) = session()?.takeIf { it.locallyUnexpired && it.origin == origin }?.token

    @Synchronized fun matches(expected: AccountSession): Boolean = session()?.let {
        it.origin == expected.origin && it.account.id == expected.account.id && it.token == expected.token
    } == true

    fun seal(plainText: String, context: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(context.toByteArray(Charsets.UTF_8))
        val encrypted = cipher.doFinal(plainText.toByteArray(Charsets.UTF_8))
        return Base64.getEncoder().encodeToString(cipher.iv + encrypted)
    }
    fun open(encoded: String, context: String): String {
        val bytes = Base64.getDecoder().decode(encoded)
        require(bytes.size > 28)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        cipher.updateAAD(context.toByteArray(Charsets.UTF_8))
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
    }
    @Synchronized private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }
}

class SessionPersistenceException(message: String) : IllegalStateException(message)

/** Durable deletion intent contains an account scope, never a bearer. */
data class PrivateAccountScope(val origin: String, val ownerId: String)
