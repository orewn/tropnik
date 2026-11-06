import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readRegionDefinitions} from '../scripts/region-artwork-catalog.mjs';

test('region artwork resolves constant spreads and asserted JSON arrays without executing the module', () => {
  const text = `import extra from './extra.json';
    const initial = [{id:'first',shapeNames:['First territory'],description:makeDescription()}];
    export const regions = [...initial, ...(extra.regions as Region[])];
    throw new Error('The build must never execute this module');`;
  assert.deepEqual(readRegionDefinitions(text, specifier => {
    assert.equal(specifier, './extra.json');
    return {regions: [{id: 'second', shapeNames: ['Second territory']}]};
  }), [{id: 'first', shapeNames: ['First territory']}, {id: 'second', shapeNames: ['Second territory']}]);
});

test('duplicate ids, dynamic mappings, cycles and nonliteral shape aliases remain rejected', () => {
  for (const source of [
    `const base=[{id:'same',shapeNames:['A']}];export const regions=[...base,...base];`,
    `export const regions=loadRemoteRegions();`,
    `const initial=[...regions];export const regions=[...initial];`,
    `let initial=[{id:'x',shapeNames:['A']}];export const regions=[...initial];`,
    `const names=['A'];export const regions=[{id:'x',shapeNames:names}];`,
    `export const regions=[{id:'x',shapeNames:['A'],...replaceAliases()}];`,
    `import external from '../unscoped.json';export const regions=[...external.regions];`,
    `import external from 'https://example.invalid/regions.json';export const regions=[...external.regions];`,
  ]) assert.throws(() => readRegionDefinitions(source, () => assert.fail('Unexpected JSON read')));
  for (const value of [{regions:[{id:'x',shapeNames:[42]}]}, {regions:[{id:'x',shapeNames:[]}]}, {regions:{}}, {}]) {
    assert.throws(() => readRegionDefinitions(`import extra from './extra.json';export const regions=[...(extra.regions as Region[])];`, () => value));
  }
});

test('the actual 15-region catalogue retains canonical local territory mappings', () => {
  const load = specifier => JSON.parse(readFileSync(new URL('../lib/' + specifier, import.meta.url), 'utf8'));
  const definitions = readRegionDefinitions(readFileSync(new URL('../lib/content.ts', import.meta.url), 'utf8'), load);
  const editorial = load('./editorial-regions.generated.json').regions;
  const territories = load('./territories.generated.json').territories;
  const artwork = load('./region-artwork.generated.json');
  assert.equal(definitions.length, 15);
  assert.deepEqual(definitions.map(item => item.id), Object.keys(artwork.artwork));
  for (const region of editorial) {
    const definition = definitions.find(item => item.id === region.id);
    assert.deepEqual(definition.shapeNames, region.shapeNames);
    assert.equal(definition.shapeNames.length, 1);
    const territory = territories.find(item => item.shapeNames.includes(definition.shapeNames[0]));
    assert.ok(territory?.outline, `Existing territory outline for ${region.id}`);
    const entry = artwork.artwork[region.id];
    assert.equal(entry.status, 'available');
    assert.deepEqual(entry.shapeNames, territory.shapeNames);
    assert.equal(entry.parts[0].sourceId, territory.sourceProperties.shapeID);
    assert.ok(entry.verification.projectedAreaRelativeError <= .005);
    assert.ok(entry.verification.retainedSourceAreaFraction >= .999);
  }
});
