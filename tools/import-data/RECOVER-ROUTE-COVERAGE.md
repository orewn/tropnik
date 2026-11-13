# Recovering routes excluded by display simplification

The historical national import admitted routes against the simplified display
mask. Its route-detail envelopes covered only the original catalogue. The
separate recovery catalogue rechecks that report's
`not_wholly_inside_existing_display_coverage` candidates against the unchanged
full-resolution source. It never rewrites the national import's bytes, source
dates, or rejected-candidate report.

## Admission

`recover_route_coverage.py` uses the same 83 RUS and two named UKR ADM1 features,
the existing two inland-water inclusions, and the exact pinned hashes used by
the coverage builders. The whole original multipart line must be covered by
that source. Testing vertices alone is insufficient: a segment can cross a
source hole while both endpoints remain inside. Hiking/foot/walking type and
source identity checks remain in force.

Territory membership also uses those full-resolution polygons. Their IDs and
names must match the existing territory inventory exactly. Reusing the old
simplified territory polygons would independently lose some coastal routes
even after the country-mask admission was corrected. No nearest-territory
assignment, new territory selection, geometry buffer, clipped route, joined
gap, or invented coordinate is used.

## Acquisition and reproduction

Fresh Waymarked Trails replies are acquired separately with two concurrent
requests, a 35-second request timeout and a 12 MB response bound. Each reply
has its own retrieval time, source URL, byte count and SHA-256. Rerunning the
acquisition validates and resumes its cache; a complete successful acquisition
keeps its original ledger and completion time.

```sh
python tools/import-data/recover_route_coverage.py acquire --raw-root /tmp/tropnik-recovery
python tools/import-data/recover_route_coverage.py build --raw-root /tmp/tropnik-recovery --source-dir /tmp/tropnik-boundaries --download-missing
```

The committed `data/catalog/coverage-recovery/source-responses.tar.gz` contains
the new acquisition ledger and every retrieved reply with its sidecar,
including rejected candidates. It is deterministic and can reproduce the
catalogue without requesting route data again:

```sh
python tools/import-data/recover_route_coverage.py build --archive data/catalog/coverage-recovery/source-responses.tar.gz --source-dir /tmp/tropnik-boundaries --download-missing --check
python tools/import-data/test_route_coverage_recovery.py
python tools/map-package/test_route_catalog_inputs.py
```

Install the pinned Python dependencies from
`tools/map-package/requirements-territories.txt`. The optional boundary
download totals about 63 MB and is checked against the original pinned hashes
before admission. `--check` compares all generated catalogue, geometry, report,
acquisition and archive bytes. It does not modify the output catalogue or
contact Waymarked Trails. The source-download option only fills missing pinned
boundary files.

The report accounts for every original candidate exactly once and distinguishes
rejected whole-line coverage from retrieval errors. Fresh replies may differ
from the historical acquisition; their dates and hashes are not attributed to
the older import. OSM-derived data remains reference data under ODbL 1.0; this
recovery establishes neither field verification nor current access or
navigation readiness.

## Display output

Both coverage builders now discover all committed `data/catalog/**/routes.geojson`
collections, excluding raw acquisition directories. This includes future
supplements and the reviewed official-track collection. The protected envelope
contains original source land only: it cannot create land around a track.
The active `map-coverage` manifest records every input's bytes and SHA-256.
The historical legacy masks and their published receipts remain snapshots;
they are not regenerated as part of this recovery.
