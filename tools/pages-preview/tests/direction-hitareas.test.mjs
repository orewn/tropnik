import test from 'node:test';
import assert from 'node:assert/strict';
import {directionHitGrid,directionExternalPoint,inspectDirectionHitAreas} from '../browser-direction-hitareas.mjs';
import {assertDirectionHitGrid,assertDirectionHitAreas} from '../browser-report.mjs';
import {hitRect,directionGridFixture,directionHitAreasFixture} from './direction-hitareas-fixture.mjs';

test('inner-corner/edge grids choose actual painted areas outside the44px anchor',()=>{
 const grid=directionGridFixture();
 assert.deepEqual(directionHitGrid(grid.surfaces[0].rect,grid.anchorRect).map(point=>point.name),['nw','n','ne','e','se','s','sw','w']);
 const label=directionExternalPoint(grid,'label'),count=directionExternalPoint(grid,'count');
 assert.ok(label.y>grid.anchorRect.bottom);
 assert.ok(count.x>grid.anchorRect.right);
 assert.equal(label.name,'s');assert.equal(count.name,'e');
 grid.surfaces[1].samples.forEach(point=>{point.owned=false;});
 assert.equal(directionExternalPoint(grid,'count'),null,'an intercepted count must never fall back to the anchor centre');
 grid.surfaces[0].visible=false;
 assert.equal(directionExternalPoint(grid,'label'),null,'a hidden label is not a clickable target');
});

function dom({engine='tropnik-canvas',labelHidden=false,countPassThrough=false,hiddenFootprint=false}={}){
 const original=directionGridFixture('altai',engine),canvas={tagName:'CANVAS',closest:()=>null};
 const styles=new Map(),visible={display:'block',visibility:'visible',opacity:'1',pointerEvents:'auto'};
 const button={tagName:'BUTTON',hidden:false,dataset:{regionId:'altai',mapGroupKey:'altai'},classList:{contains:()=>false},getBoundingClientRect:()=>original.anchorRect,getAttribute:()=>original.ariaLabel};
 const surfaces=original.surfaces.map(surface=>{
  const node={tagName:'SPAN',textContent:surface.text,getBoundingClientRect:()=>surface.rect,closest:selector=>selector==='.region-marker'?button:null};
  styles.set(node,{...visible,visibility:surface.kind==='label'&&labelHidden?'hidden':'visible',pointerEvents:surface.kind==='count'&&countPassThrough?'none':'auto'});
  return{kind:surface.kind,node,rect:surface.rect};
 });
 button.querySelector=selector=>surfaces.find(surface=>selector===`.region-marker-${surface.kind}`)?.node;
 button.closest=selector=>selector==='.region-marker'?button:null;styles.set(button,visible);
 const hidden={tagName:'BUTTON',hidden:true,dataset:{regionId:'inactive'},getBoundingClientRect:()=>hiddenFootprint?hitRect(200,200,44,44):hitRect(0,0,0,0),closest:()=>null};
 styles.set(hidden,{...visible,display:hiddenFootprint?'block':'none'});
 const atlas={dataset:{mapEngine:engine},getBoundingClientRect:()=>hitRect(0,0,500,500),querySelectorAll:()=>[button,hidden]};
 const contains=(r,x,y)=>x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom;
 let probes=0;
 const doc={querySelector:()=>atlas,elementFromPoint:(x,y)=>{
  probes++;
  for(const surface of surfaces)if(contains(surface.rect,x,y)&&styles.get(surface.node).visibility!=='hidden'&&styles.get(surface.node).pointerEvents!=='none')return surface.node;
  return contains(original.anchorRect,x,y)?button:canvas;
 }};
 const win={innerWidth:500,innerHeight:500,getComputedStyle:node=>styles.get(node)};
 return{doc,win,probes:()=>probes};
}

