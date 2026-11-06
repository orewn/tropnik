#!/usr/bin/env python3
"""Rasterise original MapIcon.tsx paths into MapLibre 1x/2x marker sprites.

No third-party pictograms or fonts are copied. This small SVG path reader only
supports the commands actually used by the project's seven outdoor symbols.
"""
from pathlib import Path
import hashlib
import json
import math
import re

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'web/components/MapIcon.tsx'
OUT = ROOT / 'web/public/maps'
KEYS = ['camp', 'water', 'shelter', 'pass', 'peak', 'viewpoint', 'info']
CREAM = '#faf6e9'
FOREST = '#244d3c'
LOGICAL_SIZE = 32
STROKE = 1.5
TOKEN = re.compile(r'[MmLlHhVvCcSsAaZz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?')


def arc(start, rx, ry, rotation, large, sweep, end):
    """SVG endpoint arc → sampled points; coordinates retain SVG's downward y."""
    rx, ry = abs(rx), abs(ry)
    if not rx or not ry or start == end:
        return [end]
    phi = math.radians(rotation % 360)
    cp, sp = math.cos(phi), math.sin(phi)
    dx, dy = (start[0]-end[0])/2, (start[1]-end[1])/2
    xp, yp = cp*dx+sp*dy, -sp*dx+cp*dy
    scale = xp*xp/(rx*rx) + yp*yp/(ry*ry)
    if scale > 1:
        rx *= math.sqrt(scale)
        ry *= math.sqrt(scale)
    numerator = max(0, rx*rx*ry*ry-rx*rx*yp*yp-ry*ry*xp*xp)
    denominator = rx*rx*yp*yp+ry*ry*xp*xp
    factor = math.sqrt(numerator/denominator) if denominator else 0
    if bool(large) == bool(sweep):
        factor = -factor
    cxp, cyp = factor*rx*yp/ry, -factor*ry*xp/rx
    cx = cp*cxp-sp*cyp+(start[0]+end[0])/2
    cy = sp*cxp+cp*cyp+(start[1]+end[1])/2
    a = math.atan2((yp-cyp)/ry, (xp-cxp)/rx)
    b = math.atan2((-yp-cyp)/ry, (-xp-cxp)/rx)
    delta = b-a
    if sweep and delta < 0:
        delta += 2*math.pi
    if not sweep and delta > 0:
        delta -= 2*math.pi
    steps = max(8, math.ceil(abs(delta)*16))
    result = []
    for i in range(1, steps+1):
        angle = a+delta*i/steps
        u, v = rx*math.cos(angle), ry*math.sin(angle)
        result.append((cp*u-sp*v+cx, sp*u+cp*v+cy))
    result[-1] = end
    return result


def flatten(path):
    tokens = TOKEN.findall(path)
    if re.sub(r'[\s,]', '', TOKEN.sub('', path)):
        raise ValueError('Unsupported SVG path content: '+path)
    i, command = 0, None
    current, start, previous_control = (0., 0.), (0., 0.), None
    previous_command = None
    contours, points = [], []
    arity = {'M': 2, 'L': 2, 'H': 1, 'V': 1, 'C': 6, 'S': 4, 'A': 7}
    while i < len(tokens):
        if tokens[i].isalpha():
            command = tokens[i]
            i += 1
            if command.upper() == 'Z':
                if points:
                    points.append(start)
                    contours.append(points)
                    points = []
                current, previous_control, previous_command = start, None, 'Z'
                command = None
                continue
        if command is None:
            raise ValueError('Missing path command: '+path)
        op, relative = command.upper(), command.islower()
        count = arity[op]
        values = [float(value) for value in tokens[i:i+count]]
        if len(values) != count:
            raise ValueError('Incomplete path command')
        i += count
        def point(x, y):
            return (x+current[0], y+current[1]) if relative else (x, y)
        old = current
        if op == 'M':
            if points:
                contours.append(points)
            current = point(*values)
            start, points = current, [current]
            command = 'l' if relative else 'L'
        elif op == 'L':
            current = point(*values)
            points.append(current)
        elif op == 'H':
            current = (values[0]+current[0] if relative else values[0], current[1])
            points.append(current)
        elif op == 'V':
            current = (current[0], values[0]+current[1] if relative else values[0])
            points.append(current)
        elif op in ('C', 'S'):
            if op == 'C':
                c1, c2, end = point(*values[:2]), point(*values[2:4]), point(*values[4:])
            else:
                c1 = (2*old[0]-previous_control[0], 2*old[1]-previous_control[1]) if previous_command in ('C', 'S') and previous_control else old
                c2, end = point(*values[:2]), point(*values[2:])
            for step in range(1, 33):
                t, u = step/32, 1-step/32
                points.append((u**3*old[0]+3*u*u*t*c1[0]+3*u*t*t*c2[0]+t**3*end[0],
                               u**3*old[1]+3*u*u*t*c1[1]+3*u*t*t*c2[1]+t**3*end[1]))
            current, previous_control = end, c2
        elif op == 'A':
            current = point(*values[5:])
            points.extend(arc(old, *values[:5], current))
        if op not in ('C', 'S'):
            previous_control = None
        previous_command = op
    if points:
        contours.append(points)
    return contours


