from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "web/components/Atlas.tsx",
    "const onRegionRef=useRef(onRegion),onTrailRef=useRef(onTrail),regionRef=useRef(region),trailRef=useRef(trail),viewportRef=useRef(onViewportRegion);",
    "const onRegionRef=useRef(onRegion),regionRef=useRef(region),trailRef=useRef(trail),viewportRef=useRef(onViewportRegion);",
)
replace_once(
    "web/components/Atlas.tsx",
    "onRegionRef.current=onRegion;onTrailRef.current=onTrail;regionRef.current=region;trailRef.current=trail;viewportRef.current=onViewportRegion;",
    "onRegionRef.current=onRegion;regionRef.current=region;trailRef.current=trail;viewportRef.current=onViewportRegion;",
)
replace_once(
    "web/components/Atlas.tsx",
    "requestAnimationFrame(()=>onTrailRef.current?.(t));",
    "requestAnimationFrame(()=>onTrail?.(t));",
)
replace_once(
    "web/components/Atlas.tsx",
    " },[visibleTrails,region?.id,loaded]);\n async function changeBase",
    " },[visibleTrails,region?.id,loaded,onTrail]);\n async function changeBase",
)

Path("scripts/fix-map-callback.py").unlink(missing_ok=True)
