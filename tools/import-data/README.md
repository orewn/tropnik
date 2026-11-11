# Import real trail data

These scripts ingest OpenStreetMap data through two public distribution channels. Geofabrik and Waymarked Trails are not two independent field-verification databases: both derive their map data from OSM. No MAPS.ME proprietary database, commercial GPX library, photographs, profiles or ratings are copied.

## National supplement

The `national/` snapshot extends the original six-destination acquisition to every territory already present in the application's sourced display dataset. It does not rename the old acquisition, update its retrieval dates, change the territorial display source, or claim to enumerate every physical trail in Russia.

```sh
python tools/import-data/import_national_waymarked.py discover
python tools/import-data/import_national_waymarked.py collect
python tools/import-data/audit_national_catalog.py
python web/scripts/prepare-catalog.py
python -m unittest discover -s tools/import-data -p test_national_waymarked.py
```

`discover` makes an initial request for all 85 existing display territories. Bounds crossing 180° are split before conversion to the API's Mercator coordinates. A listing of 100 results is subdivided; depth and total-query limits are explicit, and any saturated leaf, request failure or unqueried subarea remains visible in `national/discovery.json`. These queries retrieve top-level relations indexed by Waymarked Trails, not every child relation or individual OSM path. A zero means no indexed candidate was returned by that snapshot, not that the area has no hiking paths.

`collect` skips the 278 original relation identities and fetches only new candidates, using two concurrent requests, a 35 second per-request timeout and a 12 MB response bound. Source responses are cached only with matching URL, byte length and SHA256. Reusing the cache preserves its original retrieval time. The acquisition is finite: 512 list requests, subdivision depth 6 and at most 4,000 new relation details. The report records any omitted work instead of silently claiming completeness.

New hiking, foot and walking relations are accepted only when their complete real member geometry is covered by the existing display polygon. A boundary-crossing or foreign route is neither clipped nor moved into the catalogue. Such exclusions are retained for separate editorial review; a rejection can also reflect the resolution of the selected display source. Original member segments remain separate, including gaps and branches. Conversion from source Mercator to WGS84 and rounding to seven decimal places are the only coordinate operations. A segment crossing the dateline requires explicit review rather than becoming a line across the world.

Every accepted route has exact geographic `territoryIds`. Existing tourism directions are reused where applicable; otherwise the primary ID is its existing `territory-*` identifier. No synthetic tourism destination or itinerary is created. Routes remain `reference`, not field verified or navigation ready. OSM segment length remains distinct from official itinerary distance, and no current access, difficulty, elevation profile, review or guided departure is invented.

The new repository files are `national/discovery.json`, `national/import-report.json`, `national/routes.json`, `national/routes.geojson` and individual `national/geometry/` files. The complete original responses and hash sidecars under the local `national/raw/` cache are delivered separately in a deterministic source archive, including successful responses for rejected foreign/border candidates. `national/source-archive.json` pins its filename, bytes, SHA256, internal manifest and exact inventory. It deliberately excludes the absent historical raw snapshot and does not claim to revalidate those old raw bytes.

```sh
python tools/import-data/package_national_sources.py /path/to/tropnik-national-route-sources-2026-11-11.tar.gz
python tools/import-data/audit_national_catalog.py --archive /path/to/tropnik-national-route-sources-2026-11-11.tar.gz
```

The archive audit first verifies the whole compressed artifact, then its manifest and every original file, and only extracts regular files under a new temporary directory. Absolute paths, traversal, links, duplicate entries and unexpected members are rejected. A local raw cache is not required for this form of verification.

`national/catalog-audit.json` checks every accepted geometry against the retained source members, counts every territory including zeroes, verifies raw hashes and confirms that no candidate disappeared from the accepted/rejected/error/limit accounting. It is a data-integrity audit, not a field safety certification. The web generator merges the supplement with the original catalogue and preserves on-demand individual geometry loading. The existing source, licence and ODbL attribution rules below apply to the supplement as well.

## Reproduce

