import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {decodeCoverage,coverageCells,coverageLevel,createMapCoverage,loadMapCoverage,bindMapCoverage,MAP_COVERAGE_LIMITS} from '../public/maps/map-coverage-lod.js';

const version='0123456789abcdef';
function pack(features,lod='overview',cell) {
  const lookup=new Map(),positions=[];let x=0,y=0;
  const intern=value=>{
    if(typeof value[0]!=='number')return value.map(intern);
    const a=Math.round(value[0]*1e7),b=Math.round(value[1]*1e7),key=`${a},${b}`;
    if(!lookup.has(key)){lookup.set(key,lookup.size);positions.push(a-x,b-y);x=a;y=b;}
    return lookup.get(key);
  };
  return {type:'TropnikCoverage',encoding:'indexed-delta-1e7-v1',coverageVersion:version,lod,...(cell?{cell}:{}),positions,
    features:features.map(feature=>({...feature,geometry:{...feature.geometry,coordinates:intern(feature.geometry.coordinates)}}))};
}
const polygon=(x,y,size=1)=>({type:'Polygon',coordinates:[[[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]]]});
const feature=(cell,role,geometry)=>({type:'Feature',id:`${cell}:${role}`,properties:{cell,role,shapeName:'Source'},geometry});
function fixtures(count=2) {
  const files=new Map(),cells=[],initial=[];
  const save=(url,value)=>{const bytes=Buffer.from(JSON.stringify(value));files.set(url,bytes);return{url,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};};
  for(let i=0;i<count;i++){
    const id=`cell${i}`,x=20+i*3,bounds=[x,50,x+1,51],levels={};
    initial.push(feature(id,'area',polygon(x,50)),feature(id,'mask',polygon(x,49)));
    for(const lod of ['regional','local','source'])levels[lod]=save(`/data/map-coverage/cells/${id}-${lod}.coverage`,pack([
      feature(id,'area',polygon(x+.1,50.1,.8)),feature(id,'mask',polygon(x+.1,49.1,.8)),feature(id,'territory',polygon(x+.1,50.1,.8)),
      feature(id,'territory-boundary',{type:'LineString',coordinates:[[x+.1,50.1],[x+.9,50.1]]}),
    ],lod,id));
    cells.push({id,bounds,levels});
  }
  const packed=pack(initial),base=decodeCoverage(packed),descriptor=save('/data/map-coverage/base.coverage',packed);
  return {manifest:{schemaVersion:1,encoding:packed.encoding,version,base:descriptor,cells},base,files};
}
const response=bytes=>new Response(bytes,{status:200,headers:{'content-length':String(bytes.length)}});
const view=i=>[20+i*3+.2,50.2,20+i*3+.8,50.8];

test('lossless point interning keeps holes, multipart rings and shared role vertices',()=>{
  const geometry={type:'MultiPolygon',coordinates:[polygon(20.1234567,50.7654321).coordinates,[...polygon(24,50,2).coordinates,...polygon(24.5,50.5,.2).coordinates]]};
  const source=[feature('a','area',geometry),feature('a','territory',geometry)];
  const packed=pack(source),decoded=decodeCoverage(packed);
  assert.deepEqual(decoded.features,source);
  assert.ok(packed.positions.length<40,'roles reuse exact position entries');
  assert.throws(()=>decodeCoverage({...packed,positions:[...packed.positions,1]}),/coverage-encoding/);
  const bad=structuredClone(packed);bad.features[0].geometry.coordinates[0][0][0]=-1;
  assert.throws(()=>decodeCoverage(bad),/coverage-index/);
  assert.throws(()=>decodeCoverage({...packed,positions:[Number.MAX_SAFE_INTEGER,0]}),/coverage-coordinate/);
});

test('zoom boundaries select bounded Mercator detail and world copies select the same leaves',()=>{
  assert.deepEqual([2,4,4.01,8,8.01,12,12.01,18].map(coverageLevel),['overview','overview','regional','regional','local','local','source','source']);
  const {manifest}=fixtures();
  assert.deepEqual(coverageCells(manifest,view(0),14).map(c=>c.id),['cell0']);
  const repeated=view(0).map((value,index)=>index%2===0?value+360:value);
  assert.deepEqual(coverageCells(manifest,repeated,14).map(c=>c.id),['cell0']);
  assert.equal(coverageCells(manifest,view(0),4).length,0);
});

