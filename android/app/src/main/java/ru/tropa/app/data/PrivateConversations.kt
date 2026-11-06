package ru.tropa.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class CachedMessages(val messages: List<ChatMessage>, val cursor: String?, val updatedAt: Long)

class PrivateConversations(private val dao: LocalDao, private val vault: SessionVault) {
    private fun scope(session: AccountSession, conversation: Conversation) = "chat:${session.origin}:${session.account.id}:${conversation.kind.name}:${conversation.id}"

    suspend fun load(session: AccountSession, conversation: Conversation): CachedMessages? = withContext(Dispatchers.IO) {
        val row = dao.conversation(session.origin, session.account.id, conversation.kind.name, conversation.id) ?: return@withContext null
        runCatching {
            val json = JSONObject(vault.open(row.encryptedJson, scope(session, conversation)))
            CachedMessages(json.getJSONArray("messages").objectList().map(ChatMessage::parse), json.stringOrNull("cursor"), row.updatedAt)
        }.getOrNull()
    }

    suspend fun store(session: AccountSession, conversation: Conversation, messages: List<ChatMessage>, cursor: String?) = withContext(Dispatchers.IO) {
        val json = JSONObject().put("messages", JSONArray(messages.takeLast(500).map(ChatMessage::json)))
            .put("cursor", cursor ?: JSONObject.NULL).put("title", conversation.title)
        dao.putConversation(ConversationCacheEntity(session.origin, session.account.id, conversation.kind.name,
            conversation.id, vault.seal(json.toString(), scope(session, conversation)), System.currentTimeMillis()))
    }

    suspend fun list(session: AccountSession): List<Conversation> = withContext(Dispatchers.IO) {
        dao.conversations(session.origin, session.account.id).mapNotNull { row ->
            runCatching {
                val conversation = Conversation(ConversationKind.valueOf(row.kind), row.conversationId, "Чат")
                val json = JSONObject(vault.open(row.encryptedJson, scope(session, conversation)))
                conversation.copy(title = json.optString("title", "Сохранённый чат"))
            }.getOrNull()
        }
    }

    suspend fun enqueue(session: AccountSession, conversation: Conversation, message: String): String = withContext(Dispatchers.IO) {
        val text = message.trim()
        require(text.isNotEmpty() && text.codePointCount(0, text.length) <= 4000) { "Сообщение должно содержать от 1 до 4000 символов" }
        require(dao.pending(session.origin, session.account.id).size < 100) { "В очереди уже 100 сообщений. Дождитесь отправки или удалите лишние." }
        val id = UUID.randomUUID().toString()
        dao.enqueue(PendingMessageEntity(id, session.origin, session.account.id, conversation.kind.name,
            conversation.id, vault.seal(text, "outbox:$id:${session.origin}:${session.account.id}"), System.currentTimeMillis()))
        if (dao.conversation(session.origin, session.account.id, conversation.kind.name, conversation.id) == null) {
            store(session, conversation, emptyList(), null)
        }
        id
    }

    suspend fun pending(session: AccountSession, conversation: Conversation? = null): List<PendingMessageEntity> =
        dao.pending(session.origin, session.account.id).filter { conversation == null || (it.kind == conversation.kind.name && it.conversationId == conversation.id) }

    fun body(row: PendingMessageEntity) = vault.open(row.encryptedBody, "outbox:${row.clientId}:${row.origin}:${row.ownerId}")
    suspend fun views(session: AccountSession, conversation: Conversation): List<PendingMessageView> = withContext(Dispatchers.IO) {
        pending(session, conversation).map { row -> PendingMessageView(row.clientId,
            runCatching { body(row) }.getOrDefault("Локальный текст недоступен. Удалите запись."), row.createdAt, row.failed, row.error) }
    }
    suspend fun remove(id: String) = dao.removePending(id)
    suspend fun failed(id: String, failed: Boolean, error: String?) = dao.pendingFailure(id, failed, error)
    suspend fun clear(session: AccountSession) {
        dao.clearConversations(session.origin, session.account.id)
        dao.clearOutbox(session.origin, session.account.id)
    }
}