def marker(paths, ratio):
    supersample = 4
    scale = ratio*supersample
    image = Image.new('RGBA', (LOGICAL_SIZE*scale, LOGICAL_SIZE*scale))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([scale, scale, 31*scale, 31*scale], radius=8*scale,
                           fill=CREAM, outline=FOREST, width=round(STROKE*scale))
    radius = STROKE*scale/2
    for path in paths:
        for contour in flatten(path):
            points = [((4+x*24/28)*scale, (4+y*24/28)*scale) for x, y in contour]
            if len(points) > 1:
                draw.line(points, fill=FOREST, width=round(STROKE*scale), joint='curve')
            # Round caps and joins follow the source component.
            for x, y in points:
                draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=FOREST)
    return image.resize((LOGICAL_SIZE*ratio, LOGICAL_SIZE*ratio), Image.Resampling.LANCZOS)


def main():
    source = SOURCE.read_text()
    paths = {}
    for key in KEYS:
        match = re.search(r'\b'+key+r':\[([^\]]+)\]', source)
        if not match:
            raise ValueError('Missing source icon: '+key)
        paths[key] = re.findall(r"'([^']+)'", match.group(1))
        if not paths[key]:
            raise ValueError('Empty source icon: '+key)
    OUT.mkdir(parents=True, exist_ok=True)
    generated = []
    for ratio in (1, 2):
        size = LOGICAL_SIZE*ratio
        atlas = Image.new('RGBA', (len(KEYS)*size, size))
        mapping = {}
        for i, key in enumerate(KEYS):
            atlas.alpha_composite(marker(paths[key], ratio), (i*size, 0))
            mapping[key] = {'x': i*size, 'y': 0, 'width': size, 'height': size,
                            'pixelRatio': ratio, 'sdf': False}
        name = 'tropnik-sprite'+('@2x' if ratio == 2 else '')
        atlas.save(OUT/(name+'.png'), optimize=True)
        (OUT/(name+'.json')).write_text(json.dumps(mapping, separators=(',', ':'))+'\n')
        generated.extend([name+'.png', name+'.json'])
    js = ('/* Original project artwork, generated from MapIcon.tsx. */\n'
          'export const outdoorPaths = '+json.dumps(paths, ensure_ascii=False, separators=(',', ':'))+';\n'
          'export const markerStyle = '+json.dumps({'size': LOGICAL_SIZE, 'fill': CREAM, 'stroke': FOREST, 'lineWidth': STROKE})+';\n')
    (OUT/'tropnik-pictograms.js').write_text(js)
    provenance = {'author': 'Tropnik project', 'source': 'web/components/MapIcon.tsx',
                  'sourceSha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
                  'rights': 'Original project artwork; no third-party pictograms or fonts. Follows the project licence.',
                  'logicalSize': LOGICAL_SIZE, 'keys': KEYS, 'generatedFiles': generated,
                  'coordinates': 'No geographic coordinates or POI records are created by this tool.'}
    (OUT/'tropnik-sprite-provenance.json').write_text(json.dumps(provenance, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'keys': KEYS, 'files': generated,
                      'sizes': {name: (OUT/name).stat().st_size for name in generated}}))


if __name__ == '__main__':
    main()
