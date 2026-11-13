import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {REVIEWED_COASTAL_SOURCES,isReviewedCoastalAllowance,verifyReviewedCoastalRoute} from '../lib/reviewed-coastal-routes.ts';
import {trailOverlayParts} from '../lib/map-trail-overlay.ts';
import {buildTrailOverlay} from '../scripts/build-trail-overlay.mjs';
const web=resolve(import.meta.dirname,'..'),source=REVIEWED_COASTAL_SOURCES[0],url='/data/'+source.key;

test('only the pinned official coastal coordinate sequence receives an immutable allowance',async()=>{
  assert.equal(REVIEWED_COASTAL_SOURCES.length,1,'The exception is an individually reviewed source, not a class of official routes');
  const raw=await readFile(resolve(web,'public',url.slice(1))),geometry=JSON.parse(raw);
  assert.equal(createHash('sha256').update(raw).digest('hex'),source.sourceSha256);
  assert.equal(createHash('sha256').update(await readFile(resolve(web,'../data/catalog/editorial-geometry/kolyma-black-creek.gpx'))).digest('hex'),source.rawGpxSha256);
  const allowance=await verifyReviewedCoastalRoute(url,geometry);assert.ok(allowance);assert.equal(isReviewedCoastalAllowance(allowance,geometry),true);
  const coordinates=trailOverlayParts(geometry).map(part=>part.coordinates);assert.deepEqual(allowance.geometry.coordinates,coordinates);
  for(const [lng,lat] of coordinates.flat())assert.ok(lng>=allowance.bounds[0]&&lng<=allowance.bounds[2]&&lat>=allowance.bounds[1]&&lat<=allowance.bounds[3],'The verified fit includes every source point, including its coastal endpoints');
  assert.equal(allowance.coordinateSha256,source.coordinateSha256);assert.equal(allowance.geometry.coordinates.flat().length,source.originalPoints);
  assert.equal(isReviewedCoastalAllowance({...allowance},geometry),false,'A copied/forged flag cannot bypass the mask');
  assert.equal(isReviewedCoastalAllowance(allowance,structuredClone(geometry)),false,'Selected admission is bound to its checked payload');
  const first=allowance.geometry.coordinates[0][0][0];coordinates[0][0][0]+=1;
  assert.equal(allowance.geometry.coordinates[0][0][0],first,'Mutation after hashing cannot change the reviewed draw snapshot');
  assert.throws(()=>{allowance.geometry.coordinates[0][0][0]+=1;},TypeError);
});

test('shifted coordinates, wrong source and extra non-line objects never receive a coastal exception',async()=>{
  const geometry=JSON.parse(await readFile(resolve(web,'public',url.slice(1)),'utf8'));
  assert.equal(await verifyReviewedCoastalRoute('/data/routes/unreviewed.geojson',geometry),undefined);
  const shifted=structuredClone(geometry);trailOverlayParts(shifted)[0].coordinates[100][0]+=.0000001;
  assert.equal(await verifyReviewedCoastalRoute(url,shifted),undefined);
  const lines=trailOverlayParts(geometry).map(part=>part.coordinates),extra={type:'GeometryCollection',geometries:[{type:'MultiLineString',coordinates:lines},{type:'Polygon',coordinates:[[[30,40],[31,40],[31,41],[30,40]]]}]};
  assert.equal(await verifyReviewedCoastalRoute(url,extra),undefined);
  assert.throws(()=>buildTrailOverlay([{id:'coast',geometryUrl:url,sha256:'b'.repeat(64),geometry}]),/reviewed coastal source changed/);
});
