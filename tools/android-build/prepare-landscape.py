#!/usr/bin/env python3
"""Build the native offline DEM + self-contained scene from reviewed inputs.

No downloads, no npm install, no timestamps from the build host. The runtime
manifest is the only terrain allowlist; unrelated working files never enter an
APK. Run again after changes to the shared web terrain renderer.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html
import importlib.util
import json
import re
from pathlib import Path

from asset_integrity import digest, require, safe_relative, verify_landscape, verify_terrain
from display_scope import NATIVE_SCOPE_FILES, PROVENANCE_FILE, restrict_style, verify_display_scope
from russia_relief import OVERVIEW_SIDECARS, add_overview_sources, add_overview_style, verify_overview
from online_sources import add_online_style, add_online_source_text
from map_coverage import native_package, add_coverage_style, verify_coverage


ROOT = Path(__file__).resolve().parents[2]
TOOLS = Path(__file__).resolve().parent


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def inline_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def csp_hash(text: str) -> str:
    return "'sha256-" + base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode("ascii") + "'"


def read_local(root: Path, relative: str) -> bytes:
    path = root / safe_relative(relative)
    require(not path.is_symlink() and path.resolve().is_relative_to(root.resolve()), "Symlinked package asset")
    return path.read_bytes()


def font_css(fonts: Path) -> tuple[str, dict[str, bytes]]:
    css = []
    inputs = {}
    ranges = {"latin": "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
              "cyrillic": "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116"}
    for weight in (400, 600):
        for subset in ("latin", "cyrillic"):
            name = f"manrope-{subset}-{weight}-normal.woff2"
            data = read_local(fonts, name)
            require(data[:4] == b"wOF2", "Invalid local font")
            inputs[name] = data
            encoded = base64.b64encode(data).decode("ascii")
            css.append("@font-face{font-family:Manrope;font-style:normal;font-weight:" + str(weight)
                       + ";font-display:swap;src:url(data:font/woff2;base64," + encoded
                       + ") format('woff2');unicode-range:" + ranges[subset] + "}")
    return "\n".join(css), inputs


def verified_scene_grid(root: Path) -> tuple[bytes, dict]:
    """Recompute the derivative from the frozen archive before embedding it.

    A saved JSON verification report is evidence, not a trusted input. The
    read-only refinement API compares the actual dense bytes with a clean
    reconstruction and verifies every input tile against its source manifest.
    """
    script = root / "tools/map-package/refine_terrain.py"
    spec = importlib.util.spec_from_file_location("tropnik_refine_terrain", script)
    require(spec is not None and spec.loader is not None, "Terrain verifier is missing")
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    proof = verifier.verify(root)
    require(proof.get("status") == "passed" and proof.get("checkOnly") is True
            and proof.get("archiveUnchanged") is True, "Dense terrain was not verified")
    record = next(item for item in proof["outputs"] if item["path"] == "web/public/terrain/terrain-grid.json")
    data = read_local(root, record["path"])
    require(len(data) == record["sizeBytes"] and digest(data) == record["sha256"], "Dense grid changed during packaging")
    return data, {"inputManifest": proof["inputManifest"], "output": record,
                  "sampleSpacingApproxM": proof["sampleSpacingApproxM"],
                  "inputTilesVerified": proof["inputTilesVerified"],
                  "verifier": "tools/map-package/refine_terrain.py --check",
                  "verifierSha256": digest(script.read_bytes())}


def make_scene(runtime: Path, renderer_path: Path, route_path: Path, *,
               grid_bytes: bytes, grid_provenance: dict) -> tuple[dict[str, bytes], dict]:
    terrain_manifest_bytes = read_local(runtime, "manifest.json")
    actual = [str(path.relative_to(runtime)) for path in runtime.rglob("*") if path.is_file()]
    terrain_report = verify_terrain(terrain_manifest_bytes, lambda p: read_local(runtime, p), actual_files=actual)
    terrain_manifest = json.loads(terrain_manifest_bytes)
    require(grid_provenance["inputManifest"]["sha256"] == digest(terrain_manifest_bytes),
            "Dense grid belongs to another terrain archive")
    require(grid_provenance["output"]["sha256"] == digest(grid_bytes)
            and grid_provenance["output"]["sizeBytes"] == len(grid_bytes), "Dense grid differs from its proof")
    grid = json.loads(grid_bytes)
    require(grid.get("bounds") == terrain_manifest["bounds"]
            and grid.get("processing", {}).get("inputManifestSha256") == digest(terrain_manifest_bytes),
            "Dense grid provenance does not match native relief")
    route_bytes = route_path.read_bytes()
    route = json.loads(route_bytes)
    require(route.get("type") in {"FeatureCollection", "Feature", "MultiLineString", "LineString"}, "Unsupported route geometry")
    renderer_bytes = renderer_path.read_bytes()
    renderer = renderer_bytes.decode("utf-8")
    # The shared renderer is intentionally one dependency-free module. Reject a
    # changed contract instead of silently emitting a broken offline scene.
    require(re.search(r"\b(?:import\s|import\s*\(|require\s*\(|fetch\s*\(|XMLHttpRequest\b|WebSocket\b|EventSource\b)", renderer) is None,
            "Shared terrain renderer must not depend on modules or network resources")
    renderer = re.sub(r"\bexport\s+(?=(?:async\s+function|class|function|const|let|var)\s)", "", renderer)
    renderer = re.sub(r"\bexport\s*\{\s*TerrainRenderer\s*\}\s*;?", "", renderer)
    require(re.search(r"\bexport\s", renderer) is None and "class TerrainRenderer" in renderer,
            "Unknown terrain renderer module contract")
    renderer = renderer.replace("</script", "<\\/script")
    fonts, font_inputs = font_css(TOOLS / "fonts")
    css = (TOOLS / "landscape.css").read_text().replace("__FONT_CSS__", fonts)
    guard = """(function(){
const status=document.getElementById('scene-status');
function fail(message){document.documentElement.dataset.sceneState='failed';if(status){status.hidden=false;status.textContent=message;}window.dispatchEvent(new Event('tropnik-scene-fatal'));}
window.addEventListener('error',function(){fail('Рельеф не открылся. Попробуйте ещё раз.');});
window.addEventListener('unhandledrejection',function(){fail('Не удалось открыть рельеф. Сохранённая карта остаётся доступной.');});
})();"""
    bootstrap = """
