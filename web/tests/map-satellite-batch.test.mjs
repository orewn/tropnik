import test from 'node:test';
import assert from 'node:assert/strict';
import {SatelliteTileBatch,satelliteTileInView,satelliteTileIntersectsView} from '../lib/map-satellite-tiles.ts';

const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('a long uninterrupted pan releases decoded offscreen grids without publishing a partial current grid',async()=>{
 let current=new Set(),settled=false,creating=false;
 const commits=[],errors=[];
 const batch=new SatelliteTileBatch({current:token=>current.has(token),settled:()=>settled,maxPending:3});
 const complete=token=>error=>{
  assert.equal(creating,false,'SDK completion cannot reenter createTile');
  if(error){errors.push(error);return;}
  assert.ok(settled||!current.has(token),'a current image must stay hidden while the camera moves');
  commits.push(token);
 };
 for(let view=0;view<200;view++){
  current=new Set([`${view}:a`,`${view}:b`,`${view}:c`]);
  creating=true;
  for(const token of current){batch.add(token,complete(token));batch.loaded(token);}
  creating=false;
  // All old images may already be decoded when GridLayer synchronously adds
  // the next viewport. Admission must first let those old callbacks prune.
  await turn();
  assert.deepEqual(errors,[]);
  assert.equal(commits.length,view*3);
 }
 settled=true;batch.schedule();await turn();
 assert.equal(commits.length,600);
 assert.equal(new Set(commits).size,600);
 batch.dispose();
});

test('moving offscreen ready images cannot wait behind one slow current image',async()=>{
 let current=new Set(['old','slow']),settled=false;
 const commits=[];
 const batch=new SatelliteTileBatch({current:token=>current.has(token),settled:()=>settled,maxPending:2});
 batch.add('old',error=>commits.push(['old',error]));batch.loaded('old');
 batch.add('slow',error=>commits.push(['slow',error]));await turn();
 assert.deepEqual(commits,[]);
 current=new Set(['slow']);batch.schedule();await turn();
 assert.deepEqual(commits,[['old',undefined]]);
 batch.loaded('slow');await turn();assert.equal(commits.length,1);
 settled=true;batch.schedule();await turn();
 assert.deepEqual(commits,[['old',undefined],['slow',undefined]]);
 batch.dispose();
});

test('queued admission cancellation and disposal cannot emit late SDK errors',async()=>{
 const results=[];
 const batch=new SatelliteTileBatch({current:()=>true,settled:()=>false,maxPending:1});
 batch.add('active',error=>results.push(['active',error]));
 batch.add('aborted-before-create-returns',error=>results.push(['aborted',error]));
 batch.remove('aborted-before-create-returns');await turn();
 assert.deepEqual(results,[]);
 batch.add('disposed-before-flush',error=>results.push(['disposed',error]));
 batch.dispose();await turn();assert.deepEqual(results,[]);
});

test('an unavoidable backlog reports an asynchronous error after SDK tile registration',async()=>{
 const completed=[],registered=new Set();
 const batch=new SatelliteTileBatch({current:()=>true,settled:()=>false,maxPending:2});
 for(const token of ['a','b','c']){
  batch.add(token,error=>{
   assert.equal(registered.has(token),true,'the SDK record must exist before completion');
   completed.push([token,error]);
  });
  registered.add(token);
 }
 assert.deepEqual(completed,[]);await turn();
 assert.equal(completed.length,1);assert.equal(completed[0][0],'c');
 assert.match(completed[0][1].message,/queue exceeded/);
 batch.dispose();
});

test('a resized viewport can admit its larger native grid without changing an existing batch',async()=>{
 let capacity=2;
 const completed=[];
 const batch=new SatelliteTileBatch({current:()=>true,settled:()=>true,maxPending:()=>capacity});
 for(const token of ['a','b'])batch.add(token,error=>completed.push([token,error]));
 capacity=4;
 for(const token of ['c','d'])batch.add(token,error=>completed.push([token,error]));
 for(const token of ['a','b','c','d'])batch.loaded(token);
 await turn();assert.deepEqual(completed,[['a',undefined],['b',undefined],['c',undefined],['d',undefined]]);
 batch.dispose();
});

test('a decoded parent still covering the screen waits for the new native grid after zoom-in',async()=>{
 const view={left:6*256,top:4*256,right:8*256,bottom:6*256,zoom:4};
 const parent={x:3,y:2,z:3},childA={x:6,y:4,z:4},childB={x:7,y:5,z:4};
 const commits=[];
 const batch=new SatelliteTileBatch({current:tile=>satelliteTileInView(tile,view),
  intersectsView:tile=>satelliteTileIntersectsView(tile,view),settled:()=>true});
 for(const tile of [parent,childA,childB])batch.add(tile,error=>commits.push([tile,error]));
 batch.loaded(parent);batch.loaded(childA);await turn();
 assert.equal(satelliteTileInView(parent,view),false,'parent is not a required native-grid tile');
 assert.equal(satelliteTileIntersectsView(parent,view),true,'parent pixels still cover the current screen');
 assert.deepEqual(commits,[],'neither parent nor partial child grid may become visible yet');
 batch.loaded(childB);await turn();
 assert.deepEqual(commits,[[parent,undefined],[childA,undefined],[childB,undefined]]);
 batch.dispose();
});

test('visibility across native zooms preserves antimeridian copies and fractional-pixel intersections',()=>{
 const dateline={left:7*256,top:2*256,right:9*256,bottom:4*256,zoom:3};
 for(const x of [3,0])assert.equal(satelliteTileIntersectsView({x,y:1,z:2},dateline),true);
 assert.equal(satelliteTileIntersectsView({x:1,y:1,z:2},dateline),false);
 // A tiny piece of a tile can remain visible during a fractional zoom. The
 // right edge is half-open, not an integer pixel minus one at another zoom.
 const edge={left:6*256,top:4*256,right:8*256+.25,bottom:6*256,zoom:4};
 assert.equal(satelliteTileIntersectsView({x:4,y:2,z:3},edge),true);
 assert.equal(satelliteTileIntersectsView({x:4,y:2,z:3},{...edge,right:8*256}),false);
 assert.equal(satelliteTileIntersectsView({x:12,y:8,z:5},edge),true,'higher-resolution child can also remain visible');
});
