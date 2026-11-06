package ru.tropa.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CutCornerShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp

private val controlShape = CutCornerShape(topStart = 4.dp, topEnd = 12.dp, bottomEnd = 4.dp, bottomStart = 12.dp)

@Composable
internal fun TrailButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
    shape: Shape = controlShape, contentPadding: PaddingValues = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
    content: @Composable RowScope.() -> Unit) {
    Button(onClick, modifier.heightIn(min = 48.dp), enabled, shape = shape,
        colors = ButtonDefaults.buttonColors(containerColor = Palette.Forest, contentColor = Palette.Surface,
            disabledContainerColor = Palette.Line, disabledContentColor = Palette.Muted), contentPadding = contentPadding) {
        content()
        Spacer(Modifier.width(8.dp))
        TropaIcon(Glyph.NEXT, Modifier.size(18.dp), color = if (enabled) Palette.Surface else Palette.Muted)
    }
}

@Composable
internal fun TrailOutlineButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
    shape: Shape = controlShape, contentPadding: PaddingValues = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
    content: @Composable RowScope.() -> Unit) {
    OutlinedButton(onClick, modifier.heightIn(min = 48.dp), enabled, shape = shape,
        border = BorderStroke(1.dp, if (enabled) Palette.Muted else Palette.Line),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = Palette.Surface, contentColor = Palette.Forest,
            disabledContainerColor = Palette.Background, disabledContentColor = Palette.Muted),
        contentPadding = contentPadding, content = content)
}

@Composable
internal fun TrailTextButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit) {
    TextButton(onClick, modifier.heightIn(min = 48.dp), enabled, shape = RoundedCornerShape(8.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = Palette.Forest, disabledContentColor = Palette.Muted),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)) {
        ProvideTextStyle(MaterialTheme.typography.labelMedium) { content() }
    }
}

@Composable
internal fun TrailIconButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
    content: @Composable () -> Unit) {
    IconButton(onClick, modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp), enabled,
        colors = IconButtonDefaults.iconButtonColors(contentColor = Palette.Forest, disabledContentColor = Palette.Muted), content = content)
}

@Composable
internal fun TrailChoice(selected: Boolean, onClick: () -> Unit, label: @Composable () -> Unit,
    modifier: Modifier = Modifier, enabled: Boolean = true, leadingIcon: (@Composable () -> Unit)? = null) {
    FilterChip(selected, onClick, label, modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp), enabled,
        leadingIcon = leadingIcon, shape = CutCornerShape(topStart = 3.dp, topEnd = 8.dp, bottomEnd = 3.dp, bottomStart = 8.dp),
        border = BorderStroke(1.dp, if (!enabled) Palette.Line else if (selected) Palette.Forest else Palette.Muted),
        colors = FilterChipDefaults.filterChipColors(containerColor = Palette.Surface, labelColor = Palette.Muted,
            selectedContainerColor = Palette.Land, selectedLabelColor = Palette.Forest, selectedLeadingIconColor = Palette.Forest))
}

@Composable
internal fun TrailDialog(onDismissRequest: () -> Unit, confirmButton: @Composable () -> Unit,
    dismissButton: (@Composable () -> Unit)? = null, title: (@Composable () -> Unit)? = null, text: (@Composable () -> Unit)? = null) {
    AlertDialog(onDismissRequest, confirmButton, dismissButton = dismissButton,
        icon = { Box(Modifier.size(48.dp).clip(CutCornerShape(10.dp)).background(Palette.Land), contentAlignment = Alignment.Center) { TropaIcon(Glyph.MOUNTAIN, Modifier.size(28.dp)) } },
        title = title, text = text, shape = MaterialTheme.shapes.extraLarge,
        containerColor = Palette.Surface, iconContentColor = Palette.Forest,
        titleContentColor = Palette.Text, textContentColor = Palette.Text, tonalElevation = 0.dp)
}