Use Python 3 and install `requirements.txt` in the project's Python environment. Alternatively, install into this directory's optional `_deps/` directory for `import_geofabrik.py`; `_deps` is an execution dependency and need not be shipped in the source archive.

```sh
python -m pip install -r tools/import-data/requirements.txt
python tools/import-data/import_geofabrik.py
python tools/import-data/import_waymarked.py
```

Existing raw files are reused only after their hashes match their provenance records. For a deliberate refresh, create a new snapshot directory or remove the previous generated snapshot after retaining it as required. The scripts do not silently claim the old source was checked again. An identifying User-Agent is used; the WMT detail importer makes at most two concurrent requests. Failed requests are reported instead of changing identity or bypassing restrictions.

## Dataset types

| Field value | Meaning | What it does not establish |
|---|---|---|
| `raw_trail` | Original OSM way segment tagged `path`, selected `footway`, or `bridleway` | A complete hiking itinerary, public access, fitness for hiking, or a checked route |
| `route` | Original OSM hiking/foot/walking route relation and its existing member segments | Connectivity, current opening, official difficulty, permits, field validation, or a guided departure |
| `verified_route` | Reserved for the future verification workflow; the import creates none | It must never be assigned automatically because geometry downloaded successfully |

An official website can confirm a route's existence, published description or dated operating notice. Such evidence lives in a separate record with a precise scope and review date; it does not change `fieldVerified`, `geometryVerified` or `navigationReady` to true.

`recheckAfter` is the application's next review deadline, not an official guarantee of opening until that time. Once stale, show that a fresh check is needed while retaining the last known closure notice. Do not turn an expired closure into an open route or discard it simply because the review deadline passed. A new authoritative notice must resolve the affected section.

## Output

Everything is written under `data/catalog`:

- `raw/geofabrik/`: original regional PBF and its provenance, OSM replication timestamp and SHA256.
- `raw-trails-krym.geojson`: matching original path segments from the downloaded Crimea extract. It can include urban footpaths and access restrictions; it is a database layer, not a list of bookable hikes.
- `geofabrik-import-report.json`: exact filtering rules, type counts, invalid geometry and coverage.
- `raw/waymarked/`: original bounded area listings and relation detail JSON with source URL, date and hash sidecars.
- `routes.geojson`: deduplicated relation geometries for the six requested destinations.
- `routes.json`: route properties and paths to individual geometry files.
- `geometry/`: one FeatureCollection per relation, permitting small on-demand requests.
- `regions/`: regional relation collections; cross-region routes can occur in more than one region.
- `waymarked-import-report.json`: geographic query extents, API limits, rejections, errors, exact counts and all raw-source records.
- `verification-evidence.json`: 43 separately scoped records from managers, route operators and official tourism publishers, including descriptions, access rules, object statuses and dated notices. The `evidenceLevel` distinguishes them.
- `verification-coverage.json`: one research-state record for every imported relation, with actual query references, source URLs, identity limitations and a summary. Its CSV companion is a compact review matrix.
- `website-inspection.json`: read results for all 47 distinct supplied website URLs (fragments share one read). A working URL or text match is never automatically treated as verification.
- `raw/official/`: source metadata, hashes and retrieval times. Full third-party articles and photographs are not redistributed.
- `import-summary.json`: compact combined report of actual counts, scopes, errors and integration paths.
- `catalog-audit.json`: source-hash, record-count and verification-flag checks; not a field-safety certification.

`import_overpass_pilot.py` is an optional single small query near Avachinsky. In this acquisition, the public endpoint returned HTTP 502, so no extra Kamchatka ways were imported. This is preserved in `overpass-pilot-report.json`; no alternate endpoint, proxy or retry loop was used. The web application does not use the public Overpass service as a runtime backend.

WMT supplies coordinates in Web Mercator. They are converted to WGS84 and rounded to seven decimals. Member segments remain separate; no missing path is invented, no disconnected route is joined, and no elevation profile is generated. `geometryLengthKm` means the sum of the preserved segments, including branches, and must not be shown as an official itinerary distance. OSM classification tags remain source tags instead of becoming the application's checked difficulty label.

