import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {buildTrailOverlay, simplifyOverlayLine} from '../scripts/build-trail-overlay.mjs';
import {readCatalogueInputs} from '../scripts/build-trail-connections.mjs';
import {decodeOverlayLine, encodeOverlayLine, overlayBoundsIntersect, overlayPartLine, prepareTrailOverlay, trailOverlayParts, TrailOverlayLoader} from '../lib/map-trail-overlay.ts';
import {MapResourcePool} from '../lib/map-resource-pool.ts';
import {rewriteJSON} from '../../tools/pages-preview/paths.mjs';

const web=resolve(import.meta.dirname,'..'),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const turn=()=>new Promise(done=>setImmediate(done));
const waitFor=async predicate=>{const deadline=Date.now()+3000;while(!predicate()&&Date.now()<deadline)await new Promise(done=>setTimeout(done,1));assert.ok(predicate(),'Expected asynchronous loader state did not settle');};
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).buffer;
const input=(id,coordinates,url=`/data/${id}.geojson`)=>{const geometry={type:'MultiLineString',coordinates};return{id,geometryUrl:url,sha256:hash(Buffer.from(bytes(geometry))),geometry};};
const project=points=>{let previous=105;return points.map(([lng,lat])=>{lng+=360*Math.round((previous-lng)/360);previous=lng;return[(lng+180)/360,(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2];});};
const distance=(p,a,b)=>{
  const dx=b[0]-a[0],dy=b[1]-a[1],scale=dx*dx+dy*dy,t=scale?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/scale)):0;
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
};

test('integer encoding preserves exact source points across the dateline and rejects silent quantisation',()=>{
  const line=[[179.9999999,65.1234567],[-179.9999999,65.7654321],[180,65],[19.1234567,44.0000001]];
  assert.deepEqual(decodeOverlayLine(encodeOverlayLine(line)),line);
  assert.throws(()=>encodeOverlayLine([[40.12345678,50],[40.2,50.1]]),/without loss/);
  for(const invalid of ['','_','!!','~~~~~~~~~~~~~~'])assert.throws(()=>decodeOverlayLine(invalid));
  const parts=trailOverlayParts({type:'MultiLineString',coordinates:[line.slice(0,2),[[40,50],[41,51]]]});
  assert.ok(parts[0].bounds[2]-parts[0].bounds[0]<.000001);assert.deepEqual(parts[1].bounds,[40,50,41,51]);
});

test('overview keeps source components, endpoints, short closed loops and aliases without fabricated connecting edges',()=>{
  const first=[[40,50],[40.00001,50.00001],[40.00002,50],[40,50]],second=[[41,50],[42,50]],raw=input('first',[first,second]);
  const catalogue=buildTrailOverlay([raw,{...raw,id:'alias'}],3),prepared=prepareTrailOverlay(catalogue);
  assert.equal(prepared.length,1);assert.deepEqual(prepared[0].ids,['alias','first']);
  assert.equal(prepared[0].prepared.parts.length,2);
  for(const level of [0,1]){const line=overlayPartLine(prepared[0].prepared.parts[0],level);assert.deepEqual(line[0],first[0]);assert.deepEqual(line.at(-1),first.at(-1));assert.equal(new Set(line.map(JSON.stringify)).size,3);}
  assert.deepEqual([0,1].map(level=>overlayPartLine(prepared[0].prepared.parts[1],level)),[second,second]);
  assert.equal(overlayBoundsIntersect([40,50,42,50],[40.5,49.9,41.5,50.1]),true,'A crossing segment remains visible even if both endpoints are offscreen');
  assert.equal(overlayBoundsIntersect([40,50,42,50],[45,49,46,51]),false);
  assert.equal(simplifyOverlayLine(first,8).length,4);
});

test('validated offscreen parts allocate no coordinate arrays and a visible LOD is decoded once',()=>{
  const source=input('lazy',[[[40,50],[40.001,50.002],[40.01,50.01]],[[80,50],[80.01,50.01]]]);
  const prepared=prepareTrailOverlay(buildTrailOverlay([source]))[0].prepared;
  assert.ok(prepared.parts.every(part=>part.lines.length===0));
  const first=overlayPartLine(prepared.parts[0],0);assert.equal(overlayPartLine(prepared.parts[0],0),first);
  assert.equal(prepared.parts[0].lines.length,1);assert.equal(prepared.parts[1].lines.length,0);
  const detailed=overlayPartLine(prepared.parts[0],1);assert.notEqual(detailed,first);assert.equal(overlayPartLine(prepared.parts[0],2),detailed);
});

test('content-addressed catalogue bytes are portable to a Pages prefix without rewriting any source key',()=>{
  const data=buildTrailOverlay([input('a',[[[40,50],[40.01,50.01]]],'/data/routes/a.geojson')]);
  assert.equal(data.sources[0].key,'routes/a.geojson');assert.deepEqual(rewriteJSON(data,'/tropnik/'),data);assert.equal(prepareTrailOverlay(data).length,1);
});

