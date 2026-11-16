import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');

test('map credits stay compact with a source-page link and no automatic legal panel',()=>{
  const source=read('components/MapAttribution.tsx');
  assert.match(source,/© участники OpenStreetMap/);
  assert.doesNotMatch(source,/bindMapAttributionCollapse|useState|sessionStorage|setTimeout/);
  assert.doesNotMatch(source,/map-attribution-content|map-attribution-toggle|aria-expanded/);
  assert.match(source,/map-source-credit/);
  assert.match(source,/map-attribution-link/);
  assert.match(source,/Источники данных карты и лицензии/);
  assert.match(source,/href="\/sources"/);
  assert.doesNotMatch(source,/Natural Earth/);
});
