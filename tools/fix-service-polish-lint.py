from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(relative: str, old: str, new: str) -> None:
    path = ROOT / relative
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{relative}: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1))


# Explore: keyed pagination removes reset effects; online state is initialized lazily.
replace_once(
    "web/components/Explore.tsx",
    " const [limit,setLimit]=useState(12);\n useEffect(()=>setLimit(12),[region?.id,deferredQuery,difficulty,duration,onlySaved]);",
    """ const listKey=`${region?.id||'all'}:${deferredQuery}:${difficulty}:${duration}:${onlySaved}`;
 const [page,setPage]=useState({key:'',limit:12});
 const limit=page.key===listKey?page.limit:12;""",
)
replace_once(
    "web/components/Explore.tsx",
    "[offline,setOffline]=useState(false)",
    "[offline,setOffline]=useState(()=>typeof navigator!=='undefined'&&!navigator.onLine)",
)
replace_once(
    "web/components/Explore.tsx",
    "useEffect(()=>{packs().then(setSaved).catch(()=>{});setOffline(!navigator.onLine);const sync=()=>setOffline(!navigator.onLine);",
    "useEffect(()=>{packs().then(setSaved).catch(()=>{});const sync=()=>setOffline(!navigator.onLine);",
)
replace_once(
    "web/components/Explore.tsx",
    "useEffect(()=>{if(!trail?.id)return;const current=catalogById.get(trail.id);if(current&&current!==trail)setTrail(current);},[catalogById,trail?.id]);",
    "useEffect(()=>{if(!trail?.id)return;const current=catalogById.get(trail.id);if(current&&current!==trail)queueMicrotask(()=>setTrail(previous=>previous?.id===current.id?current:previous));},[catalogById,trail]);",
)
replace_once(
    "web/components/Explore.tsx",
    "onClick={()=>setLimit(value=>value+12)}",
    "onClick={()=>setPage({key:listKey,limit:limit+12})}",
)

# Territory browser: pagination resets by key instead of a synchronous effect.
replace_once(
    "web/components/TerritoryBrowser.tsx",
    "  const [limit, setLimit] = useState(18);",
    "  const [page, setPage] = useState({key: '', limit: 18});",
)
replace_once(
    "web/components/TerritoryBrowser.tsx",
    """  ])), [catalog]);
  useEffect(() => setLimit(18), [mode, normalized]);
  return <>""",
    """  ])), [catalog]);
  const pageKey = `${mode}:${normalized}`;
  const limit = page.key === pageKey ? page.limit : 18;
  return <>""",
)
replace_once(
    "web/components/TerritoryBrowser.tsx",
    "onClick={() => setLimit(value => value + 18)}",
    "onClick={() => setPage({key: pageKey, limit: limit + 18})}",
)

# Stories: state changes from effects happen in a callback; photo failures are already keyed by story id.
replace_once(
    "web/components/PlaceStories.tsx",
    "useEffect(()=>{if(routeId)setDismissed(true);},[routeId]);",
    "useEffect(()=>{if(routeId)queueMicrotask(()=>setDismissed(true));},[routeId]);",
)
replace_once(
    "web/components/PlaceStories.tsx",
    "  setFailedPhoto(current=>current===fact.id?'':current);\n",
    "",
)
replace_once(
    "web/components/PlaceStories.tsx",
    " },[fact?.id,facts,index]);",
    " },[fact,facts,index]);",
)

# Safety form: saved baseline is render state, not a ref read during render.
replace_once(
    "web/components/SafetyRegistration.tsx",
    "import {useEffect, useMemo, useRef, useState} from 'react';",
    "import {useEffect, useMemo, useState} from 'react';",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    "  const savedSnapshot = useRef(passportSnapshot(passport));",
    "  const [savedSnapshot, setSavedSnapshot] = useState(() => passportSnapshot(passport));",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    "passportSnapshot(passport) !== savedSnapshot.current",
    "passportSnapshot(passport) !== savedSnapshot",
)
path = ROOT / "web/components/SafetyRegistration.tsx"
text = path.read_text()
count = text.count("savedSnapshot.current = passportSnapshot(")
if count != 6:
    raise SystemExit(f"SafetyRegistration.tsx: expected six snapshot assignments, found {count}")
text = text.replace("savedSnapshot.current = passportSnapshot(", "setSavedSnapshot(passportSnapshot(")
# Convert assignment closing semicolons into setter call closings for all known forms.
for old, new in [
    ("setSavedSnapshot(passportSnapshot(existing);", "setSavedSnapshot(passportSnapshot(existing));"),
    ("setSavedSnapshot(passportSnapshot(value);", "setSavedSnapshot(passportSnapshot(value));"),
    ("setSavedSnapshot(passportSnapshot(next);", "setSavedSnapshot(passportSnapshot(next));"),
    ("setSavedSnapshot(passportSnapshot(item);", "setSavedSnapshot(passportSnapshot(item));"),
]:
    text = text.replace(old, new)
path.write_text(text)

# Use the framework link for root navigation while retaining ordinary anchors elsewhere.
replace_once(
    "web/components/Header.tsx",
    "import {useState, useEffect, useCallback, useRef} from 'react';",
    "import Link from 'next/link';\nimport {useState, useEffect, useCallback, useRef} from 'react';",
)
replace_once(
    "web/components/Header.tsx",
    "<a className={active === 'map' ? 'active' : ''} aria-current={active === 'map' ? 'page' : undefined} href=\"/\">Карта маршрутов</a>",
    "<Link className={active === 'map' ? 'active' : ''} aria-current={active === 'map' ? 'page' : undefined} href=\"/\">Карта маршрутов</Link>",
)

Path(__file__).unlink(missing_ok=True)
