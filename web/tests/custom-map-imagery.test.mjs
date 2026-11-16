import test from 'node:test';
import assert from 'node:assert/strict';
import {retainImageryFallback} from '../lib/custom-map-imagery.ts';

let serial=0,closed=0;
function tile(z,x,y,kind='eox-s2'){
  return Object.freeze({key:`${kind}:${z}/${x}/${y}:${++serial}`,kind,z,x,y,local:false,labels:Object.freeze([]),contours:0,
    bitmap:Object.freeze({width:512,height:512,close(){closed++;}})});
}
const request=(z,x,y,kind='eox-s2')=>({kind,z,x,y});
const children=(z,x,y,kind='eox-s2')=>[[0,0],[1,0],[0,1],[1,1]].map(([dx,dy])=>tile(z+1,x*2+dx,y*2+dy,kind));
// Independent exact-cell oracle for small fixtures. At the finest input zoom,
// every source rectangle is a union of these cells; no quadtree code is reused.
function coveredCells(tiles,requests){
  const z=Math.max(...tiles.map(value=>value.z),...requests.map(value=>value.z)),cells=new Set();
  for(const view of requests){
    const factor=2**(z-view.z);
    for(let y=view.y*factor;y<(view.y+1)*factor;y++)for(let x=view.x*factor;x<(view.x+1)*factor;x++){
      const px=(x+.5)/2**z,py=(y+.5)/2**z;
      if(tiles.some(value=>value.kind===view.kind&&px>=value.x/2**value.z&&px<(value.x+1)/2**value.z&&py>=value.y/2**value.z&&py<(value.y+1)/2**value.z))cells.add(`${x}/${y}`);
    }
  }
  return cells;
}
function preserves(previous,result,requests){
  // Use the same finest partition for both independently computed masks.
  const gridZoom=Math.max(...previous.map(value=>value.z),...result.map(value=>value.z),...requests.map(value=>value.z));
  const grid=requests.flatMap(value=>{
    const factor=2**(gridZoom-value.z),cells=[];
    for(let y=value.y*factor;y<(value.y+1)*factor;y++)for(let x=value.x*factor;x<(value.x+1)*factor;x++)cells.push({...value,z:gridZoom,x,y});
    return cells;
  });
  const before=coveredCells(previous,grid),after=coveredCells(result,grid);
  assert.ok([...before].every(cell=>after.has(cell)),'every previously covered visible cell must remain covered');
}
function realObjects(result,...sources){
  const available=new Set(sources.flat());
  assert.ok(result.every(value=>available.has(value)),'every returned tile is an original source object');
  assert.ok(result.every((value,index)=>index===0||result[index-1].z<=value.z),'draw order is stable coarse to fine');
}

test('retained imagery preserves original objects and input arrays without closing bitmaps',()=>{
  const beforeClosed=closed,parent=tile(2,1,1),fine=tile(3,2,2),previous=Object.freeze([parent]),ready=Object.freeze([fine]),requests=Object.freeze([request(2,1,1)]);
  const result=retainImageryFallback(previous,ready,requests);
  assert.deepEqual(result,[parent,fine]);assert.deepEqual(previous,[parent]);assert.deepEqual(ready,[fine]);
  assert.equal(closed,beforeClosed);realObjects(result,previous,ready);preserves(previous,result,requests);
  const repeated=retainImageryFallback(result,ready,requests);
  assert.deepEqual(repeated,result);assert.equal(repeated[0],parent);assert.equal(repeated[1],fine);
});

test('complete real siblings replace their parent atomically at the fallback limit',()=>{
  const parent=tile(2,1,1),ready=children(2,1,1),requests=[request(2,1,1)];
  const result=retainImageryFallback([parent],ready,requests,4);
  assert.deepEqual(result,ready);assert.equal(result.length,4);assert.ok(!result.includes(parent));
  preserves([parent],result,requests);realObjects(result,[parent],ready);
});

test('partial siblings never remove a parent that still covers a gap',()=>{
  const parent=tile(2,1,1),ready=children(2,1,1).slice(0,3),requests=[request(2,1,1)];
  for(const limit of [1,2,3,4]){
    const result=retainImageryFallback([parent],ready,requests,limit);
    assert.ok(result.includes(parent));assert.ok(result.length<=limit);preserves([parent],result,requests);realObjects(result,[parent],ready);
  }
});

test('mixed-depth complete descendants prove coverage without inventing a parent bitmap',()=>{
  const parent=tile(2,1,1),siblings=children(2,1,1),ready=[...siblings.slice(0,3),...children(3,3,3)],requests=[request(2,1,1)];
  const result=retainImageryFallback([parent],ready,requests,7);
  assert.equal(result.length,7);assert.ok(!result.includes(parent));assert.deepEqual(result,ready);
  preserves([parent],result,requests);realObjects(result,[parent],ready);
});

test('zooming out can replace real fine cells with one available real parent',()=>{
  const previous=children(3,3,2),parent=tile(3,3,2),requests=[request(3,3,2)];
  const result=retainImageryFallback(previous,[parent],requests,4);
  assert.deepEqual(result,[parent]);preserves(previous,result,requests);realObjects(result,previous,[parent]);
});

