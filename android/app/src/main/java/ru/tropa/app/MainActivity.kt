package ru.tropa.app

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.viewmodel.compose.viewModel
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
            val model: MainViewModel = viewModel()
            val online: OnlineViewModel = viewModel()
            TropaApp(model, online)
        } }
    }
}
