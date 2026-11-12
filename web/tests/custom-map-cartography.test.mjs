import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARTOGRAPHY,paintVectorTile} from '../lib/custom-map-painter.ts';
import {decodeVectorTile} from '../lib/custom-map-vector.ts';
import {drawMapLabel,mapLabelLayout,mapLabelPriority,mapLabelRepeatDistance,mapLabelRepeatKey,mapLabelStyle} from '../lib/custom-map-labels.ts';

class Context {
  strokes=[];fills=[];rectangles=[];texts=[];path=[];dash=[];
  clearRect(){}beginPath(){this.path=[];}
  fillRect(...rect){this.rectangles.push({rect,color:this.fillStyle});}
  moveTo(x,y){this.path.push(['M',x,y]);}lineTo(x,y){this.path.push(['L',x,y]);}closePath(){this.path.push(['Z']);}
  roundRect(...values){this.path.push(['R',...values]);}
  setLineDash(value){this.dash=[...value];}
  fill(rule){this.fills.push({path:this.path,rule,color:this.fillStyle});}
  stroke(){this.strokes.push({path:this.path,color:this.strokeStyle,width:this.lineWidth,dash:[...this.dash],cap:this.lineCap});}
  fillText(value,x,y){this.texts.push({value,x,y,color:this.fillStyle});}
}
const archive=path=>decodeVectorTile(readFileSync(new URL(`../public/offline-map/localtiles/${path}`,import.meta.url)));
const layer=(name,features,extent=4096)=>({name,extent,features});
const line=(y,properties)=>({type:2,properties,geometry:[[{x:100,y},{x:3900,y}]]});
const point=(x,y,properties)=>({type:1,properties,geometry:[[{x,y}]]});
const polygon=properties=>({type:3,properties,geometry:[[{x:0,y:0},{x:4096,y:0},{x:4096,y:4096},{x:0,y:4096},{x:0,y:0}]]});
const pathFor=(feature,extent=4096,size=512)=>feature.geometry.flatMap(part=>part.map((point,index)=>[index?'L':'M',point.x*size/extent,point.y*size/extent]).concat(feature.type===3?[['Z']]:[]));
const strokesFor=(context,feature)=>context.strokes.filter(value=>JSON.stringify(value.path)===JSON.stringify(pathFor(feature)));

test('real archived scrub, scree and bare rock retain their recorded cover class instead of becoming generic grass or green land',()=>{
  const tile=archive('10/626/373.pbf'),cover=tile.layers.landcover;
  const categories=[['wood','wood',CARTOGRAPHY.forest],['grass','grassland',CARTOGRAPHY.grass],['grass','scrub',CARTOGRAPHY.scrub],['grass','fell',CARTOGRAPHY.scrub],['rock','bare_rock',CARTOGRAPHY.rock],['rock','scree',CARTOGRAPHY.rock],['ice','glacier',CARTOGRAPHY.glacier]];
  const features=categories.map(([category,subclass])=>cover.features.find(feature=>feature.type===3&&feature.properties.class===category&&feature.properties.subclass===subclass));
  assert.ok(features.every(Boolean),'The regression must use real recorded classes, not invented test source coverage');
  const original=structuredClone(features),context=new Context();
  paintVectorTile(context,{layers:{landcover:layer('landcover',features,cover.extent)}},10);
  assert.equal(context.rectangles[0].color,CARTOGRAPHY.land);assert.equal(context.fills.length,features.length);
  for(let i=0;i<features.length;i++){
    assert.equal(context.fills[i].color,categories[i][2]);assert.deepEqual(context.fills[i].path,pathFor(features[i],cover.extent));assert.equal(context.fills[i].rule,'evenodd');
  }
  assert.notEqual(CARTOGRAPHY.land,CARTOGRAPHY.grass);assert.notEqual(CARTOGRAPHY.grass,CARTOGRAPHY.scrub);assert.notEqual(CARTOGRAPHY.rock,CARTOGRAPHY.land);
  assert.deepEqual(structuredClone(features),original,'Presentation never rewrites source geometry or source classes');
});

