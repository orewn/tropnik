import test from 'node:test';
import assert from 'node:assert/strict';
import {projectMapPoint,unprojectMapPoint,pointInPolygonGeometry} from '../map-projection.mjs';

const rect={left:100,top:72,width:800,height:600};
test('map pointer projection uses CSS pixels and the actual renderer tile size',()=>{
 for(const tileSize of [256,512]){
  const camera={longitude:0,latitude:0,zoom:0,tileSize};
  assert.deepEqual(projectMapPoint([0,0],camera,rect),{x:500,y:372});
  assert.deepEqual(projectMapPoint([90,0],camera,rect),{x:500+tileSize/4,y:372});
 }
});
test('projected touch locations round trip at route zoom and across the display meridian',()=>{
 for(const tileSize of [256,512]){
  const camera={longitude:86.8,latitude:50.5,zoom:9.25,tileSize},point=[86.8930525,51.119775];
  const projected=projectMapPoint(point,camera,rect),restored=unprojectMapPoint(projected,camera,rect);
  assert.ok(Math.abs(restored[0]-point[0])<1e-9);
  assert.ok(Math.abs(restored[1]-point[1])<1e-9);
  assert.equal(projectMapPoint([-175,50],{...camera,longitude:185,latitude:50},rect).x,500);
 }
 assert.throws(()=>projectMapPoint([0,0],{longitude:NaN,latitude:0,zoom:1,tileSize:256},rect));
});
test('retained camera padding uses the actual noncentral projection origin',()=>{
 const camera={longitude:86.8,latitude:50.5,zoom:7.25,tileSize:512,centerX:560,centerY:205};
 assert.deepEqual(projectMapPoint([camera.longitude,camera.latitude],camera,rect),{x:660,y:277});
 const point=[86.8930525,51.119775],restored=unprojectMapPoint(projectMapPoint(point,camera,rect),camera,rect);
 assert.ok(Math.abs(restored[0]-point[0])<1e-9);
 assert.ok(Math.abs(restored[1]-point[1])<1e-9);
 assert.throws(()=>projectMapPoint(point,{...camera,centerY:NaN},rect),/origin/);
});
test('polygon touch fixtures exclude holes and accept a separate multipolygon part',()=>{
 const outer=[[0,0],[10,0],[10,10],[0,10],[0,0]],hole=[[3,3],[7,3],[7,7],[3,7],[3,3]];
 const geometry={type:'MultiPolygon',coordinates:[[outer,hole],[[[20,20],[22,20],[22,22],[20,22],[20,20]]]]};
 assert.equal(pointInPolygonGeometry([1,1],geometry),true);
 assert.equal(pointInPolygonGeometry([5,5],geometry),false);
 assert.equal(pointInPolygonGeometry([15,15],geometry),false);
 assert.equal(pointInPolygonGeometry([21,21],geometry),true);
});