test('every published geometry and source part is present; independent screen-space error is below 0.65 pixels',async()=>{
  const {trails,inputs}=await readCatalogueInputs(),metadata=JSON.parse(await readFile(resolve(web,'lib/trail-overlay.generated.json'),'utf8'));
  const raw=await readFile(resolve(web,'public',metadata.url.slice(1))),data=JSON.parse(raw),prepared=prepareTrailOverlay(data);
  assert.equal(hash(raw),metadata.sha256);assert.match(metadata.url,new RegExp(metadata.sha256.slice(0,16)));
  assert.equal(metadata.catalogueRoutes,trails.length);assert.equal(metadata.geometryRoutes,inputs.length);assert.ok(raw.length<3*1024*1024,'Overview must stay small enough for a single bounded resource');
  assert.deepEqual(prepared.flatMap(source=>source.ids).sort(),inputs.map(source=>source.id).sort());
  const originals=new Map(inputs.map(source=>[source.geometryUrl,source]));let checkedPoints=0,parts=0;
  for(const source of prepared){
    const original=originals.get('/data/'+source.key),expected=trailOverlayParts(original.geometry);
    assert.equal(source.sha256,original.sha256);assert.equal(source.prepared.parts.length,expected.length);
    for(let part=0;part<expected.length;part++){
      const originalLine=expected[part].coordinates,world=project(originalLine);parts++;
      assert.deepEqual(source.prepared.parts[part].bounds,expected[part].bounds);
      for(let level=0;level<2;level++){
        const rendered=overlayPartLine(source.prepared.parts[part],level),indices=[0];let cursor=0;
        assert.deepEqual(rendered[0],originalLine[0]);assert.deepEqual(rendered.at(-1),originalLine.at(-1));
        for(let index=1;index<rendered.length;index++){
          if(index===rendered.length-1)cursor=originalLine.length-1;
          else{cursor++;while(cursor<originalLine.length&&JSON.stringify(originalLine[cursor].slice(0,2))!==JSON.stringify(rendered[index]))cursor++;}
          assert.ok(cursor<originalLine.length,'Every display vertex must be an ordered original coordinate');indices.push(cursor);
        }
        const factor=256*2**metadata.levels[level].maxZoom;
        for(let segment=1;segment<indices.length;segment++)for(let index=indices[segment-1];index<=indices[segment];index++){
          const error=distance(world[index],world[indices[segment-1]],world[indices[segment]])*factor;
          assert.ok(error<=.65001,`${source.key} part ${part}, z${metadata.levels[level].maxZoom}: ${error}px`);checkedPoints++;
        }
      }
    }
  }
  assert.equal(parts,metadata.sourceParts);assert.ok(checkedPoints>metadata.sourcePoints);
});

function loaderFixture(sources){
  const requests=[],changes=[],errors=[],invalidated=[],loader=new TrailOverlayLoader({url:'/data/overview-hash.json',
    load:(url,priority,signal)=>new Promise((resolve,reject)=>requests.push({url,priority,signal,resolve,reject})),
    invalidate:url=>invalidated.push(url),onChange:entries=>changes.push(entries),onError:message=>errors.push(message)});
  const view=(ids,options={})=>loader.update({ids,bounds:[39,49,45,52],zoom:14,...options});
  return{loader,requests,changes,errors,invalidated,view,async ready(ids=sources.map(source=>source.id)){view(ids);assert.equal(requests.length,1);requests[0].resolve(bytes(buildTrailOverlay(sources)));await turn();}};
}

test('overview is one request; close geometry reads are limited, versioned, filtered and cancelled with viewport ownership',async()=>{
  const sources=Array.from({length:4},(_,i)=>input(`route${i}`,[[[40+i,50],[40+i+.01,50.01]]])),env=loaderFixture(sources);
  await env.ready();assert.equal(env.requests.length,3);assert.equal(env.loader.inspect().pending,2);
  assert.ok(env.requests.slice(1).every(request=>sources.some(source=>request.url===`${source.geometryUrl}?v=${source.sha256.slice(0,16)}`)&&request.priority===2));
  assert.equal(env.changes.at(-1).length,4,'All known lines render before detailed geometry arrives');
  const cancelled=env.requests.slice(1);env.view(['route3'],{bounds:[42.9,49,43.2,51]});
  assert.ok(cancelled.every(request=>request.signal.aborted));assert.deepEqual(env.changes.at(-1).map(entry=>entry.ids),[['route3']]);
  for(const request of cancelled)request.resolve(bytes(sources[0].geometry));await turn();
  assert.equal(env.loader.inspect().detailSources,0,'Late cancelled geometry cannot enter the next viewport');
  const current=env.requests.at(-1);current.resolve(bytes(sources[3].geometry));await waitFor(()=>env.loader.inspect().pending===0);
  assert.equal(env.loader.inspect().detailSources,1);assert.equal(env.changes.at(-1)[0].detail.length,1);
  env.view([]);assert.deepEqual(env.changes.at(-1),[]);env.loader.destroy();
});