test('negative x and dateline world copies keep their original geometry',()=>{
  for(const x of [-1,4]){
    const parent=tile(2,x,1),ready=children(2,x,1),requests=[request(2,x,1)];
    const result=retainImageryFallback([parent],ready,requests,4);
    assert.deepEqual(result,ready);preserves([parent],result,requests);
    assert.ok(result.every(value=>Math.floor(value.x/2)===x));
  }
  const west=tile(2,-1,1),east=tile(2,3,1),requests=[request(2,-1,1)];
  assert.deepEqual(retainImageryFallback([west,east],[],requests),[west],'equal canonical source x cannot alias different world-copy geometry');
});

test('a rotated viewport request set prunes invisible corners without using its bounding rectangle',()=>{
  const requests=[[3,2],[2,3],[3,3],[4,3],[3,4]].map(([x,y])=>request(3,x,y));
  const previous=[tile(3,3,2),tile(3,2,3),tile(3,3,3),tile(3,4,3),tile(3,3,4),tile(3,2,2),tile(3,4,2)];
  const result=retainImageryFallback(previous,[],requests);
  assert.deepEqual(result,previous.slice(0,5));preserves(previous,result,requests);
});

test('new visible coverage takes room from redundant old detail before an uncovered cell is lost',()=>{
  const parent=tile(2,0,0),fine=tile(3,0,0),next=tile(2,1,0),previous=[parent,fine],requests=[request(2,0,0),request(2,1,0)];
  const result=retainImageryFallback(previous,[next],requests,2);
  assert.deepEqual(result,[parent,next]);preserves(previous,result,requests);realObjects(result,previous,[next]);
});

test('a full 64-cell fallback keeps coverage when partial refinements cannot fit',()=>{
  const previous=Array.from({length:64},(_,index)=>tile(4,index%8,Math.floor(index/8)));
  const ready=previous.map(value=>tile(5,value.x*2,value.y*2)),requests=ready.map(({z,x,y,kind})=>({z,x,y,kind}));
  const result=retainImageryFallback(previous,ready,requests);
  assert.deepEqual(result,previous);assert.equal(result.length,64);preserves(previous,result,requests);realObjects(result,previous,ready);
  const replacements=previous.map(value=>tile(value.z,value.x,value.y));
  const exact=retainImageryFallback(previous,replacements,previous.map(({z,x,y,kind})=>({z,x,y,kind})));
  assert.deepEqual(exact,replacements,'exact replacements do not need an extra slot at the cap');
});

test('provider mismatches and invalid cells or bitmap dimensions never enter the fallback',()=>{
  const source=tile(3,3,2),wrongProvider=tile(3,3,2,'eox-bluemarble'),invalid={...source,z:15},closedBitmap={...source,bitmap:{width:0,height:0}},fractional={...source,x:3.5},requests=[request(3,3,2)];
  assert.deepEqual(retainImageryFallback([source,wrongProvider,invalid,closedBitmap,fractional],[wrongProvider],requests),[source]);
  assert.deepEqual(retainImageryFallback([source],[wrongProvider],[request(3,3,2,'eox-bluemarble')]),[wrongProvider]);
  for(const bad of [[],[request(3,3,2),request(3,4,2,'eox-bluemarble')],[request(3,3,2),request(4,6,4)],[request(3,3,-1)],[request(3,3,8)],[request(3,NaN,2)],[request(9,3,2,'eox-bluemarble')]]){
    assert.deepEqual(retainImageryFallback([source],[],bad),[]);
  }
  assert.deepEqual(retainImageryFallback([source],[],requests,0),[]);
  assert.deepEqual(retainImageryFallback([source],[],requests,NaN),[]);
});

test('huge source zoom differences use bounded ancestry and retain a real coarse fallback',()=>{
  const parent=tile(0,0,0),child=tile(14,10000,7000),requests=[request(14,10000,7000)];
  const result=retainImageryFallback([parent],[child],requests);
  assert.deepEqual(result,[parent,child]);realObjects(result,[parent],[child]);
});

test('duplicate cells are stable and oversized malformed input is bounded without fabricated images',()=>{
  const previous=Array.from({length:65},(_,index)=>tile(7,index,40)),requests=[request(0,0,0)];
  const result=retainImageryFallback(previous,[],requests,100);
  assert.equal(result.length,64);realObjects(result,previous);
  const first=tile(3,3,2),second=tile(3,3,2),replacement=tile(3,3,2),view=[request(3,3,2),request(3,3,2)];
  assert.deepEqual(retainImageryFallback([first,second],[],view),[second]);
  assert.deepEqual(retainImageryFallback([first,second],[replacement],view),[replacement]);
});

test('bounded mixed-generation mosaics preserve visible coverage across deterministic zoom and pan cases',()=>{
  let state=0x1935a7;
  const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
  for(let scenario=0;scenario<120;scenario++){
    const requests=Array.from({length:8},(_,index)=>request(3,(scenario%3-1)*8+2+index%4,2+Math.floor(index/4)));
    const make=()=>{
      const view=requests[next()%requests.length],z=2+next()%4,factor=2**(z-view.z);
      return tile(z,Math.floor(view.x*factor)+(z>view.z?next()%factor:0),Math.floor(view.y*factor)+(z>view.z?next()%factor:0));
    };
    const previous=Array.from({length:1+next()%8},make),ready=Array.from({length:next()%17},make),result=retainImageryFallback(previous,ready,requests,8);
    assert.ok(result.length<=8);preserves(previous,result,requests);realObjects(result,previous,ready);
  }
});
