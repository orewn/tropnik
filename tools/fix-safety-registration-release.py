#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]

component = root / 'web/components/SafetyRegistration.tsx'
text = component.read_text()
text = text.replace(
    "import {ArrowRight, ArrowSquareOut, Check, CheckCircle, Clock, DownloadSimple, Export, Info, MapPin, NotePencil, Plus, ShieldCheck, Trash, UsersThree, X} from './TropnikIcons';",
    "import {ArrowSquareOut, Check, CheckCircle, Clock, DownloadSimple, Export, Info, MapPin, NotePencil, Plus, ShieldCheck, Trash, UsersThree, X} from './TropnikIcons';",
)
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
