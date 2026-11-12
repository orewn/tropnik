import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mapTileIntersectsCoverage} from '../lib/custom-map-coverage.ts';
import {mercatorUnproject} from '../lib/custom-map-camera.ts';
import {createMapCoverage,decodeCoverage} from '../public/maps/map-coverage-lod.js';

const tile={z:4,x:10,y:6},n=2**tile.z;
const ring=points=>points.map(([x,y])=>mercatorUnproject({x:(tile.x+x)/n,y:(tile.y+y)/n}));
const polygon=(outer,...holes)=>({type:'Polygon',coordinates:[outer,...holes].map(ring)});
const box=(left,top,right,bottom)=>[[left,top],[right,top],[right,bottom],[left,bottom],[left,top]];
const intersects=geometry=>mapTileIntersectsCoverage(geometry,tile,18);

test('coverage admission retains tiny islands, enclosing land and narrow crossings with no contained corners or vertices',()=>{
 assert.equal(intersects(polygon(box(.45,.45,.46,.46))),true);
 assert.equal(intersects(polygon(box(-1,-1,2,2))),true);
 assert.equal(intersects(polygon([[-.5,.45],[1.5,.55],[1.5,.6],[-.5,.5],[-.5,.45]])),true);
 assert.equal(intersects(polygon(box(1,.2,1.2,.4))),true,'Touching the real mask boundary is conservatively required');
});

test('overlapping polygon bounds cannot make an ocean tile required, while hole edges retain real land',()=>{
 assert.equal(intersects(polygon([[.8,-.5],[1.5,-.5],[1.5,.2],[.8,-.5]])),false,'The triangle bounds overlap, but its actual Mercator edges miss the tile');
 assert.equal(intersects(polygon(box(-1,-1,2,2),box(-.2,-.2,1.2,1.2))),false,'Every pixel is inside the polygon hole');
 assert.equal(intersects(polygon(box(-1,-1,2,2),box(.2,-.2,1.2,1.2))),true,'The hole boundary crosses visible land');
});

test('two CSS pixels around the tile protect mask antialiasing without changing geographic samples',()=>{
 const zoom=8,margin=2/(256*2**zoom)*n;
 assert.equal(mapTileIntersectsCoverage(polygon(box(1+margin/2,.4,1+margin,.6)),tile,zoom),true);
 assert.equal(mapTileIntersectsCoverage(polygon(box(1+margin*3,.4,1+margin*4,.6)),tile,zoom),false);
 assert.equal(mapTileIntersectsCoverage(polygon(box(.4,1+margin*1.5,.6,1+margin*1.6)),tile,zoom,60),true,'Pitch compression must keep the same two-screen-pixel guard');
});

test('canonical and continuous dateline rings follow the same rendered world as geometryPath',()=>{
 const canonical={type:'Polygon',coordinates:[[[179.7,67],[-179.7,67],[-179.7,67.1],[179.7,67.1],[179.7,67]]]};
 const continuous={type:'Polygon',coordinates:canonical.coordinates.map(r=>r.map(([x,y])=>[x<0?x+360:x,y]))};
 for(const x of [63,64])for(const shape of [canonical,continuous])assert.equal(mapTileIntersectsCoverage(shape,{z:6,x,y:15},8),true);
 assert.equal(mapTileIntersectsCoverage(canonical,{z:6,x:0,y:15},8),false,'The unwrapped renderer does not paint a second mask world at negative longitude');
});

test('unknown or malformed coverage stays required, and immutable replacements get independent indexes',()=>{
 for(const value of [undefined,{}, {type:'Point',coordinates:[50,50]},{type:'Polygon',coordinates:[[[NaN,0],[1,0],[1,1]]]}, {type:'FeatureCollection'}, {type:'Feature',properties:{},geometry:null}])assert.equal(intersects(value),true);
 const absent={type:'FeatureCollection',features:[]},revealed={type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:polygon(box(.5,.5,.51,.51))}]};
 assert.equal(intersects(absent),false);assert.equal(intersects(revealed),true);assert.equal(intersects(absent),false);
});

test('the actual Chukotka coverage masks the observed sparse DEM cells, including a misleading polygon bbox',async()=>{
 const read=url=>readFileSync(new URL('../public'+url,import.meta.url));
 const manifest=JSON.parse(read('/data/map-coverage/manifest.json')),base=decodeCoverage(JSON.parse(read(manifest.base.url)));
 const coverage=createMapCoverage(manifest,base,{fetch:async url=>new Response(read(url))});
 try{
  await coverage.updateView([156.27536453198246,59.701315217699936,194.15257550963855,72.91795683482115],5.272349250356769);
  assert.equal(coverage.status.ready,true);
  for(const x of [60,61,62,63,64,65,66])assert.equal(mapTileIntersectsCoverage(coverage.area,{z:6,x,y:12},5.272349250356769),false,`Sparse DEM 6/${x}/12 is hidden by the actual mask, not by UI padding`);
  for(const [x,y] of [[65,14],[64,18],[64,19]])assert.equal(mapTileIntersectsCoverage(coverage.area,{z:6,x,y},5.272349250356769),false);
  const misleading=coverage.area.features.filter(f=>f.properties.cell==='0c0a-0').flatMap(f=>f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates);
  assert.ok(misleading.some(rings=>rings[0].some(([x])=>x>185.625)&&rings[0].some(([,y])=>y>68.65655498475736)),'The recorded ocean tile really overlaps the mainland polygon bounds');
  const required={12:[],13:[59,60,63,64],14:[59,60,61,62,63,64],15:[59,60,61,62,63,64,65],16:[59,60,61,62,63,64,65],17:[59,60,61,62,63],18:[59,60,61,62]};
  for(let y=12;y<=18;y++)for(let x=59;x<=66;x++)assert.equal(mapTileIntersectsCoverage(coverage.area,{z:6,x,y},5.272349250356769),required[y].includes(x),`The measured mask footprint at 6/${x}/${y} must be preserved`);
 }finally{coverage.dispose();}
});
