#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]

component = root / 'web/components/SafetyRegistration.tsx'
text = component.read_text()
text = text.replace(
    "import {ArrowRight, ArrowSquareOut, Check, CheckCircle, Clock, DownloadSimple, Export, Info, MapPin, NotePencil, Plus, ShieldCheck, Trash, UsersThree, X} from './TropnikIcons';",
    "import {ArrowSquareOut, Check, CheckCircle, Clock, DownloadSimple, Export, Info, MapPin, NotePencil, Plus, ShieldCheck, Trash, UsersThree, X} from './TropnikIcons';",
)
old_effect = """  useEffect(() => {
    try {
      const stored = parseSafetyPassportList(JSON.parse(localStorage.getItem(SAFETY_STORAGE_KEY) || '[]'));
      setSaved(stored);
      const params = new URLSearchParams(location.search);
      const requested = params.get('passport');
      const existing = requested ? stored.find(item => item.id === requested) : undefined;
      if (existing) { setPassport(existing); return; }
      const routeId = params.get('route');
      const route = routeId ? trails.find(item => item.id === routeId) : undefined;
      if (!route) return;
      const region = regions.find(item => item.id === route.regionId);
      setPassport(previous => ({
        ...previous,
        routeId: route.id,
        routeTitle: route.title,
        region: region?.name || previous.region,
        routeDescription: route.description || previous.routeDescription,
        updatedAt: new Date().toISOString(),
      }));
    } catch { setNotice('Не удалось прочитать сохранённые паспорта на этом устройстве.'); }
  }, []);
"""
new_effect = """  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const stored = parseSafetyPassportList(JSON.parse(localStorage.getItem(SAFETY_STORAGE_KEY) || '[]'));
        setSaved(stored);
        const params = new URLSearchParams(location.search);
        const requested = params.get('passport');
        const existing = requested ? stored.find(item => item.id === requested) : undefined;
        if (existing) { setPassport(existing); return; }
        const routeId = params.get('route');
        const route = routeId ? trails.find(item => item.id === routeId) : undefined;
        if (!route) return;
        const region = regions.find(item => item.id === route.regionId);
        setPassport(previous => ({
          ...previous,
          routeId: route.id,
          routeTitle: route.title,
          region: region?.name || previous.region,
          routeDescription: route.description || previous.routeDescription,
          updatedAt: new Date().toISOString(),
        }));
      } catch { setNotice('Не удалось прочитать сохранённые паспорта на этом устройстве.'); }
    });
    return () => { cancelled = true; };
  }, []);
"""
if old_effect in text:
    text = text.replace(old_effect, new_effect, 1)
elif new_effect not in text:
    raise SystemExit('Local passport hydration anchor not found')
component.write_text(text)

map_test = root / 'web/tests/map-polish.test.mjs'
text = map_test.read_text().replace('tropnik-shell-v15', 'tropnik-shell-v16')
map_test.write_text(text)

safety_test = root / 'web/tests/safety-passport.test.mjs'
text = safety_test.read_text()
old = """  const component = await readFile(new URL('../components/SafetyRegistration.tsx', import.meta.url), 'utf8');
  const page = await readFile(new URL('../app/safety/registration/page.tsx', import.meta.url), 'utf8');
  assert.match(component, /forms\\.mchs\\.gov\\.ru\\/registration_tourist_groups/);
  assert.match(component, /localStorage\\.setItem\\(SAFETY_STORAGE_KEY/);
"""
new = """  const component = await readFile(new URL('../components/SafetyRegistration.tsx', import.meta.url), 'utf8');
  const policy = await readFile(new URL('../lib/safety-passport.ts', import.meta.url), 'utf8');
  const page = await readFile(new URL('../app/safety/registration/page.tsx', import.meta.url), 'utf8');
  assert.match(policy, /forms\\.mchs\\.gov\\.ru\\/registration_tourist_groups/);
  assert.match(component, /MCHS_REGISTRATION_URL/);
  assert.match(component, /localStorage\\.setItem\\(SAFETY_STORAGE_KEY/);
"""
if old not in text and new not in text:
    raise SystemExit('Safety UI test anchor not found')
text = text.replace(old, new)
safety_test.write_text(text)

pages_build = root / 'tools/pages-preview/build.mjs'
text = pages_build.read_text()
old_pages = """const infoPages = {
  about: 'О проекте', safety: 'Подготовка к походу', sources: 'Источники и лицензии',
"""
new_pages = """const infoPages = {
  about: 'О проекте', safety: 'Подготовка к походу', 'safety/registration': 'Регистрация похода в МЧС', sources: 'Источники и лицензии',
"""
if old_pages in text:
    text = text.replace(old_pages, new_pages, 1)
elif new_pages not in text:
    raise SystemExit('Pages catalogue anchor not found')
pages_build.write_text(text)
