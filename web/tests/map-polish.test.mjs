import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');

test('map attribution follows the five-second interactive-map safe harbour',()=>{
  const source=read('components/MapAttribution.tsx');
  assert.match(source,/© OpenStreetMap contributors/);
  assert.match(source,/bindMapAttributionCollapse/);
  assert.match(source,/tropnik-map-attribution-seen/);
  assert.match(source,/Данные карты и лицензии/);
  assert.doesNotMatch(source,/Natural Earth/);
});
