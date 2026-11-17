package ru.tropa.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import ru.tropa.app.Screen
import ru.tropa.app.destination

/** Full labels determine the height, including 200% text on narrow phones. */
@Composable
internal fun MobileDestinationBar(screen: Screen, onSelect: (Screen) -> Unit) {
    Surface(color = Palette.Surface, tonalElevation = 0.dp) {
        Row(Modifier.fillMaxWidth().navigationBarsPadding().height(IntrinsicSize.Min)
            .heightIn(min = 80.dp).selectableGroup()) {
            listOf(Triple(Screen.EXPLORE, "Карта", Glyph.MAP),
                Triple(Screen.SAVED, "Сохранено", Glyph.SAVE),
                Triple(Screen.MORE, "Ещё", Glyph.MORE)).forEach { (destination, label, glyph) ->
                val selected = screen.destination() == destination
                Column(Modifier.weight(1f).fillMaxHeight().heightIn(min = 48.dp)
                    .testTag("nav_${destination.name.lowercase()}")
                    .selectable(selected = selected, role = Role.Tab, onClick = { onSelect(destination) })
                    .padding(horizontal = 8.dp, vertical = 8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center) {
                    Box(Modifier.width(64.dp).height(32.dp).background(
                        if (selected) Palette.Land else Palette.Surface, RoundedCornerShape(12.dp)),
                        contentAlignment = Alignment.Center) {
                        TropaIcon(glyph, color = if (selected) Palette.Forest else Palette.Muted)
                    }
                    Spacer(Modifier.height(4.dp))
                    Text(label, style = MaterialTheme.typography.labelSmall,
                        color = if (selected) Palette.Forest else Palette.Muted, textAlign = TextAlign.Center)
                }
            }
        }
    }
}
