# Scoped dependency compatibility patches

## `@vercel/og@1.0.3`

Vinext's original `@vercel/og@0.8.6` embeds Satori 0.16.0 in its distributed
JavaScript. A dependency-only Satori override does not replace that code.
The workspace therefore pins the actual consumer to 1.0.3, whose distributed
bundle contains Satori 0.33.5, including the fix for
[GHSA-wx4j-mvgx-mqwp](https://github.com/vercel/satori/security/advisories/GHSA-wx4j-mvgx-mqwp).

Version 1.0.3 also embeds HarfBuzz's CommonJS loader without shipping the
`hb.wasm` it expects beside the bundle. The narrow pnpm patch repairs loading:

- Node ESM loads the real HarfBuzz dependency through Satori's package boundary,
  so CommonJS resolves its own matching binary and Node built-ins normally.
- The edge entry imports the same HarfBuzz binary as a compiled Worker module
  and passes it through `instantiateWasm`. It skips the Node filesystem and
  browser-worker URL probes that are invalid in Cloudflare `nodejs_compat`.

`packageExtensions` declares `harfbuzzjs@0.10.0` at the edge import boundary;
this is the same version already used by Satori. The published binary is not
modified: 381,964 bytes, SHA-256
`d2ab975172d6103e7624e8f7f03fea2316eca6fe562e1b80fc7f7058b283a6d0`.
No global `require`, filesystem shim, network font fallback or disabled
supply-chain policy is introduced. The patch is content-addressed in the
committed lockfile and must apply during a frozen install. The modified entries
do not advertise unchanged upstream source maps with stale line mappings.

Compatibility gates render and inspect real PNG bytes with project Manrope
fonts. They also verify the installed renderer contains the patched Satori
implementation; a clean advisory report alone is insufficient. Keep both Node
and Worker checks when upgrading Vinext or this package. Remove this patch and
the package extension together only when the replacement release supplies a
patched renderer and both loading paths pass without it.
