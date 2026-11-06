package ru.tropa.app.data

import android.content.Context
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
class SessionVault(context: Context) {
    private val preferences = context.getSharedPreferences("tropnik-session", Context.MODE_PRIVATE)
    private val alias = "tropnik.local.v1"
    fun serverUrl(): String = preferences.getString("server", null)
        ?: runCatching { ApiAddress.normalize(BuildConfig.API_BASE_URL) }.getOrDefault("")

    @Synchronized fun setServer(value: String) {
        val normalized = ApiAddress.normalize(value)
        preferences.edit().putString("server", normalized).remove("session").commit()
    }
    @Synchronized fun session(): AccountSession? {
        val encoded = preferences.getString("session", null) ?: return null
        return runCatching {
            val j = JSONObject(open(encoded, "account-session"))
            require(j.getString("origin") == serverUrl())
            AccountSession(j.getString("origin"), j.getString("token"), j.getString("expiresAt"), Account.parse(j.getJSONObject("user")))
        }.getOrElse { clearSession(); null }
    }
    @Synchronized fun saveSession(session: AccountSession) {
        require(session.origin == serverUrl())
        require(session.token.matches(Regex("[A-Za-z0-9_-]{32,128}")))
        val j = JSONObject().put("origin", session.origin).put("token", session.token).put("expiresAt", session.expiresAt)
            .put("user", JSONObject(session.account.rawJson))
        check(preferences.edit().putString("session", seal(j.toString(), "account-session")).commit()) { "Не удалось сохранить защищённый сеанс" }
    }
    @Synchronized fun clearSession() { preferences.edit().remove("session").commit() }
    fun bearer() = session()?.takeIf { it.locallyUnexpired }?.token

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
