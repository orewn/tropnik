# Region trail counts and zoom labels

## Reported problem

Selecting a region reduced `visibleTrails` to that region and its active filters.
The map reused this subset to count every destination, producing false zeros for
Altai, Baikal and Krasnoyarsk. Standalone counts also disappeared above zoom 5.

## Change

- Explore supplies its full merged reference and published catalogue separately
  from the filtered routes shown as lines and points.
- Destination totals are memoized from the complete catalogue. Shared memberships
  retain the existing per-destination deduplication rules.
- A single nameplate contains the destination name and a badge with an explicit
  trail unit: `11 троп`, `1 тропа`, `2 тропы`, or a truthful `0 троп`.
- A group keeps `N направлений`. Its member count is not shown as a trail count.
- The name and trail count remain together at every settled zoom where the
  geographic anchor is in view. Collision placement measures the complete card.
- Native button identity, SVG artwork, keyboard focus, geographic anchors and
  the shared wheel-input surface are preserved.
- Shared generated web/native runtime files and the offline checksum registry
  are regenerated. This change does not claim a new APK release.

Bundled catalogue: 685 records; Altai 11, Baikal 13, Krasnoyarsk 47.
These are catalogue records, not a claim of field-verified access or geometry.

## Local verification

| Check | Result |
| --- | --- |
| Web unit and lifecycle regression suite | 987 passed, 0 failed |
| Pages unit and receipt-contract suite | 403 passed, 0 failed |
| Static client TypeScript | Passed |
| Static build and HTTP verification | Passed; 77 HTTP checks |
| Shared runtime generation and source integrity | Passed |
| Independent count-data and input/collision review | Completed |

Lifecycle regressions cover selection, empty filters, zoom 14, shared region
membership, a catalogue update and a genuinely empty region. Browser receipt
contracts require actual mouse/touch selection through the label and inline
count, retained wheel ownership and a count contained within its nameplate.

Local Chromium could not launch because the execution environment disallows its
singleton socket. The separate browser could not reach the local preview port.
Neither attempt is counted as visual verification. The existing Pages workflow
must run the real browser gates before production deployment; its run and live
source identity are the publication evidence.