test('unknown cover and administrative neighbourhood polygons do not acquire invented vegetation or built-up coverage',()=>{
  const context=new Context();
  paintVectorTile(context,{layers:{landcover:layer('landcover',[polygon({class:'unknown',name:'Лесная поляна'})]),landuse:layer('landuse',[polygon({class:'suburb'}),polygon({class:'neighbourhood'}),polygon({class:'farmland'}),polygon({class:'residential'})])}},14);
  assert.deepEqual(context.fills.map(fill=>fill.color),[CARTOGRAPHY.farmland,CARTOGRAPHY.urban]);
});

test('recorded footpaths, tracks, stairs and aerialways use distinct line grammars without changing any source vertex',()=>{
  const roads=archive('14/10025/5977.pbf').layers.transportation;
  const select=(category,subclass)=>roads.features.find(feature=>feature.type===2&&feature.properties.class===category&&(!subclass||feature.properties.subclass===subclass)&&!feature.properties.brunnel);
  const footpath=select('path','footway'),track=select('track'),stairs=select('path','steps'),lift=select('aerialway','gondola');
  const features=[footpath,track,stairs,lift];assert.ok(features.every(Boolean));
  const original=structuredClone(features),context=new Context();paintVectorTile(context,{layers:{transportation:layer('transportation',features,roads.extent)}},14);
  const [pathPaint,trackPaint,stepPaint,liftPaint]=features.map(feature=>strokesFor(context,feature));
  for(const strokes of [pathPaint,trackPaint,stepPaint,liftPaint]){
    assert.equal(strokes.length,2);assert.deepEqual(strokes[0].dash,strokes[1].dash,'A continuous pale casing must not turn a dashed trail into a road');assert.ok(strokes[0].dash.length);
  }
  assert.notDeepEqual(pathPaint[1].dash,trackPaint[1].dash);assert.notDeepEqual(pathPaint[1].dash,stepPaint[1].dash);
  assert.equal(stepPaint[1].cap,'butt','Steps retain separated transverse marks at output resolution');
  assert.notEqual(liftPaint[1].color,CARTOGRAPHY.road);assert.notEqual(liftPaint[1].color,CARTOGRAPHY.path);assert.deepEqual(structuredClone(features),original);
  const hidden=new Context();paintVectorTile(hidden,{layers:{transportation:layer('transportation',features,roads.extent)}},14,512,false);
  assert.equal(hidden.strokes.length,2);assert.deepEqual(hidden.strokes.map(stroke=>stroke.path),liftPaint.map(stroke=>stroke.path),'The trail switch leaves real aerialway infrastructure visible');
});

test('platforms and unrecognised transport classes never masquerade as hiking routes or ordinary streets',()=>{
  const context=new Context(),features=[line(300,{class:'path',subclass:'platform'}),line(600,{class:'unknown',name:'Тропа к вершине'}),line(900,{class:'construction'})];
  paintVectorTile(context,{layers:{transportation:layer('transportation',features)}},18);
  assert.equal(context.strokes.length,0);
});

test('real bridge and tunnel tags determine paint order, while same-level road junctions share uninterrupted interiors',()=>{
  const bridge=line(1000,{class:'minor',brunnel:'bridge'}),surface=line(2000,{class:'primary'}),local=line(3000,{class:'minor'}),tunnel=line(3500,{class:'secondary',brunnel:'tunnel'});
  const features=[bridge,surface,local,tunnel],original=structuredClone(features),context=new Context();
  paintVectorTile(context,{layers:{transportation:layer('transportation',features)}},14);
  assert.equal(context.strokes.length,8);
  const index=feature=>context.strokes.map((stroke,index)=>JSON.stringify(stroke.path)===JSON.stringify(pathFor(feature))?index:-1).filter(index=>index>=0);
  assert.ok(Math.max(...index(tunnel))<Math.min(...index(surface)));assert.ok(Math.max(...index(surface),...index(local))<Math.min(...index(bridge)));
  const surfacePaint=context.strokes.filter(stroke=>[...index(surface),...index(local)].some(index=>context.strokes[index]===stroke));
  assert.ok(surfacePaint.slice(0,2).every(stroke=>stroke.color===CARTOGRAPHY.roadEdge));assert.ok(surfacePaint.slice(2).every(stroke=>stroke.color===CARTOGRAPHY.road));
  assert.ok(strokesFor(context,tunnel).every(stroke=>stroke.dash.length),'Covered roads are not portrayed as open solid roads');assert.deepEqual(features,original);
});

