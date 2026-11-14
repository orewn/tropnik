#!/usr/bin/env python3
"""Render the public SVG brand artwork and its PNG derivatives.

Requires fonttools and Inkscape. Text is outlined from the bundled Manrope font,
so generated sharing images do not depend on fonts installed on the host.
Run from any directory: python3 tools/branding/build-assets.py
"""
from pathlib import Path
from subprocess import run
from xml.sax.saxutils import escape

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "web/public"
FONT = ROOT / "android/app/src/main/res/font/manrope.ttf"
FOREST, PAPER, INK = "#244d3c", "#f5f3e8", "#17291f"
SUMMIT = "M6 31 20 7 34 31"
TRAIL = "M12 31h11a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h4"


def mark(color: str, transform: str = "") -> str:
    return (f'<g transform="{transform}" fill="none" stroke="{color}" '
            'stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">'
            f'<path d="{SUMMIT}"/><path d="{TRAIL}"/></g>')


def outline(text: str, x: int, y: int, size: int, weight: int, color: str) -> str:
    font = TTFont(FONT)
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": weight})
    glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
    scale, cursor, paths = size / font["head"].unitsPerEm, 0, []
    for char in text:
        name = cmap[ord(char)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(pen)
        paths.append(f'<path transform="translate({cursor} 0)" d="{pen.getCommands()}"/>')
        cursor += font["hmtx"][name][0]
    return (f'<g aria-label="{escape(text)}" fill="{color}" '
            f'transform="translate({x} {y}) scale({scale} {-scale})">' + "".join(paths) + '</g>')


def render(source: Path, output: Path, width: int, height: int) -> None:
    run(["inkscape", str(source), "--export-type=png", f"--export-filename={output}",
         f"--export-width={width}", f"--export-height={height}"], check=True, capture_output=True)


def main() -> None:
    svg_open = '<svg xmlns="http://www.w3.org/2000/svg"'
    favicon = (svg_open + ' width="512" height="512" viewBox="0 0 40 40">'
               '<title>Тропиныч</title>'
               f'<rect width="40" height="40" rx="8" fill="{FOREST}"/>'
               + mark(PAPER, "translate(6 6) scale(.7)") + '</svg>\n')
    (PUBLIC / "favicon.svg").write_text(favicon)
    (PUBLIC / "brand-mark.svg").write_text(
        svg_open + ' viewBox="0 0 40 40"><title>Тропиныч</title>' + mark(FOREST) + '</svg>\n')
    for size in (192, 512):
        render(PUBLIC / "favicon.svg", PUBLIC / f"icon-{size}.png", size, size)

    cover = [svg_open + ' width="1200" height="630" viewBox="0 0 1200 630">',
             '<title>Тропиныч — своя тропа найдётся</title>',
             f'<rect width="1200" height="630" fill="{PAPER}"/>',
             '<rect x="784" width="416" height="630" fill="#e0e7d5"/>',
             '<g fill="none" stroke="#bacab0" stroke-width="1.5">']
    for radius in (144, 184, 224, 264):
        cover.append(f'<ellipse cx="1000" cy="315" rx="{radius}" ry="{radius + 64}"/>')
    cover += ['</g>', mark(FOREST, "translate(60 44)"),
              outline("тропиныч", 112, 75, 30, 600, FOREST),
              outline("Своя тропа", 64, 237, 72, 600, INK),
              outline("найдётся.", 64, 325, 72, 600, INK),
              outline("Маршруты по России.", 64, 399, 24, 400, FOREST),
              outline("Карта, подготовка и данные офлайн.", 64, 439, 24, 400, FOREST),
              outline("От направления к маршруту", 64, 562, 20, 600, FOREST),
              mark(FOREST, "translate(840 155) scale(8)"), '</svg>\n']
    (PUBLIC / "og-cover.svg").write_text("".join(cover))
    render(PUBLIC / "og-cover.svg", PUBLIC / "og-cover.png", 1200, 630)
    print("Rendered SVG artwork, 192/512 app icons and 1200×630 sharing cover.")


if __name__ == "__main__":
    main()
