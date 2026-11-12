import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createTerrainRegionReader,parseTerrainRegions,regionContainsBounds,verifyRegionalBytes} from '../lib/terrain-region-sources.ts';

const bounds=[142.7,46.9,142.9,47.1];
const encoded=value=>new TextEncoder().encode(JSON.stringify(value)).buffer;
const digest=bytes=>createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
const material=new Uint8Array([137,80,78,71,10,20,30,40]).buffer;
function fixture(){
  const grid={schemaVersion:1,bounds:[...bounds],width:2,height:2,elevations:[10,20,30,40],minElevation:10,maxElevation:40,
    units:'meters',rowOrder:'north-to-south',columnOrder:'west-to-east',source:{name:'Copernicus GLO-30',sourceNominalResolutionM:30}};
  const bytes=encoded(grid),region={id:'sakhalin-test',bounds:[...bounds],gridUrl:'/terrain-regions/sakhalin-test/terrain-grid.json',materialUrl:'/terrain-regions/sakhalin-test/surface.png',
    gridSha256:digest(bytes),materialSha256:digest(material),gridBytes:bytes.byteLength,materialBytes:material.byteLength,
    material:{width:2,height:2,bounds:[...bounds],source:'ESA WorldCover 2021',nominalResolutionM:10,attribution:'Source credit'},provenance:{source:'Original public datasets'}};
  return{region,grid,bytes,manifest:{schemaVersion:1,regions:[region]}};
}

test('regional manifests accept finite checked source assets and reject remote, traversal, malformed or oversized inputs',()=>{
  const {manifest,region}=fixture(),original=structuredClone(manifest);assert.deepEqual(parseTerrainRegions(manifest),[region]);assert.deepEqual(manifest,original);
  for(const patch of [
    {gridUrl:'https://example.com/terrain-grid.json'},{materialUrl:'//example.com/surface.png'},
    {gridUrl:'/terrain-regions/../secret.json'},{materialUrl:'/terrain-regions/%2e%2e/surface.png'},
    {gridUrl:'/terrain-regions/a/terrain-grid.json?secret=1'},{materialUrl:'/terrain-regions/a/surface.png#bad'},
    {gridSha256:'x'.repeat(64)},{materialSha256:'f'.repeat(63)},{gridBytes:0},{materialBytes:8*1024*1024+1},
    {gridBytes:1.5},{bounds:[142.9,46.9,142.7,47.1]},{bounds:[142.7,46.9,142.9,Infinity]},
    {material:{...region.material,width:2049}},{material:{...region.material,height:1}},
    {material:{...region.material,bounds:[142.7,46.9,143,47.1]}},
  ])assert.throws(()=>parseTerrainRegions({schemaVersion:1,regions:[{...region,...patch}]}),/regional terrain/);
  assert.throws(()=>parseTerrainRegions({schemaVersion:1,regions:[region,{...region}]}),/entry/);
  assert.throws(()=>parseTerrainRegions({schemaVersion:1,regions:Array.from({length:129},(_,index)=>({...region,id:'r-'+index}))}),/manifest/);
  for(const input of [null,{},[],{schemaVersion:2,regions:[]},{schemaVersion:1,regions:null}])assert.throws(()=>parseTerrainRegions(input),/manifest/);
});

test('regional containment respects continuous longitude copies without shifting or enlarging the requested geography',()=>{
  assert.equal(regionContainsBounds(bounds,bounds),true,'Exact decimal source bounds must contain themselves without floating-point cancellation');
  assert.equal(regionContainsBounds(bounds,[142.72,46.95,142.88,47.05]),true);
  assert.equal(regionContainsBounds(bounds,[142.72,46.95,142.92,47.05]),false);
  assert.equal(regionContainsBounds(bounds,[142.72,46.85,142.88,47.05]),false);
  assert.equal(regionContainsBounds([179,50,181,52],[-180.8,50.2,-179.2,51.8]),true);
  assert.equal(regionContainsBounds([179,50,181,52],[-180.8,50.2,-178.8,51.8]),false);
});

test('regional byte verification rejects changed content even when its length remains correct',async()=>{
  await verifyRegionalBytes(material,material.byteLength,digest(material));
  const changed=material.slice(0);new Uint8Array(changed)[5]^=1;
  await assert.rejects(verifyRegionalBytes(changed,material.byteLength,digest(material)),/checksum/);
  await assert.rejects(verifyRegionalBytes(material.slice(1),material.byteLength,digest(material)),/size/);
  await assert.rejects(verifyRegionalBytes(new ArrayBuffer(8*1024*1024+1),8*1024*1024+1,'f'.repeat(64)),/size/);
});

test('the reader shares a manifest, picks the smallest complete source and recovers after a transient manifest failure',async()=>{
  const {region}=fixture(),wide={...region,id:'wide',bounds:[142,46,144,48],material:{...region.material,bounds:[142,46,144,48]}};
  let calls=0;
  const reader=createTerrainRegionReader({loadJSON:async url=>{assert.equal(url,'/terrain-regions/manifest.json');if(++calls===1)throw new Error('Temporary network interruption');return{schemaVersion:1,regions:[wide,region]};},loadBytes:async()=>{assert.fail('Finding coverage must not fetch all region assets');}});
  assert.equal(await reader.find(bounds),undefined);assert.equal((await reader.find([142.72,46.95,142.88,47.05])).id,'sakhalin-test');
  assert.equal((await reader.find([142.6,46.8,143,47.2])).id,'wide');assert.equal(await reader.find([130,45,131,46]),undefined);assert.equal(calls,2);
});

test('grid and material reads validate exact content and geographic bounds before returning a usable source',async()=>{
  const {region,grid,bytes,manifest}=fixture(),urls=[];
  const reader=createTerrainRegionReader({loadJSON:async()=>manifest,loadBytes:async url=>{urls.push(url);return url===region.gridUrl?bytes:material;}});
  const selected=await reader.find(bounds);assert.deepEqual(await reader.grid(selected),grid);assert.deepEqual(await reader.material(selected),material);
  assert.deepEqual(urls,[region.gridUrl,region.materialUrl]);
  const wrongBounds=encoded({...grid,bounds:[142.7,46.9,143,47.1]}),moved={...region,gridSha256:digest(wrongBounds),gridBytes:wrongBounds.byteLength};
  const other=createTerrainRegionReader({loadJSON:async()=>manifest,loadBytes:async()=>wrongBounds});
  await assert.rejects(other.grid(moved),/bounds differ/);
  const impossible=encoded({...grid,elevations:[10,20,30000,40]}),invalid={...region,gridSha256:digest(impossible),gridBytes:impossible.byteLength};
  const malformed=createTerrainRegionReader({loadJSON:async()=>manifest,loadBytes:async()=>impossible});
  await assert.rejects(malformed.grid(invalid),/elevation/);
  await assert.rejects(reader.material({...region,materialSha256:'f'.repeat(64)}),/checksum/);
});