test('a superseded response cannot restore stale coast geometry, even if fetch ignores abort',async()=>{
  const {manifest,base,files}=fixtures(),requests=[];
  const session=createMapCoverage(manifest,base,{fetch:(url,{signal})=>new Promise(resolve=>requests.push({url,signal,resolve}))});
  const oldArea=session.area,first=session.updateView(view(0),14);
  const second=session.updateView(view(1),14);
  assert.equal(requests.length,2);assert.equal(requests[0].signal.aborted,true);
  assert.equal(session.area,oldArea,'four render roles remain untouched until the selected generation completes');
  requests[1].resolve(response(files.get(requests[1].url)));await second;
  const newArea=session.area;
  assert.deepEqual(session.status.cells,['cell1']);assert.equal(session.status.ready,true);
  assert.equal(session.territories.features.length,1);assert.equal(session.boundaries.features.length,1);
  requests[0].resolve(response(files.get(requests[0].url)));await first;
  assert.equal(session.area,newArea);assert.deepEqual(session.status.cells,['cell1']);assert.equal(session.status.pending,0);
  session.dispose();
});

test('all roles commit together, unchanged views reuse cache, and overview restores the base',async()=>{
  const {manifest,base,files}=fixtures(),calls=[];
  const session=createMapCoverage(manifest,base,{fetch:async url=>{calls.push(url);return response(files.get(url));}});
  const commits=[];session.subscribe(value=>{if(value.status.ready)commits.push([value.area,value.mask,value.territories,value.boundaries]);});
  await session.updateView(view(0),14);const detailed=session.cellFeatures.get('cell0');
  await session.updateView(view(0),18);assert.equal(calls.length,1);assert.equal(session.cellFeatures.get('cell0'),detailed);
  await session.updateView(view(0),3);assert.equal(session.territories.features.length,0);assert.equal(session.area.features[0].geometry,base.features[0].geometry);
  await session.updateView(view(0),14);assert.equal(calls.length,1);assert.equal(session.cellFeatures.get('cell0'),detailed);
  assert.ok(commits.every(roles=>roles.every(role=>role.type==='FeatureCollection')));
  session.dispose();
});

test('parallel requests stay bounded and one failed leaf never partially changes coverage',async()=>{
  const {manifest,base,files}=fixtures(7),requests=[];
  const session=createMapCoverage(manifest,base,{fetch:(url,{signal})=>new Promise(resolve=>requests.push({url,signal,resolve}))});
  const area=session.area,job=session.updateView([20,50,39,51],14);
  assert.equal(requests.length,MAP_COVERAGE_LIMITS.concurrent);
  requests[0].resolve(new Response('failure',{status:503}));await job;
  assert.equal(session.area,area);assert.equal(session.status.ready,false);assert.equal(session.status.error,'coverage-http');
  for(const request of requests.slice(1)){assert.equal(request.signal.aborted,true);request.resolve(response(files.get(request.url)));}
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(session.status.pending,0);assert.equal(requests.length,3);assert.equal(session.area,area);
  session.dispose();
});

test('transport hashes, declared bytes and viewport budgets fail closed',async()=>{
  const {manifest,base,files}=fixtures(9);let calls=0;
  const wrong=createMapCoverage(manifest,base,{fetch:async url=>{const bytes=Buffer.from(files.get(url));bytes[bytes.length-2]^=1;return response(bytes);}});
  await wrong.updateView(view(0),14);assert.equal(wrong.status.error,'coverage-integrity');assert.equal(wrong.area.features[0].geometry,base.features[0].geometry);wrong.dispose();
  const oversized=structuredClone(manifest);for(const cell of oversized.cells)cell.levels.source.bytes=3*1024*1024;
  const limited=createMapCoverage(oversized,base,{fetch:async()=>{calls++;throw new Error('must not run');}});
  await limited.updateView([20,50,46,51],14);assert.equal(calls,0);assert.equal(limited.status.error,'coverage-budget');limited.dispose();
});

test('disposal aborts pending source work without publishing after unmount',async()=>{
  const {manifest,base,files}=fixtures();let request,events=0;
  const session=createMapCoverage(manifest,base,{fetch:(url,{signal})=>new Promise(resolve=>request={url,signal,resolve})});
  session.subscribe(()=>events++);const job=session.updateView(view(0),14),before=events;
  session.dispose();assert.equal(request.signal.aborted,true);request.resolve(response(files.get(request.url)));await job;assert.equal(events,before);
});

