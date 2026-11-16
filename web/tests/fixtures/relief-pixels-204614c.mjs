// Immutable numeric reference from production commit 204614c.
// Keep the full-source Horn/GDAL calculation independent of the incremental path.
function elevationAt(heights, size, x, y, halo) {
    if (x >= 0 && x < size && y >= 0 && y < size)
        return heights[y * size + x];
    const dx = x < 0 ? -1 : x >= size ? 1 : 0, dy = y < 0 ? -1 : y >= size ? 1 : 0, key = `${dx},${dy}`;
    const border = halo[key];
    if (border && border.length !== (dx && dy ? 1 : size))
        throw new Error('Invalid elevation halo');
    return border?.[dx && dy ? 0 : dx ? y : x];
}
export function reliefPixelsReference(heights, size, tileY, z, halo = {}) {
    if (heights.length !== size * size)
        throw new Error('Invalid elevation samples');
    const pixels = new Uint8ClampedArray(size * size * 4);
    const flat = Math.SQRT1_2;
    for (let y = 0; y < size; y++) {
        const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + (y + .5) / size) / 2 ** z)));
        const metres = 40075016.68557849 * Math.cos(latitude) / (2 ** z * size);
        const row = y * size, innerRow = y > 0 && y < size - 1;
        for (let x = 0; x < size; x++) {
            const at = row + x, centre = heights[at];
            let left, right, top, bottom, northWest, northEast, southWest, southEast;
            if (innerRow && x > 0 && x < size - 1) {
                left = heights[at - 1];
                right = heights[at + 1];
                top = heights[at - size];
                bottom = heights[at + size];
                northWest = heights[at - size - 1];
                northEast = heights[at - size + 1];
                southWest = heights[at + size - 1];
                southEast = heights[at + size + 1];
            }
            else {
                left = elevationAt(heights, size, x - 1, y, halo);
                right = elevationAt(heights, size, x + 1, y, halo);
                top = elevationAt(heights, size, x, y - 1, halo);
                bottom = elevationAt(heights, size, x, y + 1, halo);
                northWest = elevationAt(heights, size, x - 1, y - 1, halo);
                northEast = elevationAt(heights, size, x + 1, y - 1, halo);
                southWest = elevationAt(heights, size, x - 1, y + 1, halo);
                southEast = elevationAt(heights, size, x + 1, y + 1, halo);
            }
            // Horn's measured 3x3 neighbourhood suppresses quantization noise without
            // inventing edge samples. An unavailable derivative remains transparent.
            if (left === undefined || right === undefined || top === undefined || bottom === undefined || northWest === undefined || northEast === undefined || southWest === undefined || southEast === undefined)
                continue;
            const low = Math.min(centre, left, right, top, bottom, northWest, northEast, southWest, southEast), high = Math.max(centre, left, right, top, bottom, northWest, northEast, southWest, southEast);
            if (!Number.isFinite(low) || !Number.isFinite(high) || low < -12000 || high > 10000)
                throw new Error('Invalid relief elevation');
            const dx = (northEast + 2 * right + southEast - northWest - 2 * left - southWest) / (metres * 8), dy = (southWest + 2 * bottom + southEast - northWest - 2 * top - northEast) / (metres * 8);
            const xx = dx * dx, yy = dy * dy, slope = xx + yy;
            let illumination = flat;
            if (slope > 1e-12) {
                // Mark/GDAL multidirectional weights for dx=east and dy=south. Each
                // 225/270/315/360-degree light is clamped BEFORE aspect weighting;
                // averaging fixed light vectors would reduce this to one weak light.
                const diagonal = dx * dy, w225 = .5 * slope - diagonal, w315 = .5 * slope + diagonal;
                illumination = (w225 * Math.max(0, flat + (dx - dy) * .5) + xx * Math.max(0, flat + dx * flat) + w315 * Math.max(0, flat + (dx + dy) * .5) + yy * Math.max(0, flat + dy * flat)) / (2 * slope * Math.sqrt(1 + slope));
            }
            // A small, bounded cue from the local measured curvature separates
            // ridge crests and valley bottoms. It is exactly zero on a plane and
            // never changes heights, physical slopes, or the contour geometry.
            const curvature = (4 * centre - left - right - top - bottom) / (4 * metres);
            const delta = illumination - flat + Math.max(-.035, Math.min(.035, curvature * .35));
            if (delta === 0)
                continue;
            const pixel = at * 4, dark = delta < 0;
            pixels[pixel] = dark ? 45 : 255;
            pixels[pixel + 1] = dark ? 60 : 251;
            pixels[pixel + 2] = dark ? 54 : 231;
            pixels[pixel + 3] = Math.min(dark ? 148 : 108, Math.abs(delta) * (dark ? 300 : 360));
        }
    }
    return pixels;
}
