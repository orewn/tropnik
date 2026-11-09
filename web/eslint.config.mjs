import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    // Build products are regenerated from the source files linted below.
    "dist/**",
    ".next/**",
    "out/**",
    "build/**",
    ".stage/**",
    "pages-preview/dist/**",
    "pages-preview/.stage/**",
    ".vinext/**",
    ".wrangler/**",
    ".sites-runtime/**",
    "outputs/**",
    "work/**",
    // Vendored browser bundles copied by prepare-offline/create-map-style.
    // Keep our public/sw.js, offline.js and map/terrain helpers in the gate.
    "public/maps/leaflet.js",
    "public/maps/protomaps-leaflet.js",
    "public/maps/maplibre-gl.mjs",
    "public/maps/maplibre-worker.js",
  ]),
  {
    files: ["components/ui/button.tsx", "hooks/use-mobile.ts"],
    rules: {
      // These files are vendored verbatim from shadcn@4.17.0. Keep the
      // registry source intact while applying the stricter rules to Site code.
      "@typescript-eslint/no-unused-vars": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