(function(){
const canvas=document.getElementById('terrain-canvas');
const status=document.getElementById('scene-status');
const terrainGrid=__GRID__;
let renderer=null,active=false,disposed=false,terminal=false,layoutObserver=null,preparation=null;
document.documentElement.dataset.sceneState='loading';
function failure(){status.hidden=false;status.textContent='Не удалось открыть рельеф. Попробуйте снова или вернитесь к сохранённой карте.';}
function viewportReady(){
 const height=window.innerHeight;
 return height>0&&[document.documentElement,document.body,canvas].every(function(node){
  return node&&Math.abs(node.getBoundingClientRect().height-height)<=2;
 });
}
function terminalFailure(message){
 if(disposed||terminal)return;terminal=true;active=false;
 if(preparation)preparation.abort();if(renderer){renderer.destroy();renderer=null;}
 if(layoutObserver){layoutObserver.disconnect();layoutObserver=null;}window.removeEventListener('resize',fitLabels);
 document.documentElement.dataset.sceneState='failed';failure(message);
}
function fitLabels(){
 if(!renderer||typeof renderer.setViewportInsets!=='function')return;
 const rect=document.getElementById('terrain-canvas').getBoundingClientRect(),heading=document.querySelector('.heading').getBoundingClientRect();
 const summary=document.querySelector('.information summary').getBoundingClientRect(),compact=rect.height<400;
 renderer.setViewportInsets({left:16,right:compact?16:80,
  top:Math.min(rect.height*.32,Math.max(16,heading.bottom-rect.top+12)),
  bottom:Math.min(rect.height*.32,summary.height+(compact?12:40)+12)});
}
window.addEventListener('tropnik-scene-resume',function(){if(terminal)return;active=true;if(renderer)renderer.setVisible(true);else start();});
window.addEventListener('tropnik-scene-pause',function(){active=false;if(preparation)preparation.abort();if(renderer)renderer.setVisible(false);});
window.addEventListener('tropnik-scene-fatal',function(){terminalFailure('Рельеф закрылся. Откройте его снова.');});
window.addEventListener('pagehide',function(){disposed=true;if(preparation)preparation.abort();if(layoutObserver)layoutObserver.disconnect();window.removeEventListener('resize',fitLabels);if(renderer)renderer.destroy();},{once:true});
async function start(){
 if(disposed||terminal||!active||renderer||preparation)return;
 const controller=new AbortController();preparation=controller;
 try{
 const preparedModel=await createTerrainModelAsync(terrainGrid,{signal:controller.signal});
 if(disposed||!active||controller.signal.aborted)return;
 renderer=new TerrainRenderer(canvas,terrainGrid,{preparedModel,compactViewport:false,onRender:function(){
  if(disposed||terminal)return;
  if(!viewportReady()){status.hidden=false;document.documentElement.dataset.sceneState='loading';return;}
  status.hidden=true;document.documentElement.dataset.sceneState='ready';
  if(!active&&renderer)renderer.setVisible(false);
 },onError:failure,onFatal:terminalFailure});
 renderer.setGeometry(__ROUTE__);
 fitLabels();
 renderer.setVisible(active);renderer.warmup();
 if(typeof ResizeObserver!=='undefined'){layoutObserver=new ResizeObserver(fitLabels);layoutObserver.observe(document.querySelector('.landscape'));}
 window.addEventListener('resize',fitLabels);
 if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fitLabels);
 document.getElementById('zoom-in').addEventListener('click',function(){renderer?.zoomBy(1.2);});
 document.getElementById('zoom-out').addEventListener('click',function(){renderer?.zoomBy(1/1.2);});
 document.getElementById('reset').addEventListener('click',function(){renderer?.reset();});
 }catch(error){if(!disposed&&!controller.signal.aborted)terminalFailure();}
 finally{if(preparation===controller)preparation=null;if(!disposed&&active&&!renderer&&controller.signal.aborted)start();}
}
})();
""".replace("__GRID__", inline_json(grid)).replace("__ROUTE__", inline_json(route))
    script = renderer + "\n" + bootstrap
    policy = ("default-src 'none'; script-src " + csp_hash(guard) + " " + csp_hash(script)
              + "; style-src " + csp_hash(css) + "; font-src data:; img-src data:; connect-src 'none'; "
                "base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'")
    shell = (TOOLS / "landscape-shell.html").read_text()
    substitutions = {"__POLICY__": html.escape(policy, quote=True), "__STYLE__": css,
                     "__GUARD__": guard, "__SCRIPT__": script,
                     "__SOURCE_NAME__": html.escape(terrain_manifest["source"]["name"]),
                     "__ATTRIBUTION__": html.escape(terrain_manifest["attribution"]),
                     "__LIABILITY__": html.escape(terrain_manifest["liabilityNotice"])}
    for token, value in substitutions.items():
        shell = shell.replace(token, value)
    document = shell.encode("utf-8")
    manifest = {"schemaVersion": 1, "complete": True, "id": "tropnik-bzerpinsky-landscape-v5-recovery",
                "offline": True, "bounds": terrain_manifest["bounds"],
                "terrainManifestSha256": digest(terrain_manifest_bytes),
                "rendererSha256": digest(renderer_bytes), "gridSha256": digest(grid_bytes),
                "embeddedGridSha256": digest(inline_json(grid).encode("utf-8")),
                "gridDimensions": [grid["width"], grid["height"]], "gridProvenance": grid_provenance,
                "routeSha256": digest(route_bytes),
                "fontInputs": {name: digest(data) for name, data in sorted(font_inputs.items())},
                "files": [{"path": "landscape.html", "sizeBytes": len(document), "sha256": digest(document)}]}
    files = {"landscape.html": document, "manifest.json": json_bytes(manifest)}
    # CSP attribute uses HTML entities; the parser/verifier decodes them.
    report = verify_landscape(files["manifest.json"], files.__getitem__, terrain_manifest_bytes)
    return files, {**terrain_report, **report}


def update_style(style: dict, manifest: dict, manifest_bytes: bytes) -> dict:
    style["sources"]["pilot-dem"] = {
        "type": "raster-dem", "tiles": ["asset://maps/terrain-pilot/tiles/{z}/{x}/{y}.png"],
        "tileSize": manifest["tileSize"], "encoding": manifest["encoding"],
        "minzoom": manifest["minzoom"], "maxzoom": manifest["maxzoom"],
        "bounds": manifest["bounds"], "attribution": manifest["attribution"],
    }
    existing = next((layer for layer in style["layers"] if layer["id"] == "pilot-hillshade"), {})
    paint = dict(existing.get("paint", {}))
    paint["hillshade-illumination-anchor"] = "viewport"
    for name, value in {"hillshade-method": "igor", "hillshade-illumination-direction": 335,
                        "hillshade-exaggeration": 0.48, "hillshade-shadow-color": "#344C3E",
                        "hillshade-highlight-color": "#FFFEF5", "hillshade-accent-color": "#4B5C44"}.items():
        paint.setdefault(name, value)
    layers = [layer for layer in style["layers"] if layer["id"] != "pilot-hillshade"]
    before = next((i for i, layer in enumerate(layers) if layer["id"] == "water"), len(layers))
    layers.insert(before, {"id": "pilot-hillshade", "type": "hillshade", "source": "pilot-dem", "minzoom": 7,
                          "paint": paint})
    style["layers"] = layers
    style.setdefault("metadata", {})["tropnik:terrainManifestSha256"] = digest(manifest_bytes)
    return style


def write_or_check(path: Path, data: bytes, check: bool) -> None:
    if path.exists() and path.read_bytes() == data:
        return
    require(not check, "Generated Android asset is stale or missing: " + str(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tropnik-tmp")
    temporary.write_bytes(data)
    temporary.replace(path)


def prepare(root: Path = ROOT, *, check: bool = False) -> dict:
    runtime = root / "data/terrain-pilot/runtime"
    assets = root / "android/app/src/main/assets"
    grid_bytes, grid_provenance = verified_scene_grid(root)
    files, report = make_scene(runtime, root / "web/public/terrain/terrain-renderer.js",
                               assets / "maps/routes/route-11566519.geojson",
                               grid_bytes=grid_bytes, grid_provenance=grid_provenance)
    manifest_bytes = read_local(runtime, "manifest.json")
    manifest = json.loads(manifest_bytes)
    # Validate all inputs before changing any generated source asset.
    copies = {entry["path"]: read_local(runtime, entry["path"]) for entry in manifest["files"]}
    copies["manifest.json"] = manifest_bytes
    style = update_style(json.loads((assets / "maps/style.json").read_text()), manifest, manifest_bytes)
    scope_root = root / "web/public/data"
    scope_provenance = read_local(scope_root, PROVENANCE_FILE)
    scope_report = verify_display_scope(scope_provenance, lambda p: read_local(scope_root, p))
    overview_root = root / "web/public/maps/russia-relief"
    overview_manifest = read_local(overview_root, "manifest.json")
    overview_records = json.loads(overview_manifest)["files"]
    overview_report = verify_overview(overview_manifest, lambda p: read_local(overview_root, p),
        actual_files=[str(path.relative_to(overview_root)) for path in overview_root.rglob("*") if path.is_file()],
        provenance_bytes=scope_provenance)
    overview_copies = {entry["path"]: read_local(overview_root, entry["path"]) for entry in overview_records}
    overview_copies.update({name: read_local(overview_root, name) for name in OVERVIEW_SIDECARS})
    style = add_overview_style(style, overview_manifest)
    style, online_manifest = add_online_style(style,
        read_local(root / "web/public/maps", "tropa-style.json"),
        read_local(TOOLS / "sources", "openfreemap-tilejson.json"),
        read_local(runtime / "sources", "mapterhorn-tilejson.json"))
    style = restrict_style(style, scope_provenance)
    coverage_root = root / "web/public/data/map-coverage"
    coverage_files = native_package(read_local(coverage_root, "manifest.json"), lambda p: read_local(coverage_root, p))
    style = add_coverage_style(style, coverage_files["manifest.json"])
    coverage_report = verify_coverage(coverage_files["manifest.json"], coverage_files.__getitem__, actual_files=coverage_files, style=style)
    source_text = add_overview_sources(read_local(assets, "SOURCES.txt"), overview_manifest, overview_copies["ATTRIBUTION.txt"])
    source_text = add_online_source_text(source_text)
    verify_overview(overview_manifest, overview_copies.__getitem__, style=style, provenance_bytes=scope_provenance)
    for relative, data in sorted(copies.items()):
        write_or_check(assets / "maps/terrain-pilot" / relative, data, check)
    for relative, data in sorted(files.items()):
        write_or_check(assets / "landscape" / relative, data, check)
    for relative in (*NATIVE_SCOPE_FILES, PROVENANCE_FILE):
        write_or_check(assets / "maps/russia" / relative, read_local(scope_root, relative), check)
    for relative, data in sorted(overview_copies.items()):
        write_or_check(assets / "maps/russia-relief" / relative, data, check)
    for relative, data in sorted(coverage_files.items()):
        write_or_check(assets / "maps/coverage" / relative, data, check)
    write_or_check(assets / "maps/style.json", json_bytes(style), check)
    write_or_check(assets / "maps/online-sources.json", online_manifest, check)
    write_or_check(assets / "SOURCES.txt", source_text, check)
    # Preserve the existing full native TTF licence; the scene's supplied
    # webfont subset licence is a separate bundled file.
    write_or_check(assets / "licenses/Manrope-Scene-OFL.txt", (TOOLS / "fonts/OFL.txt").read_bytes(), check)
    # A stale file is rejected, never silently swept into the APK.
    installed = assets / "maps/terrain-pilot"
    verify_terrain(manifest_bytes, lambda p: read_local(installed, p),
                   actual_files=[str(path.relative_to(installed)) for path in installed.rglob("*") if path.is_file()])
    verify_display_scope(scope_provenance, lambda p: read_local(assets / "maps/russia", p), style)
    installed_overview = assets / "maps/russia-relief"
    verify_overview(overview_manifest, lambda p: read_local(installed_overview, p), style=style,
        actual_files=[str(path.relative_to(installed_overview)) for path in installed_overview.rglob("*") if path.is_file()],
        provenance_bytes=scope_provenance)
    installed_coverage = assets / "maps/coverage"
    verify_coverage(coverage_files["manifest.json"], lambda p: read_local(installed_coverage, p), style=style,
        actual_files=[str(path.relative_to(installed_coverage)) for path in installed_coverage.rglob("*") if path.is_file()])
    return {"checkOnly": check, **report, **scope_report, **overview_report, **coverage_report, "russiaMaskConfigured": True}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--check", action="store_true", help="Fail if assets differ; do not write")
    args = parser.parse_args()
    print(json.dumps(prepare(args.root.resolve(), check=args.check), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
