# Selected cartographic territories

The generator creates **85 elements from the supplied cartographic snapshots**:
83 features in the existing `web/public/data/regions.geojson`, plus the named
`Autonomous Republic of Crimea` and `Sevastopol` features from the pinned raw UKR
source. This count is not a statement of the present official administrative
count. Original `shapeID`, `shapeName`, `shapeGroup`, and `shapeISO` when supplied
remain unchanged. Russian names are display translations.

## Rebuild and verify

From the project root:

```bash
python -m pip install -r tools/map-package/requirements-territories.txt
python tools/map-package/build-territories.py
python tools/map-package/build-territories.py --check
python -m unittest discover -s tools/map-package -p test_territories.py -v
```

The build is offline and refuses changed boundary input hashes. Outputs contain
no build timestamp. Their exact bytes, generator digest and geometry digest can
be verified with the pinned dependency versions. The Site build consumes the
committed outputs and does not require Python or Shapely at runtime.

## Outputs and coordinates

- `web/lib/territories.generated.json` contains the index, source hashes, route
  geometry inventory, normalized bounds, label centers, SVG silhouettes and
  matching source geometry URLs.
- `web/public/data/territories.geojson` contains all selected feature polygons.
  Each `feature.id`, `properties.id` and `properties.territoryId` is
  `territory-<original shapeID>`.

Longitude normalization exactly follows `russiaLongitude` in
`web/public/maps/russia-viewport.js`, including JavaScript half-tie rounding.
Eastern Chukotka lies beside the rest of the territory beyond 180° east; its
bounds are approximately 157.73–190.95°, rather than almost an entire world.
Canonical Chukotka components share a technical dateline edge after normalization.
The builder joins only those components and checks that their combined area is
unchanged. This is recorded as `datelineSeamJoined`.

Each SVG silhouette uses Web Mercator, topology-preserving simplification and an
individual fit into `0 0 100 100` with six units of padding. Proportions, polygon
components and holes are retained; render with `fill-rule="evenodd"`. The
unsimplified supplied polygons, rather than silhouettes, determine membership.
The geographic output is unwrapped renderer geometry, not canonical longitude
interchange GeoJSON. The RUS input itself is a historical overview simplification;
this processing does not recover missing coastal detail.

## Route membership and its limits

Every local GeoJSON in `web/public/data/routes` and `web/public/data/imported` is
inventoried with URL, byte size and SHA256. The current inventory has **280 source
geometry files**. This is separate from the active **277 route cards**; the UI
intersects these URL memberships with its active catalog. Extra source files do
not become published cards.

Shapely tests complete original line segments against the normalized supplied
polygons. It includes boundary contact and detects a segment crossing a polygon
even when both endpoints are outside. It excludes a line wholly inside a polygon
hole. Existing disjoint route segments are never joined; `regionId` and editorial
destination groups are not used to infer territory membership. A cross-territory
route may belong to more than one territory.

This geometric relationship establishes neither present access, route safety,
field verification, guide qualification nor legal jurisdiction. Source ISO
attributes for Crimea and Sevastopol remain `UKR`; no provenance is reassigned.

The regression checks cover all selected polygons and source attributes,
antimeridian continuity/area, true segment intersection and holes, actual local
URL hashes, outline component preservation, and byte-for-byte reproducibility.
