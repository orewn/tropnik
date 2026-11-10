# Source-derived map coverage

`build-map-coverage.py` produces the common geographic display contract for the
web, offline viewer and Android map. The checked-in output is
`web/public/data/map-coverage/manifest.json`, `base.coverage` and 567 detailed
cell files. The historical canonical/display GeoJSON files remain available to
older clients; the new renderers use this manifest instead.

## Why the previous coast looked angular

The former map mask simplified most of the administrative source by 0.008
degrees, and the administrative outline used a separate, coarser region
snapshot. The pinned source island of Gogland has 1,110 ring positions. The old
coverage reduced that ring to nine positions; the old region outline was a
three-corner polygon. Merely removing the outline or recoloring the mask would
leave the incorrect geographic shape in place.

The new generator uses the same 83 RUS features and the same two named UKR
features as the existing display. It retains the existing Lake Ladoga and Lake
Onega display inclusions. It makes no new territorial selection or legal
boundary claim. The historical administrative data can include coastal water;
this repair restores its detail and is not a new coastline survey.

## Reproduction

Use Python with `shapely==2.1.2` and `numpy==2.3.5`. Place the unmodified pinned
source downloads in an external source directory. The exact source URLs, commit,
SHA-256 hashes and feature counts are recorded in the manifest; the generator
rejects a different source hash before any spatial processing.

```sh
python tools/map-package/build-map-coverage.py --source-dir /path/to/pinned-sources
cd web
node --test tests/map-coverage-lod.test.mjs
```

The generator dissolves the source, works in the renderer's Mercator plane,
simplifies globally before clipping, and validates each serialized geometry.
Source boundary **lines** are clipped independently of administrative fill
polygons, so an artificial cell perimeter never becomes a green outline.
Existing route envelopes retain source detail even in the initial overview.

| View zoom | Level | Mercator tolerance |
| --- | --- | --- |
| ≤ 4 | overview | 1,712.189 m |
| > 4 through 8 | regional | 107.012 m |
| > 8 through 12 | local | 6.688 m |
| > 12 | source | No simplification |

Each simplified level uses a tolerance of 0.35 CSS pixels at its maximum zoom
with a 512-pixel world tile. The 256-pixel Canvas world has a smaller pixel
error. Coordinates retain seven decimal places. The source-level Gogland ring
retains all 1,110 original positions.

## Lossless transport

Files with extension `.coverage` contain UTF-8 JSON:

```json
{
  "type": "TropnikCoverage",
  "encoding": "indexed-delta-1e7-v1",
  "coverageVersion": "e0ce67282bfd3694",
  "lod": "source",
  "cell": "0109-312",
  "positions": [269410896, 600102304, 123, -46],
  "features": []
}
```

The illustrative position table stores alternating longitude/latitude integer
deltas at scale 10,000,000. Its accumulator starts at `[0,0]` once per file.
Each ordinary GeoJSON coordinate pair is replaced by a zero-based index into
that position table. Ring, polygon and line array nesting is unchanged. Features
retain IDs and properties, including `cell`, `role` and source `shapeName`.
Supported roles are `area`, `mask`, `territory`, and `territory-boundary`.
The shared web decoder is `/maps/map-coverage-lod.js`.

This encoding shares identical positions between roles without changing any
geometry. All 568 bundles total 114,710,697 bytes before HTTP compression, or
46,901,617 bytes with independent gzip level 6. The initial overview is
2,938,837 bytes raw / 901,717 gzip. The raw source level across the whole display
is 52,758,752 bytes; a viewport fetches only its selected cells.

The `.coverage` byte stream must be copied without JSON reformatting or URL
rewrites. Each descriptor includes exact byte length and SHA-256. The manifest
is ordinary JSON, allowing a deployment to prefix its resource URLs without
changing the files they identify. The generator version is a deterministic
16-character digest of its source/configuration contract, not a timestamp.

The coordinate domain is continuous around 105°E. Every cell lies on one side
of 180°. A canonical mask consumer shifts every longitude in a cell whose west
edge is at least 180° by −360; it must not wrap individual vertices of a ring.

## Runtime and verification

Each map owns a session. It starts with the overview, requests only buffered
viewport leaves, verifies transport integrity, and commits all four roles for
one generation together. It preserves the last complete geography on failure.
An AbortController plus a generation check prevents a late response from
restoring a previous viewport. Network concurrency is three, each cell is
bounded by 3 MiB, a viewport by 24 MiB/192 cells, and the in-memory cell cache
by 24 MiB. Fine detail is not part of service-worker installation warming.

Canvas replaces only changed cell layers. MapLibre updates public GeoJSON
sources and waits for their worker/render completion before declaring the
generation ready. Separate MapLibre sources can complete in different frames;
the session commit does not claim a GPU-atomic frame. Administrative outline
sources remain separate from polygon fills to avoid cell-edge artifacts.
Both label engines recheck admissions against the newly committed area; Canvas
also clears its label-layout cache before rerendering.

The map host exposes `data-map-coverage-version`, `-lod`, `-cells`, `-pending`,
`-error`, and `-ready`. `cells` is a sorted comma-separated ID list. Ready is
false during network work, incomplete generations and renderer application.
These are read-only diagnostics, not camera control APIs.

`tests/map-coverage-lod.test.mjs` verifies all shipped byte/hash receipts, exact
source-island detail, level transitions, source-cell budgets, cancellation,
stale responses, failed generations, overview restoration and render readiness.
The browser coast audit pans to actual source vertices near Primorsk
`[28.6069513, 60.3623846]` and Gogland `[26.9596752, 60.0633158]`, checks the
renderer's diagnostics/network evidence, and records both map engines across
the relevant zoom levels.
