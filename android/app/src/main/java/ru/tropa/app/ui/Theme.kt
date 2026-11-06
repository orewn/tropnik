package ru.tropa.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.Shapes
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ru.tropa.app.R

object Palette {
    val Background = Color(0xFFF5F3E8)
    val Surface = Color(0xFFFFFEFA)
    val Forest = Color(0xFF244D3C)
    val Ochre = Color(0xFFA56736)
    val WarningText = Color(0xFF87502A)
    val Text = Color(0xFF14271E)
    val Muted = Color(0xFF667569)
    val Land = Color(0xFFE5EADB)
    val Water = Color(0xFFD3E4EA)
    val Line = Color(0xFFD8DDCE)
    val Alert = Color(0xFFB33F37)
}

@OptIn(ExperimentalTextApi::class)
private val family = FontFamily(
    Font(R.font.manrope, weight = FontWeight.Normal, variationSettings = FontVariation.Settings(FontVariation.weight(400))),
    Font(R.font.manrope, weight = FontWeight.Medium, variationSettings = FontVariation.Settings(FontVariation.weight(500))),
    Font(R.font.manrope, weight = FontWeight.SemiBold, variationSettings = FontVariation.Settings(FontVariation.weight(600))),
    Font(R.font.manrope, weight = FontWeight.Bold, variationSettings = FontVariation.Settings(FontVariation.weight(700))),
)

val TropaTypography = Typography(
    displayLarge = TextStyle(fontFamily = family, fontWeight = FontWeight.SemiBold, fontSize = 48.sp, lineHeight = 52.sp),
    displayMedium = TextStyle(fontFamily = family, fontWeight = FontWeight.SemiBold, fontSize = 40.sp, lineHeight = 48.sp),
    displaySmall = TextStyle(fontFamily = family, fontWeight = FontWeight.SemiBold, fontSize = 36.sp, lineHeight = 40.sp),
    headlineLarge = TextStyle(fontFamily = family, fontWeight = FontWeight.SemiBold, fontSize = 30.sp, lineHeight = 36.sp),
    headlineMedium = TextStyle(fontFamily = family, fontWeight = FontWeight.SemiBold, fontSize = 24.sp, lineHeight = 32.sp),
    headlineSmall = TextStyle(fontFamily = family, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp),
    titleLarge = TextStyle(fontFamily = family, fontWeight = FontWeight.SemiBold, fontSize = 20.sp, lineHeight = 28.sp),
    titleMedium = TextStyle(fontFamily = family, fontWeight = FontWeight.Medium, fontSize = 18.sp, lineHeight = 28.sp),
    titleSmall = TextStyle(fontFamily = family, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 24.sp),
    bodyLarge = TextStyle(fontFamily = family, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontFamily = family, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontFamily = family, fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 16.sp),
    labelLarge = TextStyle(fontFamily = family, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 24.sp),
    labelMedium = TextStyle(fontFamily = family, fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 20.sp),
    labelSmall = TextStyle(fontFamily = family, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, lineHeight = 16.sp),
)

@Composable
fun TropaTheme(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides 48.dp) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Palette.Forest, onPrimary = Palette.Surface,
            primaryContainer = Palette.Land, onPrimaryContainer = Palette.Text,
            background = Palette.Background, onBackground = Palette.Text,
            surface = Palette.Surface, onSurface = Palette.Text,
            surfaceVariant = Palette.Land, onSurfaceVariant = Palette.Muted,
            secondary = Palette.Ochre, onSecondary = Palette.Surface,
            secondaryContainer = Palette.Land, onSecondaryContainer = Palette.Forest,
            tertiary = Palette.Forest, onTertiary = Palette.Surface,
            tertiaryContainer = Palette.Water, onTertiaryContainer = Palette.Text,
            surfaceTint = Palette.Forest, outline = Palette.Muted, outlineVariant = Palette.Line,
            surfaceDim = Color(0xFFE1E4D9), surfaceBright = Palette.Surface,
            surfaceContainerLowest = Palette.Surface, surfaceContainerLow = Palette.Background,
            surfaceContainer = Color(0xFFECEEE2), surfaceContainerHigh = Palette.Land,
            surfaceContainerHighest = Color(0xFFDDE2D5),
            inverseSurface = Color(0xFF1C3528), inverseOnSurface = Palette.Surface, inversePrimary = Palette.Land,
            error = Palette.Alert, onError = Palette.Surface,
            errorContainer = Color(0xFFFBE4DD), onErrorContainer = Color(0xFF742820), scrim = Palette.Text,
        ),
        typography = TropaTypography,
        shapes = Shapes(
            extraSmall = RoundedCornerShape(12.dp), small = RoundedCornerShape(8.dp),
            medium = RoundedCornerShape(12.dp), large = RoundedCornerShape(16.dp),
            extraLarge = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp, bottomStart = 24.dp, bottomEnd = 8.dp),
        ),
        content = content,
    )
    }
}
