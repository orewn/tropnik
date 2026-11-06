package ru.tropa.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ru.tropa.app.OnlineState
import ru.tropa.app.OnlineViewModel
import ru.tropa.app.data.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
internal fun AccountSummaryCard(state: OnlineState, onOpen: () -> Unit) {
    CardShell {
        Text("Личный кабинет", style = MaterialTheme.typography.titleLarge)
        val summary = state.accountSummary
        if (summary == null) Text("Статистика и награды появятся после ответа сервиса. Они основаны на подтверждённом участии.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
        else {
            Text("${summary.completedTrips} завершённых походов · ${summary.reviewsWritten} отзывов", style = MaterialTheme.typography.bodyLarge)
            if (summary.badges.isEmpty()) Text("Наград пока нет. Участие и полезные отзывы подтверждает сервер.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
            summary.badges.forEach { badge ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(badge.title, style = MaterialTheme.typography.titleMedium, color = Palette.Forest)
                    Text(badge.description, style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                    Text("Получено ${safetyDate(badge.earnedAt)}", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                }
            }
            if (summary.mutedNow) Text("Отправка сообщений временно ограничена до ${safetyDate(summary.mutedUntil!!)}. Причина и апелляция доступны в кабинете.", color = Palette.Alert, style = MaterialTheme.typography.bodyMedium)
        }
        state.accountError?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = Palette.Alert) }
        TrailOutlineButton(onClick = onOpen, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Уведомления, обращения и апелляции") }
    }
}

@Composable
internal fun AccountSafetyScreen(model: OnlineViewModel, state: OnlineState, onBack: () -> Unit) {
    var appealAction by remember { mutableStateOf<ModerationAction?>(null) }
    BackHandler { onBack() }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { TrailTextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) { TropaIcon(Glyph.BACK); Spacer(Modifier.width(8.dp)); Text("Назад в профиль") } }
        item { PageHeading("Уважение\nк каждому голосу.", "Решения сервиса, ваши обращения и право на пересмотр.") }
        item {
            CardShell {
                Text(if (state.canUseNetwork) "Данные по последнему ответу сервиса" else "Без связи · доступны ранее загруженные данные", style = MaterialTheme.typography.bodyMedium)
                if (state.accountUpdatedAt > 0) Text("Обновлено ${safetyDate(Instant.ofEpochMilli(state.accountUpdatedAt).toString())}", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                TrailOutlineButton(onClick = model::refreshAccount, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Обновить кабинет") }
                if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                (state.error ?: state.accountError)?.let { Text(it, color = Palette.Alert, style = MaterialTheme.typography.bodyMedium) }
            }
        }
        item { SectionHeading("Уведомления", "Только события, которые вернул ваш сервис") }
        if (state.notifications.isEmpty()) item { Text(if (state.accountUpdatedAt == 0L) "Обновите кабинет, чтобы получить уведомления." else "Уведомлений пока нет.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted) }
        items(state.notifications, key = { "notification:${it.id}" }) { notification ->
            CardShell {
                if (notification.readAt == null) StatusPill("Новое")
                Text(notification.title, style = MaterialTheme.typography.titleMedium)
                Text(notification.body, style = MaterialTheme.typography.bodyMedium)
                Text(safetyDate(notification.createdAt), style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                if (notification.readAt == null) TrailTextButton(onClick = { model.markRead(notification.id) }, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Отметить прочитанным") }
            }
        }
        item { SectionHeading("Ваши обращения", "Жалоба отправляется из сообщения или отзыва") }
        if (state.reports.isEmpty()) item { Text(if (state.accountUpdatedAt == 0L) "Список ещё не загружен." else "Вы пока не отправляли обращений.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted) }
        items(state.reports, key = { "report:${it.id}" }) { report ->
            CardShell {
                StatusPill(when (report.status) { "open" -> "На рассмотрении"; "resolved" -> "Рассмотрено"; "dismissed" -> "Нарушение не подтверждено"; else -> report.status })
                Text(reasonLabel(report.reason), style = MaterialTheme.typography.titleMedium)
                Text(report.body, style = MaterialTheme.typography.bodyMedium)
                report.decisionReason?.let { Text("Решение: $it", style = MaterialTheme.typography.bodyMedium, color = Palette.Forest) }
                Text(safetyDate(report.createdAt), style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
            }
        }
        item { SectionHeading("Решения по вашему аккаунту", "Можно подать апелляцию на решение модерации") }
        if (state.moderationActions.isEmpty()) item { Text(if (state.accountUpdatedAt == 0L) "Список ещё не загружен." else "Сервис не вернул решений по вашему аккаунту.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted) }
        items(state.moderationActions, key = { "action:${it.id}" }) { action ->
            CardShell {
                StatusPill(if (action.revokedAt != null) "Решение отменено" else when (action.action) { "hide" -> "Публикация скрыта"; "mute" -> "Ограничение сообщений"; "hide_and_mute" -> "Скрытие и ограничение"; else -> action.action }, caution = action.revokedAt == null)
                Text(action.reason, style = MaterialTheme.typography.bodyLarge)
                Text("Решение от ${safetyDate(action.createdAt)}", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                action.expiresAt?.let { Text("Ограничение до ${safetyDate(it)}", style = MaterialTheme.typography.bodyMedium) }
                if (action.appealStatus != null) Text("Апелляция: ${appealLabel(action.appealStatus)}", style = MaterialTheme.typography.bodyMedium)
                if (action.revokedAt == null && action.appealStatus == null) TrailOutlineButton(onClick = { appealAction = action }, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Подать апелляцию") }
            }
        }
        item { SectionHeading("Ваши апелляции", "Результат рассматривает сотрудник, не принявший исходное решение") }
        if (state.appeals.isEmpty()) item { Text(if (state.accountUpdatedAt == 0L) "Список ещё не загружен." else "Апелляций пока нет.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted) }
        items(state.appeals, key = { "appeal:${it.id}" }) { appeal ->
            CardShell {
                StatusPill(appealLabel(appeal.status))
                Text(appeal.body, style = MaterialTheme.typography.bodyMedium)
                appeal.decisionReason?.let { Text("Обоснование: $it", style = MaterialTheme.typography.bodyMedium, color = Palette.Forest) }
                Text(safetyDate(appeal.createdAt), style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
            }
        }
        item { InfoCard("Обращения и апелляции требуют связи. Автоматическая защита от спама и ограничения сервера могут отклонить отправку; сообщение об ошибке не означает принятие обращения.") }
    }
    appealAction?.let { action -> AppealDialog(state, model, action) { appealAction = null } }
}

@Composable
internal fun ReportDialog(state: OnlineState, model: OnlineViewModel, target: ReportTarget, onDismiss: () -> Unit) {
    var reason by remember { mutableStateOf("spam") }
    var expanded by remember { mutableStateOf(false) }
    var body by remember { mutableStateOf("") }
    SafetyDialog("Сообщить о нарушении", state, onDismiss, confirm = {
        TrailTextButton(onClick = { model.report(target, reason, body, onDismiss) }, enabled = state.canUseNetwork && state.user != null && !state.busy && body.trim().characterCount() in 10..2000) { Text("Отправить обращение") }
    }) {
        Box {
            TrailOutlineButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(reasonLabel(reason)) }
            DropdownMenu(expanded, { expanded = false }) {
                listOf("spam", "harassment", "dangerous_information", "personal_data", "other").forEach { value -> DropdownMenuItem(text = { Text(reasonLabel(value)) }, onClick = { reason = value; expanded = false }) }
            }
        }
        OutlinedTextField(body, { body = it.takeCharacters(2000) }, modifier = Modifier.fillMaxWidth(), label = { Text("Что произошло") }, minLines = 3, maxLines = 6, supportingText = { Text("10–2000 символов") })
        Text("Модератор получит ссылку на выбранную публикацию и ваше описание. Пожалуйста, не добавляйте чужие контактные или медицинские данные без необходимости.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
    }
}

@Composable
private fun AppealDialog(state: OnlineState, model: OnlineViewModel, action: ModerationAction, onDismiss: () -> Unit) {
    var body by remember { mutableStateOf("") }
    SafetyDialog("Попросить о пересмотре", state, onDismiss, confirm = {
        TrailTextButton(onClick = { model.appeal(action, body, onDismiss) }, enabled = state.canUseNetwork && !state.busy && body.trim().characterCount() in 10..2000) { Text("Отправить апелляцию") }
    }) {
        Text("Исходное решение: ${action.reason}", style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(body, { body = it.takeCharacters(2000) }, Modifier.fillMaxWidth(), label = { Text("Почему решение нужно пересмотреть") }, minLines = 3, maxLines = 6, supportingText = { Text("10–2000 символов") })
        Text("Отправка апелляции не отменяет действующее ограничение. Итог придёт от сервиса и появится в кабинете.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
    }
}

@Composable
private fun SafetyDialog(title: String, state: OnlineState, onDismiss: () -> Unit, confirm: @Composable () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    TrailDialog(onDismissRequest = { if (!state.busy) onDismiss() }, title = { Text(title) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            content(); if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            state.error?.let { Text(it, color = Palette.Alert, style = MaterialTheme.typography.bodyMedium) }
            if (!state.canUseNetwork) Text("Для отправки нужно подключение к сервису.", style = MaterialTheme.typography.bodyMedium, color = Palette.Ochre)
        }
    }, confirmButton = confirm, dismissButton = { TrailTextButton(onClick = onDismiss, enabled = !state.busy) { Text("Отмена") } })
}

private fun reasonLabel(value: String) = when (value) { "spam" -> "Спам или реклама"; "harassment" -> "Оскорбления и травля"; "dangerous_information" -> "Опасная информация"; "personal_data" -> "Чужие личные данные"; else -> "Другая причина" }
private fun appealLabel(value: String) = when (value) { "open" -> "на рассмотрении"; "upheld" -> "решение оставлено в силе"; "overturned" -> "решение отменено"; else -> value }
private fun safetyDate(value: String) = runCatching { Instant.parse(value).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("d MMM yyyy, HH:mm", Locale.forLanguageTag("ru-RU"))) }.getOrDefault(value)
