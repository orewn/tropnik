# Bounded offline pilot map

`download_pilot.py` creates `data/pilot-map` from OpenFreeMap's public vector tiles and four Noto Sans Regular glyph blocks. It uses a pinned provider snapshot, a genuine identifying User-Agent, at most four parallel requests, and hard transfer/storage budgets below 50 MB. It refuses to overwrite an existing package or silently switch to a changed `latest` snapshot. It does not fetch a provider style or sprites.

The requested bounding box is `[40.29, 43.64, 40.49, 43.82]`, in WGS84 longitude/latitude. Zoom levels 7–14 require 193 XYZ tiles. Tile cells extend beyond the requested bounds; constrain the map viewport in the client. This pilot covers the Bzerpinsky area, not all of Russia. The vector package does not contain a DEM, weather or live closure feed. A separate terrain package is documented below.

Run from the project root with Python 3:

```sh
python tools/map-package/download_pilot.py
```

All stored `.pbf` files are raw, uncompressed protobuf. Serve them as `application/x-protobuf` without a gzip Content-Encoding header. The manifest records the downloaded source, hashes before and after any decompression, exact file sizes, source snapshot identifier, requested bounds, available zooms and completeness. Its own hash is intentionally excluded to avoid a circular checksum.

Local templates:

- `localtiles/{z}/{x}/{y}.pbf`
- `fonts/{fontstack}/{range}.pbf`, with `fontstack = Noto Sans Regular`
- Glyph ranges: `0-255`, `1024-1279`, `8192-8447`, `9472-9727`
- `route-11566519.geojson`: real OSM segments, not a verified navigation track

Keep visible map attribution to OpenMapTiles and OpenStreetMap contributors, preserve licence notices in the package, and expose the licence/source information in the application. OpenFreeMap attribution is additionally retained. The map data is ODbL, OpenMapTiles schema design is CC BY 4.0, and Noto Sans is SIL OFL 1.1. The provider licence notice also identifies upstream Natural Earth data as public domain. This package does not include Liberty or another provider design.

Policy checked on 2026-11-06:

- https://openfreemap.org/quick_start/
- https://openfreemap.org/tos/ — updated 2026-10-14
- https://github.com/hyperknot/openfreemap/blob/main/LICENSE.md
- https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md
- https://www.openstreetmap.org/copyright

The official terms permit offline downloads within 3,000 tiles or 50 MB with no more than four parallel requests and an identifying User-Agent. This tool applies both the tile and byte limits conservatively. No proxy rotation, identity spoofing, bypass or repeated blocked-request loop is used. Provider conditions must be checked again before future downloads.

## Terrain package

`download_terrain.py` builds `data/terrain-pilot` independently of the frozen vector manifest. The **published runtime package is `data/terrain-pilot/runtime/`**, copied from the explicit manifest file allowlist. Integrations should copy that directory, or copy exactly `manifest.files[]`; do not package the parent working directory. The completed runtime has 49 files, 21 DEM tiles and 2,309,198 bytes including its manifest. The tool requires Python 3, Pillow and NumPy. A completed package is never overwritten. A partial unsuccessful build can be replaced by the tool; future data refreshes should use a new version directory. The included reviewed source metadata and licence must accompany a rebuild.

```sh
python tools/map-package/download_terrain.py
```

The bounded package uses 21 tiles at zooms 7–12 for the same requested bounds. It downloads public Mapterhorn Terrarium WEBP512 with two parallel requests, a real identifying User-Agent and bounded byte limits. Mapterhorn explicitly documents limited-area downloads. The source is the global Copernicus GLO-30 surface model, selected from the provider's published source coverage; this endpoint does not expose per-pixel source IDs. The included full attribution catalogue preserves that limitation.

For Android size, each tile is decoded into scalar elevations, reduced from 512 to 256 pixels using a 2×2 mean at destination pixel centres, then encoded as Terrarium PNG. **Encoded RGB channels are never interpolated.** Zoom-12 ground sampling is approximately 27.6 metres here, comparable to the source's nominal 30-metre grid. The package does not include an extra tile halo; it covers the whole stated area and the full OSM relation 11566519. Clients must expose the area limit and should clamp the offline viewport to it.

