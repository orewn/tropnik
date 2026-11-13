package ru.tropa.app

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import androidx.lifecycle.viewModelScope
import androidx.room.Room
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import ru.tropa.app.data.*
import java.io.IOException
import java.util.UUID

/** Faults surround the actual vault, Room repository and production ViewModel. */
internal class SessionFaultHarness(private val application: Application) {
    val origin = ApiAddress.normalize("https://old.example.invalid")
    val nextOrigin = ApiAddress.normalize("https://new.example.invalid")
    private val preferenceName = "session-fault-${UUID.randomUUID()}"
    val persisted = application.getSharedPreferences(preferenceName, Context.MODE_PRIVATE)
    val preferences = UncertainPreferences(persisted)
    var vault = SessionVault(preferences)
        private set
    private val database = Room.inMemoryDatabaseBuilder(application, LocalDatabase::class.java).build()
    val dao = FaultDao(database.dao())
    var privateStore = PrivateConversations(dao, vault)
        private set
    val connections = MutableStateFlow(ConnectionState.OFFLINE)
    val conversation = Conversation(ConversationKind.DEPARTURE, "fixture-departure", "Local fixture")
    val session = AccountSession(origin, "f".repeat(43), "2099-01-01T00:00:00Z", Account.parse(JSONObject(
        """{"id":"fixture-owner","displayName":"Fixture","email":"fixture@example.invalid","role":"tourist","guideStatus":"none","emailVerified":true}""")))
    lateinit var model: OnlineViewModel

    fun seed() = runBlocking(Dispatchers.IO) {
        vault.setServer(origin)
        vault.saveSession(session)
        privateStore.store(session, conversation, listOf(ChatMessage("fixture-message", "fixture-owner", "Fixture",
            "Private local fixture", "fixture-client", "2026-11-13T00:00:00Z")), null)
        privateStore.enqueue(session, conversation, "Queued local fixture")
    }

    fun createModel(): OnlineViewModel {
        // Even the two online outbox fault cases terminate in this interceptor;
        // it never calls proceed, performs DNS, or contacts an external service.
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(503).message("Local fixture unavailable")
                .body("""{"error":{"code":"temporarily_unavailable","message":"Local fixture"}}"""
                    .toResponseBody("application/json".toMediaType())).build()
        }.build()
        model = OnlineViewModel(application, vault, ApiClient(vault::serverUrl, vault::bearer, http), privateStore, connections)
        return model
    }

    fun pendingCount() = runBlocking(Dispatchers.IO) { dao.pending(origin, session.account.id).size }
    fun conversationCount() = runBlocking(Dispatchers.IO) { dao.conversations(origin, session.account.id).size }
    fun stopModel() { if (::model.isInitialized) model.viewModelScope.cancel() }
    fun awaitStopped() { if (::model.isInitialized) runBlocking { withTimeout(10_000) { model.viewModelScope.coroutineContext[Job]?.join() } } }
    fun recreateStorageFromDisk() {
        awaitStopped()
        vault = SessionVault(persisted)
        privateStore = PrivateConversations(dao, vault)
    }
    fun close() {
        awaitStopped()
        database.close()
        application.deleteSharedPreferences(preferenceName)
    }

    class Pause {
        val entered = CompletableDeferred<Unit>()
        val resume = CompletableDeferred<Unit>()
        fun awaitEntered() = runBlocking { withTimeout(5_000) { entered.await() } }
    }

    class FaultDao(private val real: LocalDao) : LocalDao by real {
        @Volatile var failConversations = false
        @Volatile var failOutbox = false
        @Volatile var failPendingRead = false
        @Volatile var failPendingUpdate = false
        @Volatile var pendingUpdateFailures = 0
        @Volatile var readPause: Pause? = null
        @Volatile var enqueuePause: Pause? = null

        override suspend fun clearConversations(origin: String, owner: String) {
            if (failConversations) { failConversations = false; throw IOException("Injected Room conversation delete failure") }
            real.clearConversations(origin, owner)
        }
        override suspend fun clearOutbox(origin: String, owner: String) {
            if (failOutbox) { failOutbox = false; throw IOException("Injected Room outbox delete failure") }
            real.clearOutbox(origin, owner)
        }
        override suspend fun conversation(origin: String, owner: String, kind: String, conversation: String): ConversationCacheEntity? {
            val row = real.conversation(origin, owner, kind, conversation)
            readPause?.let { pause ->
                readPause = null
                pause.entered.complete(Unit)
                pause.resume.await()
            }
            return row
        }
        override suspend fun enqueue(row: PendingMessageEntity) {
            enqueuePause?.let { pause ->
                enqueuePause = null
                pause.entered.complete(Unit)
                pause.resume.await()
                real.enqueue(row)
            } ?: real.enqueue(row)
        }
        override suspend fun pending(origin: String, owner: String): List<PendingMessageEntity> {
            if (failPendingRead) { failPendingRead = false; throw IOException("Injected Room outbox read failure") }
            return real.pending(origin, owner)
        }
        override suspend fun pendingFailure(id: String, failed: Boolean, error: String?) {
            if (failPendingUpdate) {
                failPendingUpdate = false
                pendingUpdateFailures++
                throw IOException("Injected Room outbox status failure")
            }
            real.pendingFailure(id, failed, error)
        }
    }

    /** commit(false) publishes its memory values but leaves disk unchanged. */
    class UncertainPreferences(private val disk: SharedPreferences) : SharedPreferences by disk {
        @Volatile var failNextCommit = false
        private val memory = linkedMapOf<String, String?>()
        @Synchronized override fun getString(key: String?, defValue: String?): String? =
            if (key != null && memory.containsKey(key)) memory[key] ?: defValue else disk.getString(key, defValue)
        override fun edit(): SharedPreferences.Editor {
            val changes = linkedMapOf<String, String?>()
            return object : SharedPreferences.Editor by disk.edit() {
                override fun putString(key: String?, value: String?): SharedPreferences.Editor {
                    changes[requireNotNull(key)] = value; return this
                }
                override fun remove(key: String?): SharedPreferences.Editor { changes[requireNotNull(key)] = null; return this }
                override fun commit(): Boolean = synchronized(this@UncertainPreferences) {
                    memory.putAll(changes)
                    if (failNextCommit) { failNextCommit = false; return@synchronized false }
                    val editor = disk.edit()
                    memory.forEach { (key, value) -> if (value == null) editor.remove(key) else editor.putString(key, value) }
                    editor.commit().also { if (it) memory.clear() }
                }
            }
        }
    }
}
