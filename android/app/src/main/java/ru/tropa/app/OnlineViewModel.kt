package ru.tropa.app

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import ru.tropa.app.data.*
import java.util.UUID

data class OnlineState(
    val serverUrl: String = "",
    val session: AccountSession? = null,
    val connection: ConnectionState = ConnectionState.OFFLINE,
    val readiness: ServerState = if (serverUrl.isBlank()) ServerState.NotConfigured else ServerState.Idle,
    val readinessCheckedAt: Long = 0L,
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    val routes: List<PublishedRoute> = emptyList(),
    val routeCursor: String? = null,
    val routeFilter: String? = null,
    val recruitmentForRoute: PublishedRoute? = null,
    val departures: List<Departure> = emptyList(),
    val recruitment: List<Recruitment> = emptyList(),
    val departure: Departure? = null,
    val request: Recruitment? = null,
    val roster: List<Participant> = emptyList(),
    val reviews: List<Review> = emptyList(),
    val conversation: Conversation? = null,
    val cachedConversations: List<Conversation> = emptyList(),
    val messages: List<ChatMessage> = emptyList(),
    val pending: List<PendingMessageView> = emptyList(),
    val messageCursor: String? = null,
    val chatError: String? = null,
    val chatBusy: Boolean = false,
    val enqueueBusy: Boolean = false,
    val chatUpdatedAt: Long = 0L,
    val refreshedAt: Long = 0L,
    val accountSummary: AccountSummary? = null,
    val notifications: List<AccountNotification> = emptyList(),
    val reports: List<UserReport> = emptyList(),
    val moderationActions: List<ModerationAction> = emptyList(),
    val appeals: List<Appeal> = emptyList(),
    val accountUpdatedAt: Long = 0L,
    val accountError: String? = null,
) {
    val configured get() = serverUrl.isNotBlank()
    val canUseNetwork get() = configured && connection != ConnectionState.OFFLINE
    val user get() = session?.account
}

class OnlineViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as TropaApplication
    private val api get() = app.api
    private val privateStore get() = app.privateConversations
    private var generation = 0
    private val outboxMutex = Mutex()
    private val chatMutex = Mutex()
    private var syncJob: Job? = null
    private val mutableState = MutableStateFlow(OnlineState(serverUrl = app.vault.serverUrl(), session = app.vault.session()?.takeIf { it.locallyUnexpired }))
    val state = mutableState.asStateFlow()

    init {
        viewModelScope.launch { refreshPrivateLists() }
        viewModelScope.launch {
            app.connectivity.changes.collect { connection ->
                mutableState.update { current ->
                    current.copy(connection = connection,
                        readiness = if (!current.configured) ServerState.NotConfigured else if (connection != current.connection) ServerState.Idle else current.readiness,
                        readinessCheckedAt = if (connection != current.connection) 0L else current.readinessCheckedAt)
                }
                if (connection != ConnectionState.OFFLINE && mutableState.value.configured) {
                    refresh()
                    flushOutbox()
                }
            }
        }
    }

    fun clearNotice() { mutableState.update { it.copy(notice = null) } }
    fun clearError() { mutableState.update { it.copy(error = null) } }
    fun routeTitle(id: String) = mutableState.value.routes.firstOrNull { it.id == id }?.title ?: "Маршрут похода"
    fun filterRoute(id: String?) {
        mutableState.update { it.copy(routeFilter = id, departure = null, request = null, conversation = null) }
        if (mutableState.value.canUseNetwork) refresh()
    }
    fun composeRecruitment(id: String) = action { epoch ->
        requireSession()
        val route = api.route(id)
        if (route.status != "published") throw ApiFailure("route_closed", "Маршрут закрыт. Набор сейчас недоступен.", 409)
        if (epoch == generation) mutableState.update { it.copy(routes = it.routes.filterNot { old -> old.id == id } + route,
            recruitmentForRoute = route, routeFilter = id, departure = null, request = null, conversation = null) }
    }
    fun closeRecruitmentComposer() { mutableState.update { it.copy(recruitmentForRoute = null) } }

    private fun requireOnline() {
        if (!mutableState.value.configured) throw ApiFailure("service_not_configured", "Подключите HTTPS адрес сервиса в профиле.")
        if (mutableState.value.connection == ConnectionState.OFFLINE) throw ApiFailure("offline", "Для этого действия нужно подключение. Подтверждение выполняет сервер.")
    }
    private fun requireSession(): AccountSession = mutableState.value.session
        ?: throw ApiFailure("auth_required", "Сначала войдите в аккаунт.", 401)
    private fun same(session: AccountSession, epoch: Int) = generation == epoch && app.vault.session()?.let {
        it.origin == session.origin && it.account.id == session.account.id && it.token == session.token
    } == true

    private fun action(online: Boolean = true, block: suspend (Int) -> Unit) {
        if (mutableState.value.busy) return
        val epoch = generation
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try { if (online) requireOnline(); block(epoch) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: ApiFailure) {
                if (epoch == generation) {
                    if (failure.status == 401 && mutableState.value.session != null) {
                        syncJob?.cancel()
                        app.vault.clearSession()
                        mutableState.update { it.copy(session = null, conversation = null, messages = emptyList(), pending = emptyList(), cachedConversations = emptyList(), accountSummary = null, notifications = emptyList(), reports = emptyList(), moderationActions = emptyList(), appeals = emptyList(), accountUpdatedAt = 0) }
                    }
                    mutableState.update { it.copy(error = readable(failure),
                        readiness = if (failure.status == 503 || failure.code == "network_unavailable") ServerState.Unavailable(failure.message) else it.readiness) }
                    if (failure.status == 409) mutableState.value.departure?.let { old ->
                        runCatching { api.departure(old.id) }.onSuccess { updated -> if (epoch == generation) updateDeparture(updated) }
                    }
                }
            } catch (failure: Exception) {
                if (epoch == generation) mutableState.update { it.copy(error = failure.message?.takeIf { message -> failure is IllegalArgumentException && message.length < 240 }
                    ?: "Не удалось выполнить действие. Повторите попытку.") }
            } finally { if (epoch == generation) mutableState.update { it.copy(busy = false) } }
        }
    }

    fun configureServer(value: String) = action(online = false) { _ ->
        val normalized = ApiAddress.normalize(value)
        val previous = mutableState.value.session
        syncJob?.cancel()
        if (previous != null && mutableState.value.connection != ConnectionState.OFFLINE) runCatching { api.logout() }
        generation++
        if (previous != null) privateStore.clear(previous)
        app.vault.setServer(normalized)
        mutableState.value = OnlineState(serverUrl = normalized, connection = mutableState.value.connection,
            notice = if (normalized.isBlank()) "Сервис отключён. Локальная карта доступна." else "Адрес сохранён. Личные данные отправляются только на этот сервис.")
        if (mutableState.value.canUseNetwork) refresh()
    }

    fun authenticate(email: String, password: String, name: String? = null, role: String = "tourist") = action { epoch ->
        require(email.trim().contains('@') && email.length <= 254) { "Проверьте адрес электронной почты" }
        require(password.characterCount() in 12..128) { "Пароль должен содержать от 12 до 128 символов" }
        if (name != null) require(name.trim().length in 2..80) { "Имя должно содержать от 2 до 80 символов" }
        val session = api.authenticate(email, password, name, role)
        if (epoch != generation) return@action
        app.vault.saveSession(session)
        mutableState.update { it.copy(session = session, notice = if (name == null) "Вход выполнен" else if (role == "guide") "Аккаунт создан. Квалификация гида ожидает проверки." else "Аккаунт создан") }
        refreshData(epoch)
        refreshPrivateLists()
        flushOutbox()
    }

    fun logout() = action(online = false) { _ ->
        val session = mutableState.value.session
        syncJob?.cancel()
        val revoked = session != null && mutableState.value.connection != ConnectionState.OFFLINE && runCatching { api.logout(); true }.getOrDefault(false)
        generation++
        app.vault.clearSession()
        if (session != null) privateStore.clear(session)
        mutableState.value = OnlineState(serverUrl = app.vault.serverUrl(), connection = mutableState.value.connection,
            notice = if (revoked) "Вы вышли. Серверный сеанс отозван, личный кэш удалён." else "Вы вышли на этом устройстве. Отзыв серверного сеанса не подтверждён; он может действовать до истечения срока.")
        if (mutableState.value.canUseNetwork) refresh()
    }

    fun updateProfile(name: String, role: String) = action { epoch ->
        val session = requireSession()
        val account = api.updateProfile(name, role)
        if (same(session, epoch)) {
            val updated = session.copy(account = account)
            app.vault.saveSession(updated)
            mutableState.update { it.copy(session = updated, notice = "Профиль обновлён. Проверка гида выполняется отдельно.") }
        }
    }

    fun refresh() = action { epoch -> refreshData(epoch) }
    private suspend fun refreshData(epoch: Int) {
        if (epoch != generation) return
        mutableState.update { it.copy(readiness = ServerState.Checking) }
        val readiness = api.checkHealth()
        if (epoch != generation) return
        mutableState.update { it.copy(readiness = readiness, readinessCheckedAt = System.currentTimeMillis()) }
        if (readiness != ServerState.Reachable || mutableState.value.connection == ConnectionState.OFFLINE) return
        val session = mutableState.value.session
        if (session != null) {
            val account = api.me()
            if (!same(session, epoch)) return
            val updated = session.copy(account = account)
            app.vault.saveSession(updated)
            mutableState.update { it.copy(session = updated) }
        }
        val page = api.routePage()
        val routeFilter = mutableState.value.routeFilter
        val departures = api.departures(routeFilter)
        val requests = if (mutableState.value.session != null) api.recruitment(routeFilter) else emptyList()
        if (epoch == generation) mutableState.update { it.copy(routes = (page.routes + it.routes.filter { route -> route.id == routeFilter }).distinctBy { route -> route.id }, routeCursor = page.cursor, departures = departures, recruitment = requests, refreshedAt = System.currentTimeMillis()) }
        if (session != null && same(session, epoch)) {
            try { refreshAccountData(session, epoch) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                if (same(session, epoch)) mutableState.update { it.copy(accountError = if (failure is ApiFailure) readable(failure) else "Не удалось обновить кабинет. Попробуйте позже.") }
            }
        }
    }

    fun refreshAccount() = action { epoch -> refreshAccountData(requireSession(), epoch) }
    private suspend fun refreshAccountData(session: AccountSession, epoch: Int) = coroutineScope {
        val summary = async { api.accountSummary() }
        val notifications = async { api.notifications() }
        val reports = async { api.reports() }
        val moderation = async { api.moderationActions() }
        val appeals = async { api.appeals() }
        val result = summary.await(); val notes = notifications.await(); val reportList = reports.await()
        val actions = moderation.await(); val appealList = appeals.await()
        if (same(session, epoch)) mutableState.update { it.copy(accountSummary = result, notifications = notes, reports = reportList,
            moderationActions = actions, appeals = appealList, accountUpdatedAt = System.currentTimeMillis(), accountError = null) }
    }
    fun markRead(id: String) = action { epoch ->
        val session = requireSession(); api.readNotification(id)
        val notes = api.notifications()
        if (same(session, epoch)) mutableState.update { it.copy(notifications = notes) }
    }
    fun report(target: ReportTarget, reason: String, body: String, onSuccess: () -> Unit) = action { epoch ->
        val session = requireSession()
        require(body.trim().characterCount() in 10..2000) { "Опишите причину: от 10 до 2000 символов" }
        val report = api.report(target, reason, body)
        if (same(session, epoch)) { mutableState.update { it.copy(reports = listOf(report) + it.reports.filterNot { old -> old.id == report.id }, notice = "Обращение принято сервером. Решение появится в кабинете.") }; onSuccess() }
    }
    fun appeal(action: ModerationAction, body: String, onSuccess: () -> Unit) = action { epoch ->
        val session = requireSession()
        require(body.trim().characterCount() in 10..2000) { "Текст апелляции: от 10 до 2000 символов" }
        val appeal = api.appeal(action.id, body)
        if (same(session, epoch)) {
            mutableState.update { it.copy(appeals = listOf(appeal) + it.appeals.filterNot { old -> old.id == appeal.id },
                moderationActions = it.moderationActions.map { old -> if (old.id == action.id) old.copy(appealStatus = appeal.status) else old }, notice = "Апелляция принята сервером. Решение рассмотрит другой сотрудник.") }
            onSuccess()
        }
    }

    fun loadMoreRoutes() = action { epoch ->
        val cursor = mutableState.value.routeCursor ?: return@action
        val page = api.routePage(cursor)
        if (epoch == generation) mutableState.update { it.copy(routes = (it.routes + page.routes).distinctBy(PublishedRoute::id), routeCursor = page.cursor) }
    }

    fun openRoute(id: String, onReady: (PublishedRoute) -> Unit) = action { epoch ->
        val route = api.route(id)
        if (epoch == generation) { mutableState.update { it.copy(routes = (it.routes.filterNot { old -> old.id == route.id } + route)) }; onReady(route) }
    }

    fun openDeparture(id: String) = action { epoch ->
        val departure = api.departure(id)
        val roster = if (departure.guideId == mutableState.value.user?.id) api.participants(id) else emptyList()
        val reviews = api.reviews(id)
        if (epoch == generation) mutableState.update { it.copy(departure = departure, request = null, roster = roster, reviews = reviews, conversation = null) }
    }
    fun closeDetail() { mutableState.update { it.copy(departure = null, request = null, roster = emptyList(), reviews = emptyList(), error = null) } }
    private fun updateDeparture(departure: Departure) { mutableState.update { state -> state.copy(departure = departure, departures = state.departures.map { if (it.id == departure.id) departure else it }) } }
    private val joinKeys = mutableMapOf<String, String>()
    fun join(departure: Departure) = action { epoch ->
        requireSession()
        val key = joinKeys.getOrPut(departure.id) { UUID.randomUUID().toString() }
        val updated = api.join(departure, key)
        if (epoch == generation) { updateDeparture(updated); joinKeys.remove(departure.id); mutableState.update { it.copy(notice = "Сервер подтвердил участие в походе") } }
    }
    fun leave(departure: Departure) = action { epoch ->
        val updated = api.leave(departure.id)
        if (epoch == generation) { updateDeparture(updated); mutableState.update { it.copy(notice = "Участие отменено сервером") } }
    }
    fun checkIn(departure: Departure, participant: Participant) = action { epoch ->
        val updated = api.checkIn(departure, participant.userId)
        val roster = api.participants(departure.id)
        if (epoch == generation) { updateDeparture(updated); mutableState.update { it.copy(roster = roster, notice = "Сервер записал присутствие участника") } }
    }
    fun transition(departure: Departure, kind: String) = action { epoch ->
        val updated = api.transition(departure, kind)
        if (epoch == generation) { updateDeparture(updated); mutableState.update { it.copy(notice = "Сервер подтвердил новый статус похода") } }
    }
    fun createDeparture(body: JSONObject, recruitmentId: String? = null, onSuccess: () -> Unit = {}) = action { epoch ->
        val departure = if (recruitmentId == null) api.createDeparture(body) else api.acceptRecruitment(recruitmentId, body)
        if (epoch == generation) {
            refreshData(epoch)
            mutableState.update { it.copy(departure = departure, request = null, roster = emptyList(), notice = "Поход опубликован. Участники подтверждают запись отдельно.") }
            onSuccess()
        }
    }
    fun createRecruitment(route: PublishedRoute, date: String?, body: String, onSuccess: () -> Unit = {}) = action { epoch ->
        val request = api.createRecruitment(route.id, date, body)
        if (epoch == generation) { mutableState.update { it.copy(request = request, recruitment = listOf(request) + it.recruitment, notice = "Запрос создан. Это ещё не подтверждённый поход.") }; onSuccess(); openChat(Conversation(ConversationKind.RECRUITMENT, request.id, route.title)) }
    }
    fun selectRecruitment(request: Recruitment) { mutableState.update { it.copy(request = request, departure = null, error = null) } }
    fun joinRecruitment(request: Recruitment) = action { epoch ->
        api.joinRecruitment(request.id)
        if (epoch == generation) { refreshData(epoch); mutableState.update { it.copy(notice = "Интерес отмечен. Место в походе ещё не подтверждено.") }; openChat(Conversation(ConversationKind.RECRUITMENT, request.id, routeTitle(request.routeId))) }
    }
    fun leaveRecruitment(request: Recruitment) = action { epoch ->
        api.leaveRecruitment(request.id)
        if (epoch == generation) { refreshData(epoch); mutableState.update { it.copy(request = null, notice = "Вы вышли из набора. Запись на датированный поход изменяется отдельно.") } }
    }
    fun review(departure: Departure, target: String, rating: Int, body: String, onSuccess: () -> Unit = {}) = action { epoch ->
        api.review(departure.id, target, rating, body)
        val reviews = api.reviews(departure.id)
        if (epoch == generation) { mutableState.update { it.copy(reviews = reviews, notice = "Отзыв опубликован после проверки участия сервером") }; onSuccess() }
    }

    fun openChat(conversation: Conversation) {
        val session = mutableState.value.session ?: run { mutableState.update { it.copy(error = "Сначала войдите в аккаунт.") }; return }
        val epoch = generation
        mutableState.update { it.copy(conversation = conversation, messages = emptyList(), pending = emptyList(), messageCursor = null, chatError = null, chatUpdatedAt = 0) }
        viewModelScope.launch {
            val cached = privateStore.load(session, conversation)
            val pending = privateStore.views(session, conversation)
            if (same(session, epoch) && mutableState.value.conversation == conversation) {
                mutableState.update { it.copy(messages = cached?.messages.orEmpty(), pending = pending, messageCursor = cached?.cursor, chatUpdatedAt = cached?.updatedAt ?: 0) }
                refreshChat()
            }
        }
    }
    fun closeChat() { mutableState.update { it.copy(conversation = null, messages = emptyList(), pending = emptyList(), chatError = null) } }

    fun refreshChat() {
        val session = mutableState.value.session ?: return
        val conversation = mutableState.value.conversation ?: return
        if (!mutableState.value.canUseNetwork || mutableState.value.chatBusy) return
        val epoch = generation
        mutableState.update { it.copy(chatBusy = true) }
        viewModelScope.launch {
            chatMutex.withLock {
                try {
                    // Re-read the recent window so moderator removals update cached text too.
                    // A createdAt cursor alone cannot report changes to older messages.
                    val page = api.messages(conversation, null)
                    if (same(session, epoch) && mutableState.value.conversation == conversation) {
                        val merged = page.messages.distinctBy { it.id }.sortedWith(compareBy<ChatMessage> { it.createdAt }.thenBy { it.id }).takeLast(500)
                        val cursor = page.cursor ?: mutableState.value.messageCursor
                        privateStore.store(session, conversation, merged, cursor)
                        mutableState.update { it.copy(messages = merged, messageCursor = cursor, chatUpdatedAt = System.currentTimeMillis(), chatError = null) }
                        refreshPrivateLists()
                    }
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) {
                    if (same(session, epoch) && mutableState.value.conversation == conversation) mutableState.update { it.copy(chatError = if (failure is ApiFailure) readable(failure) else "Не удалось обновить переписку. Сохранённая история доступна.") }
                } finally { if (epoch == generation) mutableState.update { it.copy(chatBusy = false) } }
            }
        }
    }

    fun sendMessage(text: String, onQueued: () -> Unit = {}) {
        if (mutableState.value.enqueueBusy) return
        val session = mutableState.value.session ?: return
        val conversation = mutableState.value.conversation ?: return
        val epoch = generation
        mutableState.update { it.copy(enqueueBusy = true) }
        viewModelScope.launch {
            try {
                privateStore.enqueue(session, conversation, text)
                if (same(session, epoch)) {
                    onQueued()
                    refreshPrivateLists()
                    if (mutableState.value.canUseNetwork) flushOutbox()
                    else mutableState.update { it.copy(notice = "Сообщение сохранено на устройстве и ожидает подключения. Оно ещё не доставлено.") }
                }
            } catch (failure: Exception) { if (same(session, epoch)) mutableState.update { it.copy(chatError = failure.message ?: "Не удалось сохранить сообщение") } }
            finally { if (epoch == generation) mutableState.update { it.copy(enqueueBusy = false) } }
        }
    }

    fun flushOutbox(retryFailed: Boolean = false) {
        if (!mutableState.value.canUseNetwork || mutableState.value.session == null || syncJob?.isActive == true) return
        val session = mutableState.value.session ?: return
        val epoch = generation
        syncJob = viewModelScope.launch {
            outboxMutex.withLock {
                for (row in privateStore.pending(session)) {
                    if (!same(session, epoch)) break
                    if (row.failed && !retryFailed) continue
                    try {
                        val conversation = (listOfNotNull(mutableState.value.conversation) + mutableState.value.cachedConversations)
                            .firstOrNull { it.kind.name == row.kind && it.id == row.conversationId }
                            ?: Conversation(ConversationKind.valueOf(row.kind), row.conversationId, "Чат")
                        val accepted = api.sendMessage(conversation, privateStore.body(row), row.clientId)
                        if (!same(session, epoch)) break
                        // A successful POST is authoritative even if the following GET loses connectivity.
                        chatMutex.withLock {
                            val cached = privateStore.load(session, conversation)
                            val merged = (cached?.messages.orEmpty() + accepted).distinctBy { it.id }
                                .sortedWith(compareBy<ChatMessage> { it.createdAt }.thenBy { it.id }).takeLast(500)
                            privateStore.store(session, conversation, merged, cached?.cursor)
                            if (mutableState.value.conversation == conversation) mutableState.update { it.copy(messages = merged) }
                        }
                        // Only an actual API acknowledgement removes an item from the outbox.
                        privateStore.remove(row.clientId)
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (failure: ApiFailure) {
                        if (same(session, epoch)) privateStore.failed(row.clientId, !failure.transient, readable(failure))
                        if (failure.transient || failure.status == 401) break
                    } catch (_: Exception) {
                        if (same(session, epoch)) privateStore.failed(row.clientId, true, "Локальная запись недоступна. Удалите её и создайте сообщение заново.")
                    }
                }
                if (same(session, epoch)) { refreshPrivateLists(); refreshChat() }
            }
        }
    }
    fun removePending(clientId: String) {
        val session = mutableState.value.session ?: return
        viewModelScope.launch {
            if (privateStore.pending(session).any { it.clientId == clientId }) { privateStore.remove(clientId); refreshPrivateLists() }
        }
    }
    private suspend fun refreshPrivateLists() {
        val session = mutableState.value.session ?: return
        val epoch = generation
        val chats = privateStore.list(session)
        val conversation = mutableState.value.conversation
        val pending = if (conversation == null) emptyList() else privateStore.views(session, conversation)
        if (same(session, epoch)) mutableState.update { it.copy(cachedConversations = chats, pending = pending) }
    }

    private fun readable(error: ApiFailure): String = when {
        error.status == 401 -> "Не удалось подтвердить вход. Проверьте данные или войдите заново."
        error.status == 429 -> "Слишком много запросов. Повторите попытку позже."
        error.status == 409 -> "Данные изменились или действие уже недоступно. Обновите поход и проверьте условия. ${error.message}"
        error.status == 403 -> "Сервер не разрешил действие. ${error.message}"
        else -> error.message
    }
}