The independent `terrain-grid.json` has exactly 129×129 height samples derived by bilinear interpolation from the original zoom-12 WEBP512 source. Its `bounds` are `[west,south,east,north]`; `elevations[row * width + column]` contains metres, rows run north to south and columns west to east. Sample coordinates are regular in longitude/latitude, with both bounds inclusive. `minElevation` and `maxElevation` describe this sampled grid, not all source pixels. Mesh sampling is approximately 126×157 metres, coarser than the raster DEM; it supports an actual relief mesh in a software fallback without claiming full raster resolution.

Runtime files:

- `tiles/{z}/{x}/{y}.png`: `encoding: terrarium`, `tileSize: 256`, zooms 7–12.
- `terrain-grid.json`: source-backed heights for the bounded mesh.
- `tilejson.json`: local tile metadata. Resolve its relative tile template against the hosted or asset root.
- `manifest.json`: tile source hashes, transformed file hashes, exact extents, sizes, processing and source metadata.
- `ATTRIBUTION.txt` and `sources/Copernicus-GLO30-LICENSE.pdf`: keep attribution, downstream obligations and the required liability notice accessible in the product.

The PNG and mesh data describe the earth's **surface**, including vegetation and structures where present. Copernicus reports TanDEM-X acquisition in 2011–2015 and some older infill data. Mapterhorn's catalogue lists source access in 2025. A November 2026 download is not a new survey. Encoding precision of 1/256 metre is not measurement accuracy. The model does not establish current snow, passability, obstacles, avalanche risk or field verification of a trail. No missing points are generated or filled by this pipeline.

MapLibre GL JS 6.16 can render a real terrain mesh from raster DEM; it requires WebGL2. MapLibre Native Android 13.7.1 supports raster DEM hillshade but does not implement the terrain mesh specification. A pitched hillshade map must be named accordingly; the separate numeric grid can support another actual 3D renderer.

Primary references checked on 2026-11-06:

- https://mapterhorn.com/data-access/ — public XYZ access and bounded offline extraction.
- https://mapterhorn.com/attribution/ and https://download.mapterhorn.com/attribution.json — source identities and licences.
- https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM — DSM, acquisition dates, GLO-30 specifications and required attribution.
- https://github.com/mapterhorn/mapterhorn/blob/main/source-catalog/glo30/LICENSE.pdf — redistribution/adaptation rights and downstream obligations, included verbatim in the package.
- https://maplibre.org/maplibre-gl-js/docs/examples/3d-terrain/
- https://maplibre.org/maplibre-gl-js/docs/guides/v5-to-v6-migration-guide/
- https://maplibre.org/maplibre-style-spec/terrain/

## Original outdoor pictograms

`build-sprites.py` reads the project's original 28×28 vector paths from `web/components/MapIcon.tsx` and renders them with Pillow. It does not download third-party artwork or create geographic features.

```sh
python tools/map-package/build-sprites.py
```

Generated files in `web/public/maps/`:

- `tropnik-sprite.png` and `.json`: 224×32 atlas, seven 32px logical markers, `pixelRatio: 1`.
- `tropnik-sprite@2x.png` and `.json`: 448×64 atlas, `pixelRatio: 2`.
- `tropnik-pictograms.js`: the same source paths and marker colors for the Canvas 2D renderer.
- `tropnik-sprite-provenance.json`: source path/hash and original project artwork declaration.

Exact sprite keys: **`camp`, `water`, `shelter`, `pass`, `peak`, `viewpoint`, `info`**. MapLibre's sprite URL is `/maps/tropnik-sprite`; it selects the density variant. These are RGBA, non-SDF icons with a cream rounded square and a 1.5px forest-colored stroke. The source paths and generated artwork follow the project's licence; no external pictogram licence is introduced.

`canvas-style.js` uses the same vectors through the installed Protomaps `LabelSymbolizer.place` contract. Include `tropnik-pictograms.js` whenever copying or precaching this module for offline use. Symbols are placed only at actual point features in `poi` and `mountain_peak`; normal label collision handling applies to icon and name together. OMT `saddle` maps to `pass`, while `peak`/`volcano` map to `peak`. Ridges and cliffs keep text labels. A generic hotel does not become a shelter; the water symbol does not independently verify potability, availability or public access.
