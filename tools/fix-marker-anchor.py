#!/usr/bin/env python3
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def replace_once(path:str,old:str,new:str)->None:
    target=ROOT/path
    text=target.read_text()
    if new in text:return
    count=text.count(old)
    if count!=1:raise RuntimeError(f'{path}: expected one anchor, found {count}')
    target.write_text(text.replace(old,new,1))

replace_once(
    'web/components/Atlas2D.tsx',
    "import {groupMapDirections,updateDirectionButtons,constrainDirectionLabels,bindMapLabelReflow,type MapDirectionGroup} from '@/lib/map-direction-layout';",
    "import {DIRECTION_MARKER_SIZE,groupMapDirections,updateDirectionButtons,constrainDirectionLabels,bindMapLabelReflow,type MapDirectionGroup} from '@/lib/map-direction-layout';",
)
replace_once(
    'web/components/Atlas2D.tsx',
    'iconSize:[1,1],iconAnchor:[0,0]',
    'iconSize:[DIRECTION_MARKER_SIZE,DIRECTION_MARKER_SIZE],iconAnchor:[DIRECTION_MARKER_SIZE/2,DIRECTION_MARKER_SIZE/2]',
)

test=ROOT/'web/tests/map-polish.test.mjs'
source=test.read_text()
addition="""

test('region marker dots stay centered on the exact engine coordinate',()=>{
  const atlas=read('components/Atlas.tsx');
  const canvas=read('components/Atlas2D.tsx');
  const css=read('app/interface-refresh.css');
  assert.match(atlas,/new ml\\.Marker\\(\\{element:el,anchor:'center'\\}\\)/);
  assert.match(canvas,/iconSize:\\[DIRECTION_MARKER_SIZE,DIRECTION_MARKER_SIZE\\],iconAnchor:\\[DIRECTION_MARKER_SIZE\\/2,DIRECTION_MARKER_SIZE\\/2\\]/);
  assert.doesNotMatch(canvas,/iconSize:\\[1,1\\],iconAnchor:\\[0,0\\]/);
  assert.match(css,/region-marker\\.direction-cluster[\\s\\S]*width:44px!important/);
  assert.match(css,/Only the label shifts;[\\s\\S]*the dot and the map engine's anchor never move/);
});
"""
if 'region marker dots stay centered on the exact engine coordinate' not in source:
    test.write_text(source.rstrip()+addition+'\n')

release=ROOT/'docs/release-0.4.5.md'
source=release.read_text()
marker='- service worker `tropnik-shell-v13` с проверенной повторной упаковкой manifest обзорного рельефа.\n'
line='- точный anchor marker: MapLibre использует центр фиксированного 44×44 control, Leaflet — `iconSize 44×44 / iconAnchor 22×22`; cluster label больше не меняет размер географического anchor.\n'
if line not in source:
    if marker not in source:raise RuntimeError('release note anchor missing')
    release.write_text(source.replace(marker,marker+line,1))

visual=ROOT/'docs/MAP-VISUAL-SYSTEM.md'
source=visual.read_text()
paragraph='Маркер направления имеет фиксированный географический anchor 44×44 px в обоих движках. В Leaflet центр иконки `[22, 22]` совпадает с координатой, а cluster/label остаются абсолютно позиционированными и не участвуют в размере anchor.'
if paragraph not in source:
    heading='## Рельеф и zoom\n'
    if heading not in source:raise RuntimeError('visual system anchor missing')
    visual.write_text(source.replace(heading,paragraph+'\n\n'+heading,1))

for relative in ['.github/workflows/fix-map-marker-anchor.yml','tools/fix-marker-anchor.py']:
    (ROOT/relative).unlink(missing_ok=True)

print('Exact marker anchor hotfix applied')
