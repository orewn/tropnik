import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

/** Taken from the compiled source catalogue, independently of the rendered UI. */
export function catalogueExpectations(regions, trails) {
  assert.ok(Array.isArray(regions) && regions.length > 0);
  assert.ok(Array.isArray(trails) && trails.length > 0);
  assert.equal(new Set(trails.map(trail => trail.id)).size, trails.length, 'Duplicate catalogue route identity');
  const counts = new Map();
  const membership = trails.map(trail => {
    const ids = [...new Set([trail.regionId, ...(trail.regionIds || [])])].sort();
    for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
    return {id: trail.id, regionIds: ids};
  }).sort((a, b) => a.id.localeCompare(b.id));
  const directions = regions.map(region => ({id: region.id, name: region.name, count: counts.get(region.id) || 0}));
  const result = {schemaVersion: 1, total: trails.length, directions,
    sourceDigest: createHash('sha256').update(JSON.stringify({directions, membership})).digest('hex')};
  assertCatalogueExpectations(result);
  return result;
}

export function assertCatalogueExpectations(value) {
  assert.equal(value?.schemaVersion, 1, 'Missing source catalogue expectation');
  assert.ok(Number.isInteger(value.total) && value.total > 0);
  assert.match(value.sourceDigest || '', /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(value.directions) && value.directions.length > 0);
  const ids = new Set();
  for (const direction of value.directions) {
    assert.ok(typeof direction.id === 'string' && direction.id && !ids.has(direction.id));
    ids.add(direction.id);
    assert.ok(typeof direction.name === 'string' && direction.name);
    assert.ok(Number.isInteger(direction.count) && direction.count >= 0 && direction.count <= value.total);
  }
  return value;
}
