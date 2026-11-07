# Map visual system

## Palette

- Page background: `#F5F3EB`
- Surface: `#FFFEFA`
- Soft surface: `#EEF2E8`
- Primary forest: `#244D3C`
- Text: `#1D3026`
- Secondary text: `#59685D`
- Quiet border: `#D5DCCE`
- Functional border: `#738570`
- Route accent: `#A56736`

Normal cards and controls use one-pixel quiet borders. Two-pixel emphasis is reserved for keyboard focus and the selected object.

## Relief camera

The national view stays close to top-down. Pitch and elevation increase gradually with zoom so the country is not compressed into a narrow strip. Route framing is capped at 50 degrees.

## Attribution

The map shows OpenStreetMap/OpenMapTiles credit on the first display. It may collapse after five seconds or the first interaction, while a labelled info control remains in the map corner. Full notices remain at `/sources` and in the terrain attribution file. Natural Earth is public-domain data and is documented on the sources page rather than repeated over the map.

## Label boundaries

Map labels use an explicit safe rectangle rather than the browser's native `title` tooltip placement.

- Desktop safe area: 18 px from the left edge, 72 px below the top controls, 78 px before the right control rail, and 60 px above the bottom legend/credits.
- Compact safe area: 12 px from the left/bottom edge, 62 px below the top controls, and 58 px before the right controls.
- When the mobile route sheet overlaps the map, its top edge minus 12 px becomes the hard lower boundary.
- Direction labels prefer the side below their geographic point; route labels prefer the side above it. A label flips first, then receives the smallest required horizontal and vertical translation.
- The marker remains on the real geographic coordinate. Only its label may move.
- Browser-native marker tooltips are forbidden because the browser may position them outside the map. Accessible names remain on the buttons through `aria-label`.
- The map canvas clips overflow only as a final defence. A correctly placed label must already fit inside the safe rectangle.
