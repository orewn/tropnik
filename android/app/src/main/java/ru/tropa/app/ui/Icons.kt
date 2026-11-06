package ru.tropa.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

enum class Glyph { MOUNTAIN, MAP, SAVE, PEOPLE, USER, BACK, NEXT, SEARCH, LOCATE, CHECK, INFO, CLOSE, TRASH, BOOKMARK, ZOOM_IN, ZOOM_OUT }

/** Small original geometric line icons; no external icon font is fetched. */
@Composable
fun TropaIcon(glyph: Glyph, modifier: Modifier = Modifier, color: Color = Palette.Forest, description: String? = null) {
    Canvas(modifier.size(24.dp).then(if (description != null) Modifier.semantics { contentDescription = description } else Modifier)) {
        val scale = size.minDimension / 24f
        val stroke = Stroke(width = 1.7f * scale, cap = StrokeCap.Round, join = StrokeJoin.Round)
        fun path(vararg points: Pair<Float, Float>, closed: Boolean = false) {
            val shape = Path()
            points.forEachIndexed { i, (x, y) -> if (i == 0) shape.moveTo(x * scale, y * scale) else shape.lineTo(x * scale, y * scale) }
            if (closed) shape.close()
            drawPath(shape, color, style = stroke)
        }
        fun circle(x: Float, y: Float, radius: Float) = drawCircle(color, radius * scale, Offset(x * scale, y * scale), style = stroke)
        when (glyph) {
            Glyph.ZOOM_IN -> { path(5f to 12f, 19f to 12f); path(12f to 5f, 12f to 19f) }
            Glyph.ZOOM_OUT -> path(5f to 12f, 19f to 12f)
            Glyph.MOUNTAIN -> { path(2f to 19f, 9f to 5f, 15f to 15f, 19f to 8f, 23f to 19f); path(8f to 19f, 13f to 19f) }
            Glyph.MAP -> { path(3f to 5f, 9f to 3f, 15f to 5f, 21f to 3f, 21f to 19f, 15f to 21f, 9f to 19f, 3f to 21f, closed = true); path(9f to 3f, 9f to 19f); path(15f to 5f, 15f to 21f) }
            Glyph.SAVE -> { path(12f to 3f, 12f to 15f); path(7f to 10f, 12f to 15f, 17f to 10f); path(4f to 16f, 4f to 21f, 20f to 21f, 20f to 16f) }
            Glyph.PEOPLE -> { circle(9f, 7f, 3f); circle(18f, 8f, 2.4f); path(3f to 21f, 3f to 17f, 5f to 14f, 13f to 14f, 15f to 17f, 15f to 21f); path(17f to 14f, 20f to 14f, 22f to 17f, 22f to 21f) }
            Glyph.USER -> { circle(12f, 7f, 3.5f); path(4f to 21f, 4f to 17f, 7f to 13f, 17f to 13f, 20f to 17f, 20f to 21f) }
            Glyph.BACK -> { path(15f to 5f, 8f to 12f, 15f to 19f) }
            Glyph.NEXT -> { path(9f to 5f, 16f to 12f, 9f to 19f) }
            Glyph.SEARCH -> { circle(10f, 10f, 6f); path(15f to 15f, 21f to 21f) }
            Glyph.LOCATE -> { circle(12f, 12f, 6f); circle(12f, 12f, 1.5f); path(12f to 1f, 12f to 5f); path(12f to 19f, 12f to 23f); path(1f to 12f, 5f to 12f); path(19f to 12f, 23f to 12f) }
            Glyph.CHECK -> path(4f to 12f, 9f to 17f, 20f to 6f)
            Glyph.INFO -> { circle(12f, 12f, 9f); path(12f to 11f, 12f to 17f); circle(12f, 7f, .1f) }
            Glyph.CLOSE -> { path(5f to 5f, 19f to 19f); path(5f to 19f, 19f to 5f) }
            Glyph.TRASH -> { path(4f to 6f, 20f to 6f); path(9f to 3f, 15f to 3f); path(6f to 6f, 7f to 21f, 17f to 21f, 18f to 6f); path(10f to 10f, 10f to 17f); path(14f to 10f, 14f to 17f) }
            Glyph.BOOKMARK -> path(6f to 3f, 18f to 3f, 18f to 21f, 12f to 17f, 6f to 21f, closed = true)
        }
    }
}