test('DOM readiness waits for the current renderer and ignores a stale style completion',async()=>{
  const {manifest,base,files}=fixtures(),session=createMapCoverage(manifest,base,{fetch:async url=>response(files.get(url))});
  const events=new Map(),map={getBounds:()=>({getWest:()=>20,getSouth:()=>50,getEast:()=>21,getNorth:()=>51}),getZoom:()=>3,on:(event,cb)=>events.set(event,cb),off:event=>events.delete(event)};
  const element={dataset:{}},renders=[];
  const dispose=bindMapCoverage(map,session,element,()=>new Promise(resolve=>renders.push(resolve)));
  events.get('style.load')();const latest=renders.at(-1);
  for(const resolve of renders.slice(0,-1))resolve();await Promise.resolve();assert.equal(element.dataset.mapCoverageReady,'false');
  latest();await Promise.resolve();assert.equal(element.dataset.mapCoverageReady,'true');assert.equal(element.dataset.mapCoverageError,'');dispose();
});

const read=path=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
test('published cells match every transport receipt and keep the original Gogland source ring',async t=>{
  const manifest=read('../public/data/map-coverage/manifest.json');let bytes=0,files=0;
  for(const descriptor of [manifest.base,...manifest.cells.flatMap(cell=>Object.values(cell.levels))]){
    const data=readFileSync(new URL(`../public${descriptor.url}`,import.meta.url));
    assert.equal(data.byteLength,descriptor.bytes);assert.equal(createHash('sha256').update(data).digest('hex'),descriptor.sha256);bytes+=data.byteLength;files++;
  }
  assert.equal(files,568);assert.ok(manifest.base.bytes<3*1024*1024);assert.ok(bytes<120*1024*1024);
  const point=manifest.regressionSourceVertices.gogland,cell=manifest.cells.find(cell=>cell.bounds[0]<=point[0]&&cell.bounds[2]>=point[0]&&cell.bounds[1]<=point[1]&&cell.bounds[3]>=point[1]);
  const detail=decodeCoverage(read(`../public${cell.levels.source.url}`));
  const polygons=detail.features.filter(f=>f.properties.role==='area').flatMap(f=>f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates);
  const island=polygons.find(p=>p[0].some(p=>p[0]===point[0]&&p[1]===point[1]));
  assert.equal(island[0].length,1110,'all vertices of the pinned source island survive, including the closing vertex');
  assert.ok(detail.features.some(f=>f.properties.role==='territory-boundary'&&f.geometry.type==='MultiLineString'));
  for(const zoom of [7,9,12,15,18]){
    const [x,y]=manifest.regressionSourceVertices.primorsk,width=1440*360/(256*2**zoom),height=width*.45;
    const cells=coverageCells(manifest,[x-width/2,y-height/2,x+width/2,y+height/2],zoom),level=coverageLevel(zoom);
    assert.ok(cells.length>0&&cells.length<=64);assert.ok(cells.reduce((sum,cell)=>sum+cell.levels[level].bytes,0)<MAP_COVERAGE_LIMITS.viewBytes);
  }
  t.diagnostic(`${files} verified lossless bundles; ${bytes} bytes total; source Gogland ring: ${island[0].length} vertices.`);
});

test('bootstrap verifies and decodes the actual overview without downloading detailed leaves',async()=>{
  const manifest=read('../public/data/map-coverage/manifest.json'),calls=[];
  const session=await loadMapCoverage({fetch:async url=>{calls.push(url);return response(readFileSync(new URL(`../public${url}`,import.meta.url)));}});
  assert.equal(session.version,manifest.version);assert.equal(calls.length,2);assert.ok(session.area.features.length>0&&session.mask.features.length>0&&session.boundaries.features.length>0);
  session.dispose();
});

test('canonical masks shift whole antimeridian cells without mutating the display-area positions',()=>{
  const manifest=read('../public/data/map-coverage/manifest.json'),base=decodeCoverage(read('../public/data/map-coverage/base.coverage'));
  const eastern=new Set(manifest.cells.filter(cell=>cell.bounds[0]>=180).map(cell=>cell.id));
  const source=base.features.find(feature=>eastern.has(feature.properties.cell)&&feature.properties.role==='mask'),before=JSON.stringify(source);
  const session=createMapCoverage(manifest,base,{canonicalMask:true});
  const coordinates=value=>typeof value[0]==='number'?[value]:value.flatMap(coordinates);
  for(const feature of session.mask.features){const points=coordinates(feature.geometry.coordinates);assert.ok(points.every(point=>point[0]>=-180&&point[0]<=180));assert.ok(Math.max(...points.map(p=>p[0]))-Math.min(...points.map(p=>p[0]))<=15.0000001);}
  assert.equal(JSON.stringify(source),before);assert.ok(session.area.features.some(feature=>coordinates(feature.geometry.coordinates).some(point=>point[0]>180)));
  assert.deepEqual(coverageCells(manifest,[-179.5,65,-178.5,66],15).map(cell=>cell.id),coverageCells(manifest,[180.5,65,181.5,66],15).map(cell=>cell.id));
  session.dispose();
});
