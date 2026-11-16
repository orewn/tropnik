package ru.tropa.app

import android.graphics.Color
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import ru.tropa.app.ui.PageHeading
import ru.tropa.app.ui.TrailButton
import ru.tropa.app.ui.TropaApp
import ru.tropa.app.ui.TropaTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(Color.parseColor("#FFFEFA"), Color.parseColor("#FFFEFA")),
        )
        setContent { TropaTheme {
            CatalogueEntry(application as TropaApplication)
        } }
    }
}

private enum class CatalogLoadState { Loading, Ready, Failed }

@Composable
private fun CatalogueEntry(application: TropaApplication) {
    var startupState by remember(application) {
        mutableStateOf(if (application.catalogReady) CatalogLoadState.Ready else CatalogLoadState.Loading)
    }
    var attempt by remember(application) { mutableIntStateOf(0) }
    LaunchedEffect(application, attempt) {
        if (startupState == CatalogLoadState.Ready) return@LaunchedEffect
        try {
            application.prepareCatalog()
            currentCoroutineContext().ensureActive()
            startupState = CatalogLoadState.Ready
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            Log.e("TropaStartup", "Bundled catalogue could not be prepared", error)
            startupState = CatalogLoadState.Failed
        }
    }
    if (startupState == CatalogLoadState.Ready) {
        // These are the same Activity-owned ViewModels. A warm return keeps
        // their selected route, offline snapshot, and navigation state.
        val model: MainViewModel = viewModel()
        val online: OnlineViewModel = viewModel()
        TropaApp(model, online)
    } else {
        val failed = startupState == CatalogLoadState.Failed
        Scaffold { insets ->
            Column(Modifier.fillMaxSize().padding(insets).padding(24.dp)
                .testTag(if (failed) "catalog_startup_error" else "catalog_startup_loading"),
                verticalArrangement = Arrangement.spacedBy(16.dp)) {
                PageHeading(
                    if (failed) "Не удалось открыть маршруты" else "Открываем маршруты…",
                    if (failed) "Повторите попытку, чтобы открыть каталог приложения."
                    else "Подготавливаем каталог на устройстве.",
                )
                if (failed) {
                    TrailButton(onClick = {
                        startupState = CatalogLoadState.Loading
                        attempt += 1
                    }, modifier = Modifier.testTag("catalog_startup_retry")) { Text("Повторить") }
                } else {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                }
            }
        }
    }
}