test('valid but mismatched detail bytes cannot replace overview geometry and a verified retry recovers',async t=>{
  const source=input('a',[[[40,50],[40.01,50.01]]]),env=loaderFixture([source]);t.after(()=>env.loader.destroy());
  await env.ready();const overview=env.changes.at(-1)[0].parts,detail=env.requests.at(-1);
  detail.resolve(bytes({type:'MultiLineString',coordinates:[[[40,50],[44,52]]]}));
  await waitFor(()=>env.loader.inspect().pending===0);
  assert.equal(env.loader.inspect().detailSources,0);assert.equal(env.changes.at(-1)[0].detail,undefined);
  assert.equal(env.changes.at(-1)[0].parts,overview);assert.deepEqual(env.invalidated,[detail.url]);
  assert.match(env.errors.at(-1),/Часть подробных линий/);
  env.loader.retry();const retry=env.requests.at(-1);assert.notEqual(retry,detail);assert.equal(retry.url,detail.url);
  retry.resolve(bytes(source.geometry));await waitFor(()=>env.loader.inspect().pending===0);
  assert.equal(env.loader.inspect().detailSources,1);assert.deepEqual(env.changes.at(-1)[0].detail[0].lines[0],source.geometry.coordinates[0]);assert.equal(env.errors.at(-1),'');
});

test('failed overview can retry; failed close detail keeps the overview and never hides the exact selected route',async()=>{
  const source=input('a',[[[40,50],[40.01,50.01]]]),env=loaderFixture([source]);
  env.view(['a']);env.requests[0].reject(new Error('offline'));await turn();assert.match(env.errors.at(-1),/Линии троп/);
  env.loader.retry();assert.equal(env.requests.length,2);env.requests[1].resolve(bytes(buildTrailOverlay([source])));await turn();
  assert.equal(env.errors.at(-1),'');assert.equal(env.changes.at(-1).length,1);
  env.requests[2].reject(new Error('detail unavailable'));await turn();assert.equal(env.changes.at(-1).length,1);assert.equal(env.changes.at(-1)[0].detail,undefined);
  assert.match(env.errors.at(-1),/Часть подробных линий/,'A failed current detail exposes the existing retry action while retaining the overview');
  env.view(['a'],{selectedId:'a'});const count=env.requests.length;env.loader.retry();assert.equal(env.requests.length,count,'The selected raw track is owned by the selection loader, not fetched twice');
  assert.equal(env.errors.at(-1),'','A failure no longer needed in the current view does not leave a stale message');
  env.loader.destroy();
});

test('unmount cancels overview and cannot publish a late catalogue',async()=>{
  const source=input('a',[[[40,50],[40.01,50.01]]]),env=loaderFixture([source]);env.view(['a']);env.loader.destroy();
  assert.equal(env.requests[0].signal.aborted,true);env.requests[0].resolve(bytes(buildTrailOverlay([source])));await turn();assert.deepEqual(env.changes,[]);
});

test('malformed HTTP 200 cache entries are invalidated and retried over the network, including close detail',async()=>{
  for(const invalid of ['not json',JSON.stringify({version:1,sources:'invalid'})]){
    const source=input('a',[[[40,50],[40.01,50.01]]]),data=buildTrailOverlay([source]),calls=[],changes=[],errors=[];
    let overviewBroken=true,detailBroken=true;
    const pool=new MapResourcePool({fetcher:async(url,options)=>{
      calls.push({url,cache:options.cache});
      if(url==='/data/overview-hash.json')return new Response(overviewBroken?invalid:JSON.stringify(data));
      return new Response(detailBroken?'{}':JSON.stringify(source.geometry));
    }});
    const loader=new TrailOverlayLoader({url:'/data/overview-hash.json',load:(url,priority,signal)=>pool.get(url,priority,signal),invalidate:url=>pool.invalidate(url,{reload:true}),onChange:entries=>changes.push(entries),onError:message=>errors.push(message)});
    loader.update({ids:['a'],bounds:[39,49,41,51],zoom:14});await waitFor(()=>!!errors.at(-1));
    assert.ok(errors.at(-1));assert.equal(pool.has('/data/overview-hash.json'),false);overviewBroken=false;loader.retry();await waitFor(()=>calls.length===3&&loader.inspect().pending===0);
    assert.equal(calls[1].cache,'reload','Retry bypasses the bad HTTP/SW cache instead of only replacing memory');assert.equal(changes.at(-1).length,1);
    const detailUrl=calls.at(-1).url;assert.match(detailUrl,/\.geojson\?v=/);assert.equal(pool.has(detailUrl),false);
    detailBroken=false;loader.retry();await waitFor(()=>loader.inspect().pending===0);
    assert.deepEqual(calls.filter(call=>call.url===detailUrl).map(call=>call.cache),['force-cache','reload']);assert.ok(changes.at(-1)[0].detail);loader.destroy();
  }
});