test('the serialized read-only browser inspector measures external surfaces and inactive custom controls',()=>{
 const browserRead=new Function('document','window',`const directionHitGrid=${directionHitGrid.toString()};return (${inspectDirectionHitAreas.toString()})('altai');`);
 const fake=dom(),grid=browserRead(fake.doc,fake.win);
 assert.equal(fake.probes(),16,'eight points for each visible external surface');
 assert.equal(assertDirectionHitGrid(grid,'fixture','tropnik-canvas'),grid);
 const hidden=dom({labelHidden:true}),hiddenGrid=browserRead(hidden.doc,hidden.win);
 assert.equal(hiddenGrid.surfaces[0].visible,false);assert.deepEqual(hiddenGrid.surfaces[0].samples,[]);
 assert.equal(assertDirectionHitGrid(hiddenGrid,'hidden-label','tropnik-canvas'),hiddenGrid,'hidden labels under overlays must not be reported as hit failures');
 assert.equal(hidden.probes(),8);
});

test('real DOM-grid failures are detected for passing-through counters and inactive controls',()=>{
 for(const options of [{countPassThrough:true},{hiddenFootprint:true}]){
  const fake=dom(options),grid=inspectDirectionHitAreas('altai',fake.doc,fake.win);
  assert.throws(()=>assertDirectionHitGrid(grid,'broken','tropnik-canvas'));
 }
 const fake=dom({engine:'tropnik-canvas'}),grid=inspectDirectionHitAreas('altai',fake.doc,fake.win);
 assert.equal(fake.probes(),16);assert.equal(grid.hiddenControls[0].wrapper,null);
 assert.equal(assertDirectionHitGrid(grid,'webgl','tropnik-canvas'),grid);
});

test('both pointer profiles require native external ordinary-label and count actions with a real state change',()=>{
 for(const [engine,mobile] of [['tropnik-canvas',true],['tropnik-canvas',false]]){
  const receipt=directionHitAreasFixture(engine,mobile);
  assert.equal(assertDirectionHitAreas(receipt,'fixture',engine,mobile),receipt);
  const count=receipt.actions[1];count.grid.cluster=true;count.grid.groupKey='baikal|other';count.point.groupKey=count.grid.groupKey;
  count.events.forEach(event=>{event.button.groupKey=count.grid.groupKey;});count.after={region:'',route:'',zoom:3};
  assert.equal(assertDirectionHitAreas(receipt,'cluster',engine,mobile),receipt,'native count input may instead expand its actual cluster');
  count.after.zoom=2.2;assert.throws(()=>assertDirectionHitAreas(receipt,'cluster',engine,mobile),/did not expand/);
 }
});

test('pass flags cannot hide an incomplete grid, wrong target, synthetic input or unchanged selection',()=>{
 const changes=[
  receipt=>delete receipt.schemaVersion,
  receipt=>receipt.actions[0].grid.surfaces[0].samples.pop(),
  receipt=>receipt.actions[0].grid.surfaces[0].samples[0].owned=false,
  receipt=>receipt.actions[0].grid.surfaces[0].samples[0].hitRegionId='other',
  receipt=>receipt.actions[0].grid.surfaces[0].samples[0].withinViewport=false,
  receipt=>receipt.actions[0].grid.surfaces[0].samples[0].x+=10,
  receipt=>receipt.actions[0].grid.surfaces[0].pointerEvents='none',
  receipt=>receipt.actions[0].grid.hiddenControls[0].display='block',
  receipt=>{receipt.actions[0].grid.hiddenControls[0].rect=hitRect(200,200,44,44);},
  receipt=>receipt.actions.forEach(action=>{action.grid.hiddenControls=[];}),
  receipt=>receipt.actions[0].point.y=122,
  receipt=>receipt.actions[0].events[2].trusted=false,
  receipt=>receipt.actions[0].events[1].button.regionId='other',
  receipt=>receipt.actions[0].events[1].button.groupKey='altai|stale',
  receipt=>receipt.actions[0].events[0].y=122,
  receipt=>receipt.actions[0].after.region='',
  receipt=>receipt.actions[0].before.region='altai',
  receipt=>receipt.actions[1].after.region='altai',
 ];
 for(const change of changes){const receipt=directionHitAreasFixture();change(receipt);assert.throws(()=>assertDirectionHitAreas(receipt,'invalid','tropnik-canvas',true));}
 const hidden=directionHitAreasFixture();hidden.actions[1].grid.surfaces[0].visible=false;hidden.actions[1].grid.surfaces[0].samples=[];
 assert.equal(assertDirectionHitAreas(hidden,'hidden-label','tropnik-canvas',true),hidden,'an independently clicked count need not expose a collision-hidden label');
});
