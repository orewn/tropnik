package ru.tropa.app.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import ru.tropa.app.data.BrowserPlannerTarget

/** The browser owns these plans and downloads; no web account or storage is
 * presented as part of the native offline catalogue. */
@Composable
internal fun BrowserPlannerCard(target: BrowserPlannerTarget, buttonTag: String) {
    val context = LocalContext.current
    var showDialog by remember(target.url) { mutableStateOf(false) }
    var error by remember(target.url) { mutableStateOf<String?>(null) }
    CardShell {
        Text("Составной поход", style = MaterialTheme.typography.titleLarge)
        Text("Соедините соседние и пересекающиеся тропы, распределите путь по дням и скачайте GPX.",
            style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
        Text("Конструктор работает в браузере.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
        TrailOutlineButton(onClick = { error = null; showDialog = true },
            modifier = Modifier.fillMaxWidth().testTag(buttonTag)) {
            Text(if (target.routeTitle == null) "Составить поход" else "Составить поход с этой тропой")
        }
    }
    if (showDialog) TrailDialog(
        onDismissRequest = { showDialog = false },
        title = { Text("Открыть конструктор?") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()).testTag("planner_explanation"),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                target.routeTitle?.let { Text("Начальная тропа: $it", Modifier.testTag("planner_route"), style = MaterialTheme.typography.bodyMedium) }
                Text("Конструктор откроется в браузере. Для загрузки нужна сеть.", style = MaterialTheme.typography.bodyMedium)
                Text("Планы сохраняются в этом браузере. Для переноса используйте файл JSON; маршрут можно скачать в GPX.",
                    style = MaterialTheme.typography.bodyMedium)
                error?.let { Text(it, Modifier.testTag("planner_browser_error"), style = MaterialTheme.typography.bodyMedium, color = Palette.Alert) }
            }
        },
        confirmButton = {
            TrailTextButton(onClick = {
                try {
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(target.url)).addCategory(Intent.CATEGORY_BROWSABLE))
                    showDialog = false
                } catch (_: ActivityNotFoundException) {
                    error = "Не найден браузер. Установите или включите браузер и повторите."
                } catch (_: SecurityException) {
                    error = "Система не разрешила открыть браузер. Проверьте настройки приложений и повторите."
                }
            }, modifier = Modifier.testTag("planner_open_browser")) { Text("Открыть в браузере") }
        },
        dismissButton = {
            TrailTextButton(onClick = { showDialog = false }, modifier = Modifier.testTag("planner_cancel")) { Text("Отмена") }
        },
    )
}
