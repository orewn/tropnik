from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(relative: str, old: str, new: str) -> None:
    path = ROOT / relative
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{relative}: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1))


def append_once(relative: str, marker: str, addition: str) -> None:
    path = ROOT / relative
    text = path.read_text()
    if marker in text:
        return
    path.write_text(text.rstrip() + "\n" + addition.strip() + "\n")


# Explore: remove legacy imports/dead icon and use a conventional internal navigation assignment.
replace_once(
    "web/components/Explore.tsx",
    "ShieldCheck,WifiSlash} from '@/components/TropnikIcons';",
    "ShieldCheck} from '@/components/TropnikIcons';",
)
replace_once(
    "web/components/Explore.tsx",
    "packs,saveReference,downloadJson,type SavedPack",
    "packs,saveReference,type SavedPack",
)
replace_once(
    "web/components/Explore.tsx",
    "errorText,type Route,type User",
    "errorText,type Route",
)
replace_once(
    "web/components/Explore.tsx",
    "warmMap,preloadTerrain,preloadTrail",
    "warmMap,preloadTrail",
)
replace_once(
    "web/components/Explore.tsx",
    "window.location.assign('/trips?request='+encodeURIComponent(created.id));",
    "window.location.href='/trips?request='+encodeURIComponent(created.id);",
)
replace_once(
    "web/components/Explore.tsx",
    "\nfunction ArrowUpRightIcon(){return <svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\" stroke=\"currentColor\" strokeWidth=\"1.6\" strokeLinecap=\"round\" strokeLinejoin=\"round\"/></svg>;}",
    "",
)

# Header: capture the auth sequence ref for the whole effect lifecycle.
replace_once(
    "web/components/Header.tsx",
    """  useEffect(() => {
    let controller: AbortController | null = null;
    const sync = async () => {
      const request = ++sequence.current;
      controller?.abort();
      controller = new AbortController();
      try { const profile = await api<User>('me', {signal: controller.signal}); if (request === sequence.current) setUser(profile); }
      catch (error) { if (!isAbort(error) && request === sequence.current) setUser(null); }
    };
    const authChanged = (event: Event) => {
      const detail = (event as CustomEvent<AuthChange>).detail;
      if (detail && Object.prototype.hasOwnProperty.call(detail, 'user')) {
        ++sequence.current;
        controller?.abort();
        setUser(detail.user);
      } else void sync();
    };
    const storageChanged = (event: StorageEvent) => { if (event.key === 'tropa-auth-change') void sync(); };
    void sync();
    window.addEventListener(AUTH_EVENT, authChanged);
    window.addEventListener('storage', storageChanged);
    return () => { ++sequence.current; controller?.abort(); window.removeEventListener(AUTH_EVENT, authChanged); window.removeEventListener('storage', storageChanged); };
  }, []);""",
    """  useEffect(() => {
    const authSequence = sequence;
    let controller: AbortController | null = null;
    const sync = async () => {
      const request = ++authSequence.current;
      controller?.abort();
      controller = new AbortController();
      try { const profile = await api<User>('me', {signal: controller.signal}); if (request === authSequence.current) setUser(profile); }
      catch (error) { if (!isAbort(error) && request === authSequence.current) setUser(null); }
    };
    const authChanged = (event: Event) => {
      const detail = (event as CustomEvent<AuthChange>).detail;
      if (detail && Object.prototype.hasOwnProperty.call(detail, 'user')) {
        ++authSequence.current;
        controller?.abort();
        setUser(detail.user);
      } else void sync();
    };
    const storageChanged = (event: StorageEvent) => { if (event.key === 'tropa-auth-change') void sync(); };
    void sync();
    window.addEventListener(AUTH_EVENT, authChanged);
    window.addEventListener('storage', storageChanged);
    return () => { ++authSequence.current; controller?.abort(); window.removeEventListener(AUTH_EVENT, authChanged); window.removeEventListener('storage', storageChanged); };
  }, []);""",
)

# Stories: retain real error handling without an unoptimized raw img element.
replace_once(
    "web/components/PlaceStories.tsx",
    " const fact=facts.length?facts[index%facts.length]:undefined;\n",
    """ const fact=facts.length?facts[index%facts.length]:undefined;

 useEffect(()=>{
  if(!fact)return;
  let active=true;
  const image=new window.Image();
  image.decoding='async';
  image.onload=()=>{if(active)setFailedPhoto(current=>current===fact.id?'':current);};
  image.onerror=()=>{if(active)setFailedPhoto(fact.id);};
  image.src=fact.imageUrl;
  return()=>{active=false;};
 },[fact]);
""",
)
replace_once(
    "web/components/PlaceStories.tsx",
    """{!photoFailed&&<img key={fact.imageUrl} src={fact.imageUrl} alt={fact.imageAlt} loading="eager" fetchPriority="low" decoding="async" draggable={false} style={{objectPosition:fact.imagePosition||'50% 50%'}} onError={()=>setFailedPhoto(fact.id)}/>}""",
    """{!photoFailed&&<span key={fact.imageUrl} className="fact-photo-image" role="img" aria-label={fact.imageAlt} style={{backgroundImage:`url("${fact.imageUrl.replaceAll('"','%22')}")`,backgroundPosition:fact.imagePosition||'50% 50%'}}/>}""",
)
append_once(
    "web/app/final-polish.css",
    ".fact-photo-image{",
    """
.fact-photo-image{display:block;width:100%;height:100%;min-height:inherit;background-size:cover;background-repeat:no-repeat;background-color:#dfe7d8}
""",
)

# Safety form: serialize the stable snapshot without a throwaway binding and track its dependency.
replace_once(
    "web/components/SafetyRegistration.tsx",
    """function passportSnapshot(passport: SafetyPassport): string {
  const {updatedAt: _updatedAt, ...stable} = passport;
  return JSON.stringify(stable);
}""",
    """function passportSnapshot(passport: SafetyPassport): string {
  return JSON.stringify(passport, key => key === 'updatedAt' ? undefined : passport[key as keyof SafetyPassport]);
}""",
)
replace_once(
    "web/components/SafetyRegistration.tsx",
    "const dirty = useMemo(() => passportSnapshot(passport) !== savedSnapshot, [passport]);",
    "const dirty = useMemo(() => passportSnapshot(passport) !== savedSnapshot, [passport, savedSnapshot]);",
)

# Territory browser no longer has an effect after keyed pagination.
replace_once(
    "web/components/TerritoryBrowser.tsx",
    "import {useEffect, useMemo, useState} from 'react';",
    "import {useMemo, useState} from 'react';",
)

# Acceptance criteria follow the optimized, accessible photo surface rather than the removed raw <img>.
replace_once(
    "web/tests/service-polish.test.mjs",
    """  assert.match(stories,/fetchPriority=\"low\"/);
  assert.match(stories,/draggable=\{false\}/);""",
    """  assert.match(stories,/className=\"fact-photo-image\"/);
  assert.match(stories,/role=\"img\"/);
  assert.match(stories,/image\\.decoding='async'/);
  assert.doesNotMatch(stories,/<img\\b/);""",
)

Path(__file__).unlink(missing_ok=True)
