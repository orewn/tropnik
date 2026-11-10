import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {canvasLabelsInCoverage, createCanvasLabelLayer} from '../public/maps/canvas-label-coverage.js';

const require = createRequire(new URL('../package.json', import.meta.url));
const p = require('protomaps-leaflet');
const PointModule = createRequire(require.resolve('protomaps-leaflet'))('@mapbox/point-geometry');
const Point = PointModule.default || PointModule;
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const area = read('../public/data/russia-display-area.geojson');
const fixtures = read('./fixtures/russia-checks.json').pointCases;
const rectangle = {type: 'Polygon', coordinates: [[[10, 50], [20, 50], [20, 60], [10, 60], [10, 50]]]};
function project([longitude, latitude], zoom) {
  const world = 256 * 2 ** zoom, sine = Math.sin(latitude * Math.PI / 180);
  return new Point((longitude + 180) / 360 * world, (.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * world);
}
const candidate = (anchor, text = 'Название') => ({anchor, bboxes: [{minX: anchor.x - 80, minY: anchor.y - 12, maxX: anchor.x + 80, maxY: anchor.y + 12}], draw() {}, deduplicationKey: text, deduplicationDistance: 200});

test('Canvas label eligibility follows pinned geography at integer/fractional zooms and wrapped longitudes', () => {
  const rule = {dataLayer: 'place', symbolizer: {place: (_layout, geom) => [candidate(geom[0][0])]}};
  const [covered] = canvasLabelsInCoverage([rule], area);
  for (const zoom of [...Array.from({length: 73}, (_, step) => step / 4), 7.06188]) {
    for (const fixture of fixtures) for (const copy of [-360, 0, 360]) {
      const [longitude, latitude] = fixture.inputLngLat;
      const anchor = project([longitude + copy, latitude], zoom);
      const labels = covered.symbolizer.place({zoom}, [[anchor]], {props: {'name:ru': fixture.name}});
      assert.equal(!!labels?.length, fixture.expectedInside, `${fixture.name}, zoom ${zoom}, world ${copy}`);
    }
  }
});

test('accepted coastal labels retain complete glyph boxes, halos and draw functions beyond the border', () => {
  const zoom = 12, anchor = project([19.9999, 55], zoom), label = candidate(anchor);
  const original = {dataLayer: 'place', minzoom: 4, maxzoom: 18, filter: () => true, symbolizer: {place: () => [label]}};
  const [rule] = canvasLabelsInCoverage([original], rectangle);
  const result = rule.symbolizer.place({zoom}, [[anchor]], {props: {name: 'Над берегом'}});
  assert.equal(result[0], label, 'do not crop or rebuild accepted label geometry');
  assert.ok(label.bboxes[0].maxX > project([20, 55], zoom).x, 'the real painted name crosses the country edge');
  assert.equal(rule.filter, original.filter);
  assert.equal(rule.minzoom, 4);
  assert.equal(rule.maxzoom, 18);
  assert.notEqual(rule.symbolizer, original.symbolizer, 'wrap without mutating shared style instances');
});

test('existing Canvas rules read the newly committed coverage for each actual label anchor',()=>{
  let current=rectangle;
  const label=candidate(project([15,55],12));
  const [rule]=canvasLabelsInCoverage([{dataLayer:'place',symbolizer:{place:()=>[label]}}],()=>current);
  assert.equal(rule.symbolizer.place({zoom:12},[],{})[0],label);
  current={type:'Polygon',coordinates:[...rectangle.coordinates,[[14,54],[16,54],[16,56],[14,56],[14,54]]]};
  assert.equal(rule.symbolizer.place({zoom:12},[],{}),undefined);
  current=rectangle;assert.equal(rule.symbolizer.place({zoom:12},[],{})[0],label);
});

test('every point and line candidate uses its own world anchor, regardless of text or source geometry origin', () => {
  const zoom = 11;
  const inside = candidate(project([15, 55], zoom), 'English source label');
  const outside = candidate(project([25, 55], zoom), 'Русское название иностранного места');
  for (const dataLayer of ['place', 'water_name', 'mountain_peak', 'poi']) {
    const source = {place() {assert.equal(this, source); return [outside, inside, outside];}};
    const [rule] = canvasLabelsInCoverage([{dataLayer, symbolizer: source}], rectangle);
    const labels = rule.symbolizer.place({zoom}, [[project([0, 0], zoom)]], {geomType: 2});
    assert.deepEqual(labels, [inside], `${dataLayer} must filter every candidate before collision insertion`);
  }
});

test('malformed anchors, absent coverage and empty symbolizer results fail closed', () => {
  for (const anchor of [undefined, {x: NaN, y: 0}, {x: 1, y: Infinity}, {x: 1, y: -1}, {x: 1, y: 256 * 2 ** 12 + 1}]) {
    const [rule] = canvasLabelsInCoverage([{dataLayer: 'place', symbolizer: {place: () => [{anchor}]}}], rectangle);
    assert.equal(rule.symbolizer.place({zoom: 12}, [], {}), undefined);
  }
  const [missing] = canvasLabelsInCoverage([{dataLayer: 'place', symbolizer: {place: () => [candidate(project([15, 55], 12))]}}], undefined);
  assert.equal(missing.symbolizer.place({zoom: 12}, [], {}), undefined);
  const [empty] = canvasLabelsInCoverage([{dataLayer: 'place', symbolizer: {place: () => undefined}}], rectangle);
  assert.equal(empty.symbolizer.place({zoom: 12}, [], {}), undefined);
});

test('the real Protomaps labeler drops a foreign neighbour before it can suppress a Russian border label', () => {
  const zoom = 12, world = 256 * 2 ** zoom, scale = world / 512;
  const foreign = project([20.0001, 55], zoom), domestic = project([19.9999, 55], zoom);
  const scratch = {font: '', measureText: text => ({width: text.length * 8, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3})};
  const rules = [{dataLayer: 'place', symbolizer: new p.Padding(4, new p.CenteredTextSymbolizer({labelProps: ['name:ru'], font: '500 14px Manrope', fill: '#263F32', stroke: '#fff', width: 2}))}];
  const feature = (anchor, name) => ({geomType: 1, geom: [[anchor.div(scale)]], props: {'name:ru': name}});
  const data = new Map([['place', [feature(foreign, 'Иностранное место'), feature(domestic, 'Город у границы')]]]);
  const tile = {z: zoom, dataTile: {z: 0, x: 0, y: 0}, origin: new Point(0, 0), scale, dim: world, data};
  const labeler = new p.Labeler(zoom, scratch, canvasLabelsInCoverage(rules, rectangle), 16);
  labeler.add(new Map([['', [tile]]]));
  const visible = [...labeler.index.searchBbox({minX: 0, minY: 0, maxX: world, maxY: world}, Infinity)];
  assert.equal(visible.length, 1);
  assert.ok(Math.abs(visible[0].anchor.x - domestic.x) < 1e-7, 'the tile-local input was transformed before geographic filtering');
  assert.ok(visible[0].bboxes.some(box => box.maxX > project([20, 55], zoom).x), 'complete border label survives collision layout');
});

test('the installed line symbolizer retains only covered repeated label anchors on a border-crossing line', () => {
  const zoom = 10, first = project([19.7, 55], zoom), last = project([20.3, 55], zoom), edge = project([20, 55], zoom).x;
  const scratch = {font: '', measureText: text => ({width: text.length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2})};
  const line = new p.LineLabelSymbolizer({labelProps: ['name:ru'], font: '500 12px Manrope', repeatDistance: 100, stroke: '#fff', width: 2});
  const feature = {geomType: 2, bbox: {minX: first.x, minY: first.y, maxX: last.x, maxY: last.y}, props: {'name:ru': 'Река'}};
  const layout = {zoom, overzoom: 0, scratch, index: new p.Index(256 * 2 ** zoom, 16), order: 0};
  let generated;
  const [rule] = canvasLabelsInCoverage([{dataLayer: 'water_name', symbolizer: {place(...args) {generated = line.place(...args); return generated;}}}], rectangle);
  const accepted = rule.symbolizer.place(layout, [[first, last]], feature);
  assert.ok(generated.length >= 3, 'the SDK really produced multiple repeated labels');
  assert.ok(generated.some(label => label.anchor.x > edge), 'some actual candidates lie outside');
  assert.ok(accepted.length > 0 && accepted.length < generated.length);
  assert.deepEqual(accepted, generated.filter(label => label.anchor.x <= edge), 'test each placed candidate, not only the line start or source-tile coordinates');
});

test('separate transparent labels share the exact view/cache and deduplicate a concurrent vector source request', async () => {
  let requests = 0, release;
  const decoded = new Map([['place', []]]);
  const source = {get() {requests++; return new Promise(resolve => {release = resolve;});}};
  const ground = {views: new Map([['', new p.View(new p.TileCache(source, 512), 14, 1)]])};
  let options;
  const labels = createCanvasLabelLayer({leafletLayer(value) {options = value; return {views: new Map()};}}, ground, [], area, {pane: 'russia-labels', devicePixelRatio: 2, noWrap: true, minZoom: 7});
  assert.equal(labels.views, ground.views);
  assert.deepEqual(options.sources, {});
  assert.deepEqual(options.paintRules, []);
  assert.equal(options.backgroundColor, undefined);
  assert.equal(options.attribution, '');
  assert.equal(options.devicePixelRatio, 2);
  assert.equal(options.noWrap, true);
  assert.equal(options.minZoom, 7);
  const paintTile = ground.views.get('').getDisplayTile({z: 9, x: 100, y: 70});
  const labelTile = labels.views.get('').getDisplayTile({z: 9, x: 101, y: 70});
  assert.equal(requests, 1, 'adjacent display tiles share one source tile fetch/decode');
  release(decoded);
  const [paint, text] = await Promise.all([paintTile, labelTile]);
  assert.equal(paint.data, decoded);
  assert.equal(text.data, decoded);
  assert.equal((await labels.views.get('').getDisplayTile({z: 9, x: 100, y: 70})).data, decoded);
  assert.equal(requests, 1, 'later label redraws reuse decoded data');
});
