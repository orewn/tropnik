package ru.tropa.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import ru.tropa.app.OnlineState
import ru.tropa.app.OnlineViewModel
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
internal fun AccountHistoryScreen(model: OnlineViewModel, state: OnlineState, onBack: () -> Unit) {
    BackHandler { onBack() }
    LazyColumn(Modifier.fillMaxSize().testTag("account_history"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { TrailTextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) { TropaIcon(Glyph.BACK); Spacer(Modifier.width(8.dp)); Text("Назад в профиль") } }
        item { PageHeading("Пройденные\nмаршруты.", "Завершённые походы с подтверждённым участием. Эта история доступна только вам.") }
        item {
            CardShell {
                if (!state.canUseNetwork) Text("Без интернета доступна сохранённая история", style = MaterialTheme.typography.bodyMedium)
                TrailOutlineButton(onClick = model::refreshHistory, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Обновить историю") }
                if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                state.error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = Palette.Alert) }
            }
        }
        if (state.departureHistory.isEmpty()) item {
            EmptyCard(if (state.historyUpdatedAt == 0L) "История ещё не загружена" else "Ваши истории ещё впереди",
                if (state.historyUpdatedAt == 0L) "Подключитесь к сервису и обновите историю." else "После завершённого похода с подтверждённым участием здесь появится запись.", Glyph.PEOPLE)
        }
        items(state.departureHistory, key = { it.id }) { item ->
            CardShell {
                Text(item.routeTitle, style = MaterialTheme.typography.titleLarge)
                Text(historyDate(item.startsAt, item.timeZone), style = MaterialTheme.typography.bodyLarge)
                Text(if (item.role == "guide") "Вы провели этот поход" else "Ваше участие подтверждено", style = MaterialTheme.typography.bodyMedium, color = Palette.Forest)
                Text("Гид: ${item.guideName ?: "имя недоступно"}\nЗавершён ${historyDate(item.completedAt, item.timeZone)}", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                TrailOutlineButton(onClick = { model.openDeparture(item.id) }, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Поход, чат и отзывы") }
                if (item.reviewTargets.isNotEmpty()) Text("Поделитесь впечатлениями о походе.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
            }
        }
        if (state.historyCursor != null) item {
            TrailOutlineButton(onClick = model::loadMoreHistory, enabled = state.canUseNetwork && !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Показать предыдущие походы") }
        }
    }
}

private fun historyDate(value: String, zone: String): String = runCatching {
    Instant.parse(value).atZone(ZoneId.of(zone)).format(DateTimeFormatter.ofPattern("d MMMM yyyy", Locale.forLanguageTag("ru-RU")))
}.getOrDefault("Дата уточняется")
