package ru.tropa.app.ui

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import org.json.JSONObject
import ru.tropa.app.OnlineState
import ru.tropa.app.OnlineViewModel
import ru.tropa.app.data.*
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val Ru = Locale("ru", "RU")
private val zoneChoices = listOf("Europe/Moscow", "Europe/Kaliningrad", "Europe/Samara", "Asia/Yekaterinburg", "Asia/Omsk", "Asia/Novosibirsk", "Asia/Irkutsk", "Asia/Yakutsk", "Asia/Vladivostok", "Asia/Magadan", "Asia/Kamchatka")

@Composable
fun OnlineProfileScreen(model: OnlineViewModel, state: OnlineState, onSources: () -> Unit) {
    var showServer by remember { mutableStateOf(false) }
    var showLogout by remember { mutableStateOf(false) }
    var showAccountSafety by remember { mutableStateOf(false) }
    var showHistory by remember(state.user?.id) { mutableStateOf(false) }
    if (showHistory && state.user != null) {
        val chat = state.conversation
        val departure = state.departure
        when {
            chat != null -> ChatScreen(model, state, chat)
            departure != null -> {
                BackHandler { model.closeDetail() }
                DepartureScreen(model, state, departure, { showHistory = false }, "История походов")
            }
            else -> AccountHistoryScreen(model, state) { showHistory = false }
        }
        return
    }
    if (showAccountSafety && state.user != null) { AccountSafetyScreen(model, state) { showAccountSafety = false }; return }
    var register by rememberSaveable { mutableStateOf(false) }
    var email by rememberSaveable { mutableStateOf("") }
    // Never persist a password in saved-instance state or a local preference.
    var password by remember { mutableStateOf("") }
    var passwordVisible by remember { mutableStateOf(false) }
    var name by rememberSaveable { mutableStateOf("") }
    var role by rememberSaveable { mutableStateOf("tourist") }
    var editName by remember(state.user?.id, state.user?.displayName) { mutableStateOf(state.user?.displayName.orEmpty()) }
    var editRole by remember(state.user?.id, state.user?.role) { mutableStateOf(state.user?.role ?: "tourist") }
    LaunchedEffect(state.session?.account?.id) { if (state.session != null) password = "" }
    LazyColumn(Modifier.fillMaxSize().testTag("profile_list"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { PageHeading(if (state.user == null) "Знакомство\nначинается здесь." else "Своё место\nсреди своих.", "Аккаунт туриста или гида. Общение, договорённости и реальные походы.") }
        item { ServiceStatus(state, model::refresh) }
        item {
            CardShell {
                Text("Подключение", style = MaterialTheme.typography.titleLarge)
                Text(if (state.configured) "Подключение настроено. Войдите, чтобы записываться на походы и общаться." else "Вход, запись на походы и чаты станут доступны после подключения.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                TrailOutlineButton(onClick = { showServer = true }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("configure_service")) { Text(if (state.configured) "Настройки подключения" else "Подключиться") }
            }
        }
        item { OnlineError(state, model::clearError) }
        if (state.user == null) {
            item {
                CardShell {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TrailChoice(!register, { register = false }, label = { Text("Войти") }, modifier = Modifier.heightIn(min = 48.dp))
                        TrailChoice(register, { register = true }, label = { Text("Регистрация") }, modifier = Modifier.heightIn(min = 48.dp))
                    }
                    if (register) Field(name, { name = it.take(80) }, "Как вас зовут", tag = "auth_name")
                    Field(email, { email = it.take(254) }, "Электронная почта", keyboard = KeyboardType.Email, tag = "auth_email")
                    OutlinedTextField(password, { password = it.takeCharacters(128) }, Modifier.fillMaxWidth().testTag("auth_password"), label = { Text("Пароль, 12–128 символов") },
                        singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                        trailingIcon = { TrailTextButton(onClick = { passwordVisible = !passwordVisible }) { Text(if (passwordVisible) "Скрыть" else "Показать") } })
                    if (register) {
                        RoleChoice(role) { role = it }
                        if (role == "guide") Text("Регистрация гида создаёт заявку на проверку. Вести поход можно после подтверждения квалификации для нужного вида активности и региона.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                    }
                    TrailButton(onClick = { model.authenticate(email, password, if (register) name else null, role) }, enabled = state.canUseNetwork && !state.busy && email.contains('@') && password.characterCount() in 12..128 && (!register || name.trim().length >= 2), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("auth_submit")) { Text(if (register) "Создать аккаунт" else "Войти") }
                    Text(if (!state.configured) "Сначала настройте подключение выше." else "Ваш пароль не сохраняется в приложении.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                }
            }
        } else {
            val account = state.user!!
            item {
                CardShell {
                    Text(account.displayName, style = MaterialTheme.typography.headlineMedium)
                    Text(account.email, style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                    StatusPill(if (account.role == "guide") guideLabel(account.guideStatus) else "Турист", caution = account.role == "guide" && account.guideStatus != "verified")
                    if (account.staffRole in setOf("moderator", "admin")) Text(if (account.staffRole == "admin") "Администратор" else "Модератор", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                    if (!account.emailVerified) Text("Подтвердите адрес электронной почты.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                    Field(editName, { editName = it.take(80) }, "Отображаемое имя")
                    RoleChoice(editRole) { editRole = it }
                    TrailOutlineButton(onClick = { model.updateProfile(editName, editRole) }, enabled = state.canUseNetwork && !state.busy && editName.trim().length in 2..80, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Сохранить профиль") }
                    Text("Чтобы вести походы, гиду нужно подтвердить квалификацию для выбранного района.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                    TrailTextButton(onClick = { showLogout = true }, enabled = !state.busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Выйти на этом устройстве") }
                }
            }
            item { AccountSummaryCard(state) { showAccountSafety = true; if (state.canUseNetwork && !state.busy) model.refreshAccount() } }
            item {
                TrailOutlineButton(onClick = {
                    model.closeChat(); model.closeDetail(); showHistory = true
                    if (state.canUseNetwork) model.refreshHistory()
                }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("open_account_history")) { Text("История походов и отзывы") }
            }
        }
        item {
            CardShell {
                Text("Личные данные под контролем", style = MaterialTheme.typography.titleLarge)
                Text("При выходе сохранённая переписка и неотправленные сообщения удаляются с телефона. Местоположение определяется только по вашей кнопке и остаётся на устройстве.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
            }
        }
        item {
            CardShell {
                Text("Тропник", style = MaterialTheme.typography.titleLarge)
                Text("Находите маршруты и людей, с которыми по пути.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                TrailTextButton(onClick = onSources, Modifier.heightIn(min = 48.dp).testTag("show_sources")) { Text("Источники и лицензии") }
            }
        }
    }
    if (showServer) ServerDialog(state, model, onDismiss = { showServer = false })
    if (showLogout) ConfirmAction("Выйти из аккаунта?", "Сохранённая переписка и неотправленные сообщения удалятся с телефона. Закладки и карты останутся.", "Выйти", { showLogout = false }, { showLogout = false; model.logout() })
}

@Composable
private fun ServerDialog(state: OnlineState, model: OnlineViewModel, onDismiss: () -> Unit) {
    var value by remember { mutableStateOf(state.serverUrl) }
    var validation by remember { mutableStateOf<String?>(null) }
    TrailDialog(onDismissRequest = onDismiss, title = { Text("Подключение к Тропнику") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Укажите адрес подключения, которому доверяете. Здесь будут храниться аккаунт и сообщения.", style = MaterialTheme.typography.bodyMedium)
            Field(value, { value = it; validation = null }, "Адрес подключения", keyboard = KeyboardType.Uri, tag = "service_url")
            Text("Пустое поле отключает подключение.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
            if (state.session != null) Text("Смена подключения завершит вход и удалит сохранённую переписку, включая неотправленные сообщения.", color = Palette.Alert, style = MaterialTheme.typography.bodyMedium)
            validation?.let { Text(it, color = Palette.Alert) }
        }
    }, confirmButton = { TrailTextButton(onClick = {
        runCatching { ApiAddress.normalize(value) }.onSuccess { model.configureServer(it); onDismiss() }.onFailure { validation = "Проверьте адрес подключения и попробуйте снова." }
    }, enabled = !state.busy) { Text("Сохранить адрес") } }, dismissButton = { TrailTextButton(onClick = onDismiss) { Text("Отмена") } })
}

@Composable
fun OnlineTripsScreen(model: OnlineViewModel, state: OnlineState, onProfile: () -> Unit, onRoute: (PublishedRoute) -> Unit) {
    var createRequest by remember { mutableStateOf(false) }
    var createDeparture by remember { mutableStateOf(false) }
    var acceptRequest by remember { mutableStateOf<Recruitment?>(null) }
    val departures = state.departures.filter { state.routeFilter == null || it.routeId == state.routeFilter }
    val requests = state.recruitment.filter { state.routeFilter == null || it.routeId == state.routeFilter }
    val chat = state.conversation
    if (chat != null) { ChatScreen(model, state, chat); return }
    BackHandler(state.departure != null || state.request != null) { model.closeDetail() }
    when {
        state.departure != null -> DepartureScreen(model, state, state.departure, onProfile)
        state.request != null -> RecruitmentScreen(model, state, state.request) { acceptRequest = it }
        else -> LazyColumn(Modifier.fillMaxSize().testTag("trips_list"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item { PageHeading("Хороший поход\nначинается с людей.", "Один маршрут. Одна дата. Своя группа и проверенный гид.") }
            item { ServiceStatus(state, model::refresh) }
            item { OnlineError(state, model::clearError) }
            item { InfoCard("Для похода нужны минимум 4 человека, включая гида. Чтобы записаться, подключитесь к интернету и дождитесь подтверждения.") }
            if (state.routeFilter != null) item { CardShell { Text("Выбран маршрут: ${model.routeTitle(state.routeFilter)}", style = MaterialTheme.typography.titleMedium); TrailTextButton(onClick = { model.filterRoute(null) }) { Text("Показать все маршруты") } } }
            if (!state.configured || state.user == null) item {
                CardShell {
                    Text(if (!state.configured) "Подключим вашу группу" else "Походы доступны после входа", style = MaterialTheme.typography.titleLarge)
                    Text(if (!state.configured) "Маршруты и карта уже доступны. Для записи и общения настройте подключение в профиле." else "Опубликованные походы можно изучать. Для записи и общения нужен аккаунт.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                    TrailButton(onClick = onProfile, Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Перейти в профиль") }
                }
            }
            if (state.user != null) item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    TrailButton(onClick = { createRequest = true }, enabled = state.canUseNetwork && !state.busy && state.routes.any { it.status == "published" }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Начать набор на маршрут") }
                    if (state.user?.guideStatus == "verified") TrailOutlineButton(onClick = { createDeparture = true }, enabled = state.canUseNetwork && !state.busy && state.routes.any { it.status == "published" }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Опубликовать поход с датой") }
                }
            }
            if (state.cachedConversations.isNotEmpty()) {
                item { SectionHeading("Ваши переписки", "Открытые ранее чаты хранятся на этом устройстве") }
                items(state.cachedConversations, key = { "chat:${it.kind}:${it.id}" }) { conversation ->
                    OutlineCard(onClick = { model.openChat(conversation) }) {
                        Text(conversation.title, style = MaterialTheme.typography.titleMedium)
                        Text(if (conversation.kind == ConversationKind.DEPARTURE) "Чат похода" else "Чат набора", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                    }
                }
            }
            item { SectionHeading("Походы с датой", "Выберите подходящие дату и маршрут") }
            if (departures.isEmpty()) item { EmptyCard("Походов пока нет", if (state.refreshedAt == 0L) "После подключения здесь появятся походы, к которым можно присоединиться." else "Для выбранного направления походы пока не загружены. Можно начать набор по опубликованному маршруту.", Glyph.PEOPLE) }
            items(departures, key = { "departure:${it.id}" }) { departure ->
                OutlineCard(onClick = { model.openDeparture(departure.id) }) {
                    StatusPill(departureLabel(departure.status), caution = !departure.routeOpen || !departure.guideEligible)
                    Text(departure.routeTitle ?: model.routeTitle(departure.routeId), style = MaterialTheme.typography.titleMedium)
                    Text(dateTime(departure.startsAt, departure.timeZone), style = MaterialTheme.typography.bodyLarge)
                    Text("${departure.participantCount} из ${departure.capacity} · ${departure.guideName ?: "Гид не назначен"}", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                }
            }
            item { SectionHeading("Ищем компанию", "Набор без назначенного похода ещё не подтверждает участие") }
            if (requests.isEmpty()) item { Text(if (state.user == null) "Войдите, чтобы видеть наборы и участвовать в обсуждении." else "Открытых наборов пока нет.", color = Palette.Muted, style = MaterialTheme.typography.bodyMedium) }
            items(requests, key = { "request:${it.id}" }) { request ->
                OutlineCard(onClick = { model.selectRecruitment(request) }) {
                    StatusPill(if (request.status == "accepted") "Гид предложил поход" else if (request.status == "cancelled") "Набор закрыт" else "Ищем компанию")
                    Text(model.routeTitle(request.routeId), style = MaterialTheme.typography.titleMedium)
                    Text(request.body, style = MaterialTheme.typography.bodyMedium, maxLines = 3)
                    Text("${request.creatorName} · интересуются ${request.interestedCount}", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                }
            }
            item { SectionHeading("Маршруты для походов", "Выберите путь для своей группы") }
            if (state.routes.isEmpty()) item { Text("Маршрутов для записи пока нет. Посмотреть другие направления можно во вкладке «Карта».", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted) }
            items(state.routes, key = { "published:${it.id}" }) { route ->
                OutlineCard(onClick = { model.openRoute(route.id, onRoute) }) {
                    StatusPill(if (route.status == "closed") "Закрыт" else "Открыт для походов", caution = route.status == "closed")
                    Text(route.title, style = MaterialTheme.typography.titleMedium)
                    Text("${route.distanceKm} км · ${difficultyLabel(route.difficulty)}", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                    Text("Посмотреть маршрут", style = MaterialTheme.typography.labelLarge, color = Palette.Forest)
                }
            }
            if (state.routeCursor != null) item { TrailOutlineButton(onClick = model::loadMoreRoutes, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Показать ещё маршруты") } }
            item { InfoCard("Приложение не обещает доставку SOS без канала связи. Сообщения в очереди ещё не видны вашей группе.", Palette.Ochre) }
        }
    }
    if (createRequest || state.recruitmentForRoute != null) RecruitmentDialog(state, model) { createRequest = false; model.closeRecruitmentComposer() }
    if (createDeparture || acceptRequest != null) DepartureDialog(state, model, acceptRequest) { createDeparture = false; acceptRequest = null }
}

@Composable
private fun DepartureScreen(model: OnlineViewModel, state: OnlineState, departure: Departure, onProfile: () -> Unit, backLabel: String = "Все походы") {
    var confirm by remember { mutableStateOf<Pair<String, String>?>(null) }
    var review by remember { mutableStateOf(false) }
    var reportedReview by remember { mutableStateOf<ReportTarget?>(null) }
    val assigned = state.user?.id == departure.guideId
    val activeMembership = departure.membership in setOf("confirmed", "checked_in", "completed")
    val openForJoin = departure.status in setOf("recruiting", "ready", "awaiting_guide")
    LazyColumn(Modifier.fillMaxSize().testTag("departure_detail"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { BackAction(backLabel, model::closeDetail) }
        item { PageHeading(departure.routeTitle ?: model.routeTitle(departure.routeId), dateTime(departure.startsAt, departure.timeZone)) }
        item { ServiceStatus(state) { model.openDeparture(departure.id) } }
        item { OnlineError(state, model::clearError) }
        item {
            CardShell {
                StatusPill(departureLabel(departure.status), caution = !departure.routeOpen || !departure.guideEligible)
                Text("${departure.participantCount} из ${departure.capacity} участников", style = MaterialTheme.typography.titleLarge)
                Text("Минимум ${departure.minPeople} всего, включая гида. Ваш статус: ${membershipLabel(departure.membership)}.", style = MaterialTheme.typography.bodyMedium)
                Text("Гид: ${departure.guideName ?: "не назначен"}\nЗавершение: ${dateTime(departure.endsAt, departure.timeZone)}\nЧасовой пояс: ${departure.timeZone}", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                Text(if (departure.routeOpen) "Маршрут открыт для похода." else "Маршрут недоступен. Начать поход сейчас нельзя.", color = if (departure.routeOpen) Palette.Forest else Palette.Alert)
                Text(if (departure.guideEligible) "Квалификация гида подтверждена." else "Гиду нужно подтвердить допуск. Начать поход сейчас нельзя.", color = if (departure.guideEligible) Palette.Forest else Palette.Alert)
                if (state.user == null) TrailButton(onClick = onProfile, Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Войти для участия") }
                else {
                    if (!activeMembership && openForJoin) TrailButton(onClick = { model.join(departure) }, enabled = state.canUseNetwork && !state.busy && departure.routeOpen && departure.guideEligible && departure.participantCount < departure.capacity, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Присоединиться к походу") }
                    if (activeMembership || assigned) TrailOutlineButton(onClick = { model.openChat(Conversation(ConversationKind.DEPARTURE, departure.id, model.routeTitle(departure.routeId))) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Открыть чат группы") }
                    if (activeMembership && !assigned && openForJoin) TrailTextButton(onClick = { confirm = "leave" to "Отменить своё участие? Дождитесь подтверждения, чтобы место освободилось." }, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Отменить участие") }
                }
            }
        }
        if (assigned) {
            item { SectionHeading("Перед стартом", "Отметьте присутствие каждого человека, включая себя") }
            if (state.roster.isEmpty()) item { Text("Обновите карточку, чтобы загрузить список участников.", color = Palette.Muted) }
            items(state.roster, key = { it.userId }) { participant ->
                CardShell {
                    Text(participant.displayName, style = MaterialTheme.typography.titleMedium)
                    Text("${if (participant.role == "guide") "Гид" else "Турист"} · ${membershipLabel(participant.status)}", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                    if (participant.status == "confirmed" && openForJoin) TrailOutlineButton(onClick = { model.checkIn(departure, participant) }, enabled = state.canUseNetwork && !state.busy && departure.guideEligible, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Подтвердить присутствие") }
                }
            }
            item {
                CardShell {
                    Text("Решение о старте", style = MaterialTheme.typography.titleLarge)
                    Text("Отмечены ${state.roster.count { it.status == "checked_in" }} из минимум ${departure.minPeople}. Убедитесь, что группа на месте и готова к выходу.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                    if (openForJoin) TrailButton(onClick = { confirm = "start" to "Начать поход? Убедитесь, что все отмеченные участники на месте и готовы к выходу." }, enabled = state.canUseNetwork && !state.busy && departure.guideEligible && departure.routeOpen && state.roster.count { it.status == "checked_in" } >= departure.minPeople, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Проверить условия и начать") }
                    if (departure.status == "in_progress") {
                        TrailButton(onClick = { confirm = "complete" to "Завершить поход? Подтвердите, что группа вернулась и поход действительно окончен." }, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Завершить поход") }
                        TrailOutlineButton(onClick = { confirm = "abort" to "Сообщить группе, что поход прерван? Это действие не вызывает спасателей." }, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Прервать поход") }
                    }
                    if (openForJoin) TrailTextButton(onClick = { confirm = "cancel" to "Отменить поход для всей группы? Участники увидят изменение после подключения к интернету." }, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Отменить поход") }
                }
            }
        }
        item { SectionHeading("Отзывы участников", "Отзывы публикуются после завершённого похода и проверки участия") }
        if (state.reviews.isEmpty()) item { Text("Отзывов пока нет. После похода участники смогут поделиться впечатлениями.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted) }
        items(state.reviews, key = { it.id }) { item -> CardShell {
            Text("${if (item.target == "guide") "Гид" else "Маршрут"} · ${item.rating} из 5", style = MaterialTheme.typography.titleMedium); Text(item.body); Text(dateTime(item.createdAt), style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
            if (state.user != null) TrailTextButton(onClick = { reportedReview = ReportTarget("review", item.id) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Сообщить о нарушении") }
        } }
        if (departure.status == "completed" && departure.membership == "completed" && !assigned && departure.reviewTargets?.isEmpty() != true) item { TrailOutlineButton(onClick = { review = true }, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Оставить отзыв") } }
    }
    confirm?.let { action -> ConfirmAction("Подтвердите действие", action.second, "Подтвердить", { confirm = null }, { confirm = null; if (action.first == "leave") model.leave(departure) else model.transition(departure, action.first) }) }
    if (review) ReviewDialog(state, model, departure) { review = false }
    reportedReview?.let { ReportDialog(state, model, it) { reportedReview = null } }
}

@Composable
private fun RecruitmentScreen(model: OnlineViewModel, state: OnlineState, request: Recruitment, onAccept: (Recruitment) -> Unit) {
    var confirmLeave by remember { mutableStateOf(false) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { BackAction("Все наборы", model::closeDetail) }
        item { PageHeading(model.routeTitle(request.routeId), "Начинаем с компании. Дата и проверенный гид определяют будущий поход.") }
        item { OnlineError(state, model::clearError) }
        item {
            CardShell {
                Text(request.creatorName, style = MaterialTheme.typography.titleMedium)
                Text(request.body, style = MaterialTheme.typography.bodyLarge)
                Text("Интересуются: ${request.interestedCount}" + (request.preferredDate?.let { "\nЖелаемая дата: $it" } ?: ""), style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                InfoCard("Интерес к набору не бронирует место. Когда гид создаст поход с датой, каждый участник записывается отдельно.")
                if (request.status == "open") TrailButton(onClick = { model.joinRecruitment(request) }, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Присоединиться к обсуждению") }
                TrailOutlineButton(onClick = { model.openChat(Conversation(ConversationKind.RECRUITMENT, request.id, model.routeTitle(request.routeId))) }, enabled = state.user != null, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Открыть чат набора") }
                if (request.departureId != null) TrailButton(onClick = { model.openDeparture(request.departureId) }, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Посмотреть предложенный поход") }
                if (request.status == "open" && state.user?.guideStatus == "verified") TrailOutlineButton(onClick = { onAccept(request) }, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Предложить поход как гид") }
                TrailTextButton(onClick = { confirmLeave = true }, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Выйти из набора") }
            }
        }
    }
    if (confirmLeave) ConfirmAction("Выйти из набора?", "Вы перестанете участвовать в обсуждении. Запись на уже созданный поход изменяется отдельно.", "Выйти", { confirmLeave = false }, { confirmLeave = false; model.leaveRecruitment(request) })
}

@Composable
private fun ChatScreen(model: OnlineViewModel, state: OnlineState, conversation: Conversation) {
    var draft by remember(conversation.kind, conversation.id, state.user?.id) { mutableStateOf("") }
    var reportedMessage by remember { mutableStateOf<ReportTarget?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    BackHandler { model.closeChat() }
    LaunchedEffect(lifecycle, conversation, state.canUseNetwork) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) { if (state.canUseNetwork) model.refreshChat(); delay(10_000) }
        }
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            BackAction("Назад к походам", model::closeChat)
            Text(conversation.title, style = MaterialTheme.typography.titleLarge)
            Text(if (state.canUseNetwork) "Переписка обновляется при открытом экране" else "Без связи · доступна сохранённая история", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
            if (state.chatUpdatedAt > 0L) Text("Последнее обновление: ${localTime(state.chatUpdatedAt)}", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
            if (state.chatBusy) LinearProgressIndicator(Modifier.fillMaxWidth())
            state.chatError?.let { Text(it, color = Palette.Alert, style = MaterialTheme.typography.bodyMedium) }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("chat_messages"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (state.messages.isEmpty() && state.pending.isEmpty()) item { EmptyCard("Разговор начинается здесь", if (state.chatBusy) "Загружаем доступную переписку…" else "Здесь ещё нет сообщений. Начните знакомство с группой.", Glyph.PEOPLE) }
            items(state.messages, key = { "server:${it.id}" }) { message ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    MessageBubble(message.displayName, if (message.visibility == "hidden") "Сообщение скрыто модератором" else message.body, dateTime(message.createdAt), message.userId == state.user?.id)
                    if (message.visibility != "hidden" && message.userId != state.user?.id) TrailTextButton(onClick = { reportedMessage = ReportTarget(if (conversation.kind == ConversationKind.DEPARTURE) "message" else "recruitment_message", message.id) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Сообщить о нарушении") }
                }
            }
            items(state.pending, key = { "pending:${it.clientId}" }) { pending ->
                CardShell {
                    StatusPill(if (pending.failed) "Не отправлено" else "Ожидает отправки", caution = true)
                    Text(pending.body, style = MaterialTheme.typography.bodyLarge)
                    Text(pending.error ?: "Ещё не отправлено. Группа пока не получила сообщение.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                    TrailTextButton(onClick = { model.removePending(pending.clientId) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Удалить из очереди") }
                }
            }
        }
        Surface(color = Palette.Surface) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (state.accountSummary?.mutedNow == true) Text("Отправка ограничена до ${dateTime(state.accountSummary.mutedUntil!!)}. Причина и апелляция — в профиле.", style = MaterialTheme.typography.bodySmall, color = Palette.Alert)
                if (state.pending.isNotEmpty()) TrailOutlineButton(onClick = { model.flushOutbox(retryFailed = true) }, enabled = state.canUseNetwork, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Отправить снова (${state.pending.size})") }
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(draft, { draft = it.take(4000) }, Modifier.weight(1f).testTag("chat_composer"), label = { Text("Сообщение") }, minLines = 1, maxLines = 4)
                    TrailButton(onClick = { val submitted = draft; model.sendMessage(submitted) { if (draft == submitted) draft = "" } }, enabled = draft.isNotBlank() && state.user != null && !state.enqueueBusy && state.accountSummary?.mutedNow != true, modifier = Modifier.heightIn(min = 56.dp).testTag("chat_send")) { Text(if (state.canUseNetwork) "Отправить" else "В очередь") }
                }
            }
        }
    }
    reportedMessage?.let { ReportDialog(state, model, it) { reportedMessage = null } }
}

@Composable
private fun MessageBubble(name: String, body: String, time: String, mine: Boolean) {
    Column(Modifier.fillMaxWidth().padding(start = if (mine) 24.dp else 0.dp, end = if (mine) 0.dp else 24.dp)
        .background(if (mine) Palette.Land else Palette.Surface, RoundedCornerShape(12.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(name, style = MaterialTheme.typography.labelLarge, color = Palette.Forest)
        Text(body, style = MaterialTheme.typography.bodyLarge)
        Text("$time · отправлено", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
    }
}

@Composable
private fun RecruitmentDialog(state: OnlineState, model: OnlineViewModel, onDismiss: () -> Unit) {
    var routeId by remember { mutableStateOf(state.recruitmentForRoute?.id ?: state.routeFilter ?: state.routes.firstOrNull { it.status == "published" }?.id) }
    var body by rememberSaveable { mutableStateOf("") }
    var date by rememberSaveable { mutableStateOf("") }
    var validation by remember { mutableStateOf<String?>(null) }
    val selected = state.routes.firstOrNull { it.id == routeId }
    FormDialog("Начать набор", state, onDismiss, confirm = {
        TrailTextButton(onClick = {
            val validDate = date.isBlank() || runCatching { LocalDate.parse(date); true }.getOrDefault(false)
            if (!validDate) validation = "Дата должна быть в формате ГГГГ-ММ-ДД"
            else selected?.let { model.createRecruitment(it, date.takeIf(String::isNotBlank), body, onDismiss) }
        }, enabled = !state.busy && state.canUseNetwork && selected != null && body.isNotBlank()) { Text("Создать набор") }
    }) {
        RouteChoice(state.routes.filter { it.status == "published" }, routeId) { routeId = it }
        Field(date, { date = it.take(10); validation = null }, "Желаемая дата, необязательно", supporting = "ГГГГ-ММ-ДД")
        OutlinedTextField(body, { body = it.take(2000) }, Modifier.fillMaxWidth(), label = { Text("Расскажите о планах") }, minLines = 3, maxLines = 6)
        Text("Создадим обсуждение маршрута. Гид назначит дату; участники затем подтвердят запись на поход отдельно.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
        validation?.let { Text(it, color = Palette.Alert) }
    }
}

@Composable
private fun DepartureDialog(state: OnlineState, model: OnlineViewModel, recruitment: Recruitment?, onDismiss: () -> Unit) {
    var routeId by remember { mutableStateOf(recruitment?.routeId ?: state.routes.firstOrNull { it.status == "published" }?.id) }
    var starts by remember { mutableStateOf(LocalDate.now().plusDays(1).atTime(9, 0)) }
    var ends by remember { mutableStateOf(LocalDate.now().plusDays(1).atTime(18, 0)) }
    var zone by remember { mutableStateOf("Europe/Moscow") }
    var minimum by remember { mutableStateOf("4") }
    var capacity by remember { mutableStateOf("8") }
    var validation by remember { mutableStateOf<String?>(null) }
    val selected = state.routes.firstOrNull { it.id == routeId }
    LaunchedEffect(routeId) {
        minimum = (selected?.minPeople ?: 4).toString()
        capacity = minOf(maxOf(8, selected?.minPeople ?: 4), selected?.maxGroupSize ?: 50).toString()
    }
    FormDialog(if (recruitment == null) "Опубликовать поход" else "Предложить поход группе", state, onDismiss, confirm = {
        TrailTextButton(onClick = {
            val min = minimum.toIntOrNull(); val cap = capacity.toIntOrNull()
            val start = starts.atZone(ZoneId.of(zone)).toInstant(); val end = ends.atZone(ZoneId.of(zone)).toInstant()
            validation = when {
                !start.isAfter(Instant.now()) -> "Начало должно быть в будущем"
                !end.isAfter(start) -> "Завершение должно быть позже начала"
                min == null || cap == null || min !in maxOf(4, selected?.minPeople ?: 4)..50 || cap !in min..(selected?.maxGroupSize ?: 50) -> "Проверьте минимум и вместимость по правилам маршрута"
                (selected?.requiredGuides ?: 1) > 1 -> "Для этого маршрута нужны несколько гидов. Создание такого похода пока недоступно."
                else -> null
            }
            if (validation == null && routeId != null) {
                val body = JSONObject().put("routeId", routeId).put("startsAt", start.toString()).put("endsAt", end.toString())
                    .put("timeZone", zone).put("minPeople", min).put("capacity", cap)
                selected?.revisionId?.let { body.put("routeRevisionId", it) }
                model.createDeparture(body, recruitment?.id, onDismiss)
            }
        }, enabled = state.canUseNetwork && !state.busy && routeId != null) { Text("Опубликовать") }
    }) {
        if (recruitment == null) RouteChoice(state.routes.filter { it.status == "published" }, routeId) { routeId = it }
        else Text(selected?.title ?: "Маршрут выбранного набора", style = MaterialTheme.typography.titleMedium)
        ChoiceField("Часовой пояс", zone, zoneChoices, { zone = it })
        DateTimeField("Начало", starts) { starts = it }
        DateTimeField("Завершение", ends) { ends = it }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Field(minimum, { minimum = it.filter(Char::isDigit).take(2) }, "Минимум", Modifier.weight(1f), KeyboardType.Number)
            Field(capacity, { capacity = it.filter(Char::isDigit).take(2) }, "Всего мест", Modifier.weight(1f), KeyboardType.Number)
        }
        Text("Гид включён в число участников. Для проведения похода нужен действующий допуск. Каждый турист подтверждает запись отдельно.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
        selected?.let { Text("Правила маршрута: минимум ${it.minPeople}, максимум ${it.maxGroupSize}, гидов ${it.requiredGuides}.", style = MaterialTheme.typography.bodyMedium) }
        validation?.let { Text(it, color = Palette.Alert) }
    }
}

@Composable
private fun ReviewDialog(state: OnlineState, model: OnlineViewModel, departure: Departure, onDismiss: () -> Unit) {
    val targets = departure.reviewTargets ?: listOf("route", "guide")
    var rating by remember { mutableIntStateOf(0) }
    var target by remember(departure.id, targets) { mutableStateOf(targets.firstOrNull() ?: "route") }
    var body by remember { mutableStateOf("") }
    FormDialog("Ваш опыт похода", state, onDismiss, confirm = {
        TrailTextButton(onClick = { model.review(departure, target, rating, body, onDismiss) }, enabled = state.canUseNetwork && !state.busy && target in targets && rating in 1..5 && body.isNotBlank()) { Text("Опубликовать") }
    }) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if ("route" in targets) TrailChoice(target == "route", { target = "route" }, label = { Text("Маршрут") }, modifier = Modifier.heightIn(min = 48.dp))
            if ("guide" in targets) TrailChoice(target == "guide", { target = "guide" }, label = { Text("Гид") }, modifier = Modifier.heightIn(min = 48.dp))
        }
        Text("Ваша оценка", style = MaterialTheme.typography.titleMedium)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            (1..5).forEach { value -> TrailChoice(rating == value, { rating = value }, label = { Text(value.toString()) }, modifier = Modifier.heightIn(min = 48.dp)) }
        }
        OutlinedTextField(body, { body = it.take(3000) }, Modifier.fillMaxWidth(), label = { Text("Что было полезно другим участникам") }, minLines = 3, maxLines = 6)
        Text("Отзывы могут оставить подтверждённые участники после завершения похода.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
    }
}

@Composable
private fun FormDialog(title: String, state: OnlineState, onDismiss: () -> Unit, confirm: @Composable () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    TrailDialog(onDismissRequest = { if (!state.busy) onDismiss() }, title = { Text(title) },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) { content(); if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth()); state.error?.let { Text(it, color = Palette.Alert, style = MaterialTheme.typography.bodyMedium) } } },
        confirmButton = confirm, dismissButton = { TrailTextButton(onClick = onDismiss, enabled = !state.busy) { Text("Отмена") } })
}

@Composable
private fun DateTimeField(label: String, value: LocalDateTime, onChange: (LocalDateTime) -> Unit) {
    val context = LocalContext.current
    TrailOutlineButton(onClick = {
        DatePickerDialog(context, { _, y, m, d ->
            TimePickerDialog(context, { _, h, minute -> onChange(LocalDateTime.of(y, m + 1, d, h, minute)) }, value.hour, value.minute, true).show()
        }, value.year, value.monthValue - 1, value.dayOfMonth).show()
    }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("$label: ${value.format(DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm"))}") }
}

@Composable
private fun RouteChoice(routes: List<PublishedRoute>, selectedId: String?, onChange: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        TrailOutlineButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(routes.firstOrNull { it.id == selectedId }?.title ?: "Выберите маршрут") }
        DropdownMenu(expanded, { expanded = false }, modifier = Modifier.heightIn(max = 320.dp)) {
            routes.forEach { route -> DropdownMenuItem(text = { Text(route.title) }, onClick = { onChange(route.id); expanded = false }) }
        }
    }
}

@Composable
private fun ChoiceField(label: String, value: String, choices: List<String>, onChange: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        TrailOutlineButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("$label: $value") }
        DropdownMenu(expanded, { expanded = false }, modifier = Modifier.heightIn(max = 320.dp)) {
            choices.forEach { item -> DropdownMenuItem(text = { Text(item) }, onClick = { onChange(item); expanded = false }) }
        }
    }
}

@Composable
private fun RoleChoice(role: String, onChange: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        TrailChoice(role == "tourist", { onChange("tourist") }, label = { Text("Турист") }, modifier = Modifier.heightIn(min = 48.dp))
        TrailChoice(role == "guide", { onChange("guide") }, label = { Text("Гид") }, modifier = Modifier.heightIn(min = 48.dp))
    }
}

@Composable
private fun Field(value: String, onChange: (String) -> Unit, label: String, modifier: Modifier = Modifier, keyboard: KeyboardType = KeyboardType.Text, supporting: String? = null, tag: String = "") {
    OutlinedTextField(value, onChange, modifier.fillMaxWidth().testTag(tag), label = { Text(label) }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboard), supportingText = if (supporting == null) null else { { Text(supporting) } })
}

@Composable
private fun ServiceStatus(state: OnlineState, onRefresh: () -> Unit) {
    val readiness = state.readiness
    val status = when {
        !state.configured -> "Вход и запись на походы пока недоступны"
        state.connection == ConnectionState.OFFLINE -> "Без интернета доступны сохранённые данные"
        readiness == ServerState.Checking -> "Подключаемся…"
        readiness == ServerState.Reachable -> "Есть подключение"
        readiness is ServerState.Unavailable -> "Не удалось подключиться. Попробуйте позже"
        else -> "Обновите страницу, чтобы подключиться"
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text(status, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
            if (state.configured) TrailTextButton(onClick = onRefresh, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Обновить") }
        }
        if (state.configured) {
            Text(if (state.user == null) "Вход в аккаунт не выполнен" else "Вход в аккаунт выполнен", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
            if (state.connection != ConnectionState.OFFLINE && readiness is ServerState.Unavailable) {
                Text("Проверьте подключение к интернету и повторите попытку.", style = MaterialTheme.typography.bodySmall, color = Palette.Alert)
            }
            if (state.refreshedAt > 0) Text("Данные обновлены ${localTime(state.refreshedAt)}", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
        }
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    }
}

@Composable
private fun OnlineError(state: OnlineState, onClear: () -> Unit) {
    state.error?.let { message -> CardShell { Text(message, color = Palette.Alert, style = MaterialTheme.typography.bodyMedium); TrailTextButton(onClick = onClear) { Text("Понятно") } } }
}

@Composable
private fun OutlineCard(onClick: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, Palette.Line), colors = CardDefaults.cardColors(containerColor = Palette.Surface)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}

@Composable
private fun BackAction(label: String, onBack: () -> Unit) { TrailTextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) { TropaIcon(Glyph.BACK); Spacer(Modifier.width(8.dp)); Text(label) } }

@Composable
private fun ConfirmAction(title: String, message: String, confirm: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    TrailDialog(onDismissRequest = onDismiss, title = { Text(title) }, text = { Text(message) }, confirmButton = { TrailTextButton(onClick = onConfirm) { Text(confirm) } }, dismissButton = { TrailTextButton(onClick = onDismiss) { Text("Отмена") } })
}

private fun guideLabel(value: String) = when (value) { "verified" -> "Гид · квалификация проверена"; "pending" -> "Гид · ожидает проверки"; "expired" -> "Гид · допуск истёк"; "suspended" -> "Гид · допуск приостановлен"; else -> "Гид · допуск не подтверждён" }
private fun departureLabel(value: String) = when (value) { "ready" -> "Группа набрана"; "recruiting" -> "Набираем группу"; "awaiting_guide" -> "Ожидает гида"; "in_progress" -> "Поход идёт"; "completed" -> "Поход завершён"; "cancelled" -> "Поход отменён"; "aborted" -> "Поход прерван"; else -> value }
private fun membershipLabel(value: String) = when (value) { "confirmed" -> "участие подтверждено"; "checked_in" -> "присутствие отмечено"; "completed" -> "поход завершён"; "cancelled" -> "участие отменено"; "no_show" -> "не участвовал"; else -> "не записан" }
private fun difficultyLabel(value: String) = when (value) { "easy" -> "простой"; "moderate" -> "средний"; "hard" -> "сложный"; "expert" -> "экспертный"; else -> value }
private fun dateTime(value: String, zone: String = ZoneId.systemDefault().id): String = runCatching { Instant.parse(value).atZone(ZoneId.of(zone)).format(DateTimeFormatter.ofPattern("d MMM yyyy, HH:mm", Ru)) }.getOrDefault(value)
private fun localTime(value: Long) = Instant.ofEpochMilli(value).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("d MMM, HH:mm", Ru))
