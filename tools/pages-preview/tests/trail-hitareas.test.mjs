import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inspectTrailTouchTargets} from '../browser-trail-hitareas.mjs';
import {projectMapPoint} from '../map-projection.mjs';

// The actual route source and camera/viewport from the failed Candidate4 audit.
// All four independently projected +/-14px points fall in the route's 44px
// native button; a Canvas-only test rejected every one before sending input.
const catalogue=JSON.parse(readFileSync(new URL('../../../web/lib/catalog.generated.json',import.meta.url),'utf8'));
const route=(Array.isArray(catalogue)?catalogue:catalogue.routes).find(trail=>trail.id==='osm-relation-6040458');
const camera={longitude:87.29202911663077,latitude:50.49999999999999,zoom:9.1,tileSize:256,centerX:520.5,centerY:464};
const viewport={left:384,top:72,width:1041,height:928,right:1425,bottom:1000};
const projected=projectMapPoint(route.center,camera,viewport);
const points=[[14,0],[-14,0],[0,14],[0,-14]].map(([dx,dy])=>({x:projected.x+dx,y:projected.y+dy,id:route.id,title:route.title,center:route.center,geometryUrl:route.geometryUrl,offset:Math.hypot(dx,dy)}));
const rect={left:projected.x-22,top:projected.y-22,right:projected.x+22,bottom:projected.y+22,width:44,height:44};
function fixture({kind='button',id=route.id,markerId=id,foreign=false,disabled=false,hidden=false,ownClass=true}={}){
 const map={dataset:{mapEngine:'tropnik-canvas'},contains:node=>!foreign&&[button,child,canvas].includes(node)};
 const button={tagName:'BUTTON',dataset:{trailId:id,mapMarkerId:markerId},disabled,hidden,getBoundingClientRect:()=>rect};
 const closest=selector=>ownClass&&selector==='button.tropnik-point-marker--trail[data-trail-id]'?button:null;
 button.closest=closest;
 const child={tagName:'SPAN',closest};
 const canvas={tagName:'CANVAS'};
 const overlay={tagName:'DIV',closest:()=>null};
 let probes=0;
 const doc={querySelector:selector=>selector==='.atlas-canvas[data-map-engine]'?map:null,elementFromPoint:()=>{probes++;return{button,child,canvas,overlay}[kind];}};
 return{doc,win:{innerWidth:1440,innerHeight:1000},map,button,probes:()=>probes};
}

test('the real Altai route accepts its 44px native marker at the independently projected 14px touch offset',()=>{
 assert.ok(route.geometryUrl.startsWith('/data/'));
 const env=fixture();
 const run=new Function('points','document','window',`return (${inspectTrailTouchTargets.toString()})(points);`);
 const targets=run(points,env.doc,env.win);
 assert.equal(targets.length,4);assert.equal(env.probes(),4);
 assert.equal(points.filter(point=>env.doc.elementFromPoint(point.x,point.y)?.tagName==='CANVAS').length,0,'reproduce the previous Canvas-only rejection');
 for(const [index,target]of targets.entries()){
  assert.deepEqual({...target,hit:undefined},{...points[index],hit:undefined},'inspection must not move the source-derived target');
  assert.equal(target.offset,14);assert.equal(target.id,route.id);
  assert.deepEqual(target.hit,{kind:'trail-marker',trailId:route.id,rect});
 }
 assert.equal(inspectTrailTouchTargets(points,fixture({kind:'child'}).doc,env.win).length,4,'a painted child belongs only to its exact route button');
});

test('overlapping routes, controls, panels and inactive or foreign buttons never become route targets',()=>{
 for(const options of [{id:'other-route'},{markerId:'stale-route'},{ownClass:false},{disabled:true},{hidden:true},{foreign:true},{kind:'overlay'}]){
  const env=fixture(options);assert.deepEqual(inspectTrailTouchTargets(points,env.doc,env.win),[],JSON.stringify(options));
 }
 const wrongBounds=fixture();wrongBounds.button.getBoundingClientRect=()=>({...rect,left:rect.right,right:rect.right+44});
 assert.deepEqual(inspectTrailTouchTargets(points,wrongBounds.doc,wrongBounds.win),[],'a stale marker rectangle does not override the independent geographic point');
});

test('uncovered map Canvas remains eligible while offscreen and nonfinite source projections are rejected without probing',()=>{
 const env=fixture({kind:'canvas'}),targets=inspectTrailTouchTargets(points,env.doc,env.win);
 assert.equal(targets.length,4);assert.ok(targets.every(target=>target.hit.kind==='canvas'));
 const foreign=fixture({kind:'canvas',foreign:true});assert.deepEqual(inspectTrailTouchTargets(points,foreign.doc,foreign.win),[]);
 const outside=fixture(),invalid=[{x:11,y:100},{x:1430,y:100},{x:100,y:990},{x:NaN,y:100},{x:100,y:Infinity}];
 assert.deepEqual(inspectTrailTouchTargets(invalid,outside.doc,outside.win),[]);assert.equal(outside.probes(),0);
});
