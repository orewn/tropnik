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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import ru.tropa.app.Screen
import ru.tropa.app.destination

/** Measure full labels at the real tab width and font scale. Insets are outside
 * the measured row; no intrinsic-height estimate may clip a scaled paragraph. */
@Composable
internal fun MobileDestinationBar(screen: Screen, onSelect: (Screen) -> Unit) {
    val destinations = listOf(Triple(Screen.EXPLORE, "Карта", Glyph.MAP),
        Triple(Screen.SAVED, "Сохранено", Glyph.SAVE), Triple(Screen.MORE, "Ещё", Glyph.MORE))
    val density = LocalDensity.current
    val labelStyle = MaterialTheme.typography.labelSmall
    val textMeasurer = rememberTextMeasurer()
    Surface(color = Palette.Surface, tonalElevation = 0.dp) {
        BoxWithConstraints(Modifier.fillMaxWidth().navigationBarsPadding()) {
            val labelWidth = (constraints.maxWidth / destinations.size - with(density) { 8.dp.roundToPx() * 2 }).coerceAtLeast(1)
            val labelHeight = destinations.maxOf { (_, label, _) ->
                textMeasurer.measure(AnnotatedString(label), style = labelStyle,
                    constraints = Constraints(maxWidth = labelWidth)).size.height
            }
            val rowHeight = with(density) {
                maxOf(80.dp.roundToPx(), labelHeight + 32.dp.roundToPx() + 4.dp.roundToPx() + 8.dp.roundToPx() * 2).toDp()
            }
            Row(Modifier.fillMaxWidth().height(rowHeight).selectableGroup()) {
                destinations.forEach { (destination, label, glyph) ->
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
                        Text(label, style = labelStyle, color = if (selected) Palette.Forest else Palette.Muted,
                            textAlign = TextAlign.Center)
                    }
                }
            }
        }
    }
}