The destination filter uses the existing project boundary geometries. Altai combines the republic and krai. Baikal is a bounded tourism area intersected with Irkutsk/Buryatia. Crimea uses an explicitly declared geographic extent. Original relations are preserved in full if they intersect the selected area; they can extend outside it. The importer documents the provider's original dataset name as provenance, without interpreting it as a statement about sovereignty.

## Publication and data rights

Display `© OpenStreetMap contributors`, link to https://www.openstreetmap.org/copyright and preserve the ODbL notice. The imported datasets remain subject to ODbL, including applicable attribution and share-alike obligations when an adapted database is publicly used or redistributed. Product profiles, private communications and commercial booking records are not supplied by OSM and should not be mixed into the licensed geometry files.

All imported items start with `publicationStatus: reference`, unknown current conditions and difficulty, `fieldVerified: false`, and `navigationReady: false`. Search indexing, guided departures and a verification badge require the relevant editorial/operating workflow. A verified online notice should be displayed with its scope and date, not as a universal promise that every route fact is verified.

Primary sources checked 2026-11-06:

- https://download.geofabrik.de/russia.html
- https://download.geofabrik.de/russia/crimean-fed-district.html
- https://hiking.waymarkedtrails.org/
- https://github.com/waymarkedtrails/waymarkedtrails-api
- https://www.openstreetmap.org/copyright
- https://opendatacommons.org/licenses/odbl/1-0/
- https://docs.osmcode.org/pyosmium/latest/

No completeness claim is made for physical trails in Russia. The raw-way layer currently covers the downloaded Crimea extract; the route-relation catalog covers bounded queries in six tourism destinations. The reports distinguish those scopes and disclose finite request limits.

## Online review snapshot: 6 November 2026

The 278-relation matrix records 48 actual web search queries and a read attempt for every supplied website. Some searches used grouped names; these are discovery attempts, not exhaustive investigations. All 161 named records received at least a bounded attempt, together with one numbered record that supplied a website. Another 93 number/code-only records and 23 unnamed records still need an identifiable route name or responsible operator before individual verification.

The result is 40 direct descriptions from a manager/operator/official tourism publisher; 20 related primary sources without established equivalence to the full imported route; 9 trail-publisher descriptions; 5 network/project references; one related publisher description; one secondary source; and 86 attempts without authoritative confirmation. The latter status does not prove a route does not exist. There are zero field-verified, geometry-verified or navigation-ready routes.

The review found current page labels and older notices that must remain narrowly scoped:

- Nine reviewed Krasnaya Polyana route headers showed `Закрыта` on direct retrieval. Search-index copies sometimes showed an older open label. The page has no publication date, so display the reading date and `operatingLabel`, not an invented date of closure.
- Agura and Orlinye Skaly are described by the national park as closed **as ecological trails**, while the surrounding territory is listed separately as visitable. Do not turn this distinction into an unconditional open route.
- The Big Akhun tower is marked closed as an object; this is not a finding about every approach path.
- The 28 May 2026 notice for the Dragon's Mouth remains a known historical closure; a fresh reopening was not established by this bounded search.
- Five routes on the Yalta reserve manager's page require an instructor-guide under the manager's corresponding contract. A general guide profile, online description or downloadable geometry does not satisfy that requirement.
- On route 8A, the 26 October 2026 notice limits access from 27 October to Bzerpinsky ledge and closes Kholodny camp. The complete source geometry must never visually imply that the closed extension is permitted.

`sourcePublishedAt` may legitimately be null. `checkedAt` is the source-reading timestamp, `retrievedAt` in `routes.json` is only the OSM-data download time, and `recheckAfter` is an internal review deadline. Render these meanings separately. A primary source can describe a landmark or section without establishing the whole route; respect `verificationScope` and `displayScope`.

`build_verification_matrix.py` reproduces the matrix from the explicit human-reviewed snapshot and cached source metadata. It does not conduct a new web search or renew a human verification date. A later refresh requires actual source review and an updated decision snapshot; it must not be simulated by rerunning the script.
