# MapLibre 6.16.0: SwiftShader terrain textures

This is a maintained dependency patch for the exact MapLibre version in
`package.json`, applied by pnpm from `pnpm-workspace.yaml`. The lockfile records
its SHA-256. A dependency upgrade must review or remove this patch explicitly;
unused or unappliable patches must continue to fail installation.

## Rendering policy

The patch changes only the initial `Terrain.qualityFactor`: a public unmasked
renderer string containing the whole word `SwiftShader` selects 1; every other
renderer and an unavailable or failed renderer query retains the upstream 2.
Detection occurs once per Terrain construction, including reconstruction after
a context loss. There is no per-frame query, application access to SDK internals,
user-agent or CI detection, or global WebGL override.

For the existing DEM source tile size 512, the terrain coverage tile remains
1024. The draped render texture therefore becomes 1024 square on SwiftShader
instead of 2048 square. DEM data, tile coverage, the 128-square terrain mesh,
exaggeration, canvas density, depth buffers, anisotropy, style layers, symbols,
worker and CSS keep their existing paths. The reduced drape resolution can
change the sharpness of painted terrain features; native performance and visual
acceptance remain required.

The reason is recorded in `maplibre-gl@6.16.0.swiftshader-rtt.json`: public GPU
timer queries identified expensive hillshade draws into the 2048-square RTT.
Those bounded samples identify work, and do not estimate total action GPU time
or establish release acceptance.

## Reproduce the patch

Use the pinned pnpm 11.25.0 in an isolated checkout. The commands below use a
disposable directory outside `node_modules`; the generator refuses installed
dependency edits.

```sh
pnpm --dir web install --frozen-lockfile
pnpm --dir web patch maplibre-gl@6.16.0 --ignore-existing --edit-dir /tmp/tropnik-maplibre-original
node web/scripts/maplibre-terrain-patch.mjs apply /tmp/tropnik-maplibre-original
pnpm --dir web patch-commit /tmp/tropnik-maplibre-original --patches-dir patches
node web/scripts/maplibre-terrain-patch.mjs record web/node_modules/maplibre-gl
pnpm --dir web install --frozen-lockfile
node web/scripts/maplibre-terrain-patch.mjs check
```

Choose an unused edit directory. Offline installation is possible only when
both package contents and the configured supply-chain policy metadata are
cached; do not weaken the policy to compensate for missing metadata.

The generator checks the package version and complete upstream SHA-256 values
for all three files before changing them. It patches the readable source and
both distributed main bundles, retains the original licence text, and produces
a deterministic full-index git diff. Its reverse transform must recover the
exact pinned upstream bytes. `check` verifies that regenerating this diff gives
the registered patch byte for byte. The larger patch size comes from ordinary
git context around long minified bundle lines; executable changes remain small.

Only these dependency files are modified:

- `src/render/terrain.ts`
- `dist/maplibre-gl.mjs`
- `dist/maplibre-gl-dev.mjs`

The installed tarball lacks the upstream rolldown configuration, so this process
does not pretend to rebuild MapLibre from that tarball. It deterministically
changes the pinned shipped bundles alongside their corresponding source.

## Source maps and offline parity

The two changed bundles deliberately replace their `sourceMappingURL` comments
with an explicit note. Keeping those links would misattribute modified code to
the upstream maps. The upstream map files are not rewritten or advertised by
the patched bundles; workers and worker source maps remain untouched.

`record` synchronizes `public/maps/maplibre-gl.mjs` with the installed production
bundle. The offline viewer imports that checked-in file, while the interactive
application imports the npm package. Their complete bytes must match. The
existing full web build's `prepare-offline.mjs` also copies this same installed
bundle; no APK or offline geography regeneration is part of this patch.

Both the Pages build and the full web build verify installed source/bundles,
patch/provenance and offline parity before creating or changing any build output.
This prevents a Sites checkout with stale `node_modules` from overwriting the
patched offline bundle during preparation. The Pages build includes the
workspace configuration, generator and patch files in `build-info.inputs`, and
includes the verified dependency hashes in `dependencyPatches`. Source archives
include `web/patches`, and the Docker
dependency stage copies the patch and its workspace registration before its
frozen install.

To roll back, revert this patch's commit, including the lockfile, workspace
registration and public bundle, then install and rebuild normally. Do not retain
an unregistered modified dependency or a differently patched offline bundle.