test('the satellite overlay retains the same source lines but paints no opaque land, water or building polygons',()=>{
  const tile=archive('14/10025/5977.pbf'),original=structuredClone(tile),satellite=new Context(),detail=new Context();
  paintVectorTile(satellite,tile,14,512,true,true);paintVectorTile(detail,tile,14);
  assert.equal(satellite.rectangles.length,0);assert.equal(satellite.fills.length,0);assert.ok(detail.fills.length>0);
  const roads=tile.layers.transportation.features.filter(feature=>feature.type===2&&feature.properties.class==='aerialway');assert.ok(roads.length);
  for(const road of roads)assert.deepEqual(strokesFor(satellite,road).map(stroke=>stroke.path),strokesFor(detail,road).map(stroke=>stroke.path));
  assert.deepEqual(structuredClone(tile),original);
});

test('the source label budget protects measured peaks and real trail names before low-ranked neighbourhood detail',()=>{
  const districts=Array.from({length:120},(_,index)=>point(50+index*30,400,{class:'neighbourhood',name:`Микрорайон ${index}`,rank:1}));
  const peak=point(2000,1800,{class:'peak',name:'Вершина',ele:602,rank:9}),trail=line(2500,{class:'path',name:'Экотропа',rank:8});
  const tile={layers:{place:layer('place',districts),mountain_peak:layer('mountain_peak',[peak]),transportation_name:layer('transportation_name',[trail])}},original=structuredClone(tile);
  const labels=paintVectorTile(new Context(),tile,14);assert.equal(labels.length,96);
  assert.ok(labels.some(label=>label.kind==='peak'&&label.elevation===602));assert.ok(labels.some(label=>label.kind==='path'&&label.text==='Экотропа'));
  assert.ok(labels.filter(label=>label.kind==='place').every(label=>label.placeClass==='neighbourhood'));
  const wider=paintVectorTile(new Context(),tile,11);assert.equal(wider.filter(label=>label.kind==='place').length,0,'Urban microdistrict labels wait for a scale where they are useful');assert.deepEqual(tile,original);
});

test('index elevations use compact, fully measured label surfaces and recur only at readable distances',()=>{
  const contour={x:.5,y:.5,text:'400 м',kind:'contour',rank:9,elevation:400},point={x:200,y:200};
  const style=mapLabelStyle(contour,14),layout=mapLabelLayout(contour,point,36,true,style),context=new Context();
  drawMapLabel(context,contour.text,point,layout,style);
  assert.equal(style.fontSize,12);assert.equal(layout.plate.bottom-layout.plate.top,16);assert.equal(layout.plate.right-layout.plate.left,44);
  assert.ok(layout.rect.left<=layout.plate.left&&layout.rect.right>=layout.plate.right&&layout.rect.top<=layout.plate.top&&layout.rect.bottom>=layout.plate.bottom);
  assert.equal(context.fills.length,1);assert.equal(context.strokes.length,0);assert.deepEqual(context.texts,[{value:'400 м',x:200,y:200,color:style.ink}]);
  assert.equal(mapLabelRepeatDistance(contour),240);assert.equal(mapLabelRepeatKey(contour),mapLabelRepeatKey({...contour,x:.8}));
  assert.notEqual(mapLabelRepeatKey(contour),mapLabelRepeatKey({...contour,text:'500 м',elevation:500}));
  assert.ok(mapLabelPriority(contour)>mapLabelPriority({...contour,kind:'path'}));
  assert.ok(mapLabelPriority(contour)<mapLabelPriority({...contour,kind:'place',placeClass:'neighbourhood',rank:1}));
});
