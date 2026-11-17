import test from 'node:test';
import assert from 'node:assert/strict';
import {savedTrailSnapshot} from '../lib/saved-route.ts';
import {loadPublishedRouteGeometry} from '../lib/published-route.ts';

const geometry = {type:'LineString',coordinates:[[40,43],[40.1,43.1]]};

test('saved reference geometry keeps its reviewed source identity and ignores a later catalogue line', () => {
  const trail = {id:'coastal',publicationStatus:'reference',geometryUrl:'/data/reviewed-coastal.geojson',geometry:{type:'LineString',coordinates:[[41,44],[41.1,44.1]]}};
  const snapshot = savedTrailSnapshot({trail,geometry});
  assert.equal(snapshot.geometryUrl, trail.geometryUrl);
  assert.deepEqual(snapshot.geometry, geometry);
  assert.notDeepEqual(snapshot.geometry, trail.geometry);
  assert.notEqual(snapshot, trail);
});

test('card-only saves remain readable without requesting an unsaved network line', () => {
  const snapshot = savedTrailSnapshot({trail:{id:'description',publicationStatus:'reference',geometryUrl:'/data/not-saved.geojson',geometry},geometry:null});
  assert.equal(snapshot.geometry, undefined);
  assert.equal(snapshot.geometryUrl, undefined);
  assert.throws(() => savedTrailSnapshot({trail:{id:'broken'},geometry:{type:'LineString',coordinates:[[Infinity,43],[40,43]]}}));
});

test('a saved published revision reopens its full geometry without fetching the current revision', async () => {
  const trail = {id:'published-a',revisionId:'revision-7',publicationStatus:'published',geometryUrl:'/api/backend/routes/published-a',geometryDetail:'overview'};
  const snapshot = savedTrailSnapshot({trail,geometry});
  const previous = globalThis.fetch;
  globalThis.fetch = () => {throw new Error('A saved revision must not use the network');};
  try {
    assert.equal(snapshot.revisionId,'revision-7');
    assert.equal(snapshot.geometryDetail,'full');
    assert.deepEqual(await loadPublishedRouteGeometry(snapshot), geometry);
  } finally {globalThis.fetch = previous;}
});
