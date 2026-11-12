import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeTerrarium,elevationBorder,paintContours,paintVectorTile,reliefPixels} from '../lib/custom-map-painter.ts';
import {decodeVectorTile} from '../lib/custom-map-vector.ts';

class Context {
  strokes=[];fills=[];path=[];dash=[];offset=[0,0];
  clearRect(){} fillRect(){} beginPath(){this.path=[];}
  moveTo(x,y){this.path.push(['M',x+this.offset[0],y+this.offset[1]]);}
  lineTo(x,y){this.path.push(['L',x+this.offset[0],y+this.offset[1]]);}
  closePath(){this.path.push(['Z']);}
  setLineDash(value){this.dash=[...value];}
  translate(x,y){this.offset=[this.offset[0]+x,this.offset[1]+y];}
  fill(rule){this.fills.push({path:this.path,rule,color:this.fillStyle});}
  stroke(){this.strokes.push({path:this.path,width:this.lineWidth,dash:[...this.dash],color:this.strokeStyle});}
}
const line=(coordinates,properties={class:'path'})=>({type:2,properties,geometry:[coordinates.map(([x,y])=>({x,y}))]});
const point=(x,y,properties)=>({type:1,properties,geometry:[[{x,y}]]});
const layer=(name,features,extent=4096)=>({name,extent,features});
const scalarPixel=height=>{const v=height+32768;return[Math.floor(v/256),Math.floor(v)%256,Math.round(v%1*256),255];};

test('cropped parent geometry is re-rendered at child resolution while widths and dashes stay in output pixels',()=>{
  const feature=line([[1331.2,1920],[1484.8,1920]]),tile={layers:{transportation:layer('transportation',[feature])}};
  const original=structuredClone(tile),context=new Context();context.translate(-5*512,-7*512);
  paintVectorTile(context,tile,18,512*16,true,false,{symbolScale:2,geometryBounds:{left:5/16,top:7/16,right:6/16,bottom:8/16}});
  assert.equal(context.strokes.length,2);assert.equal(context.strokes[0].width,4.6);assert.equal(context.strokes[1].width,2.2);
  assert.deepEqual(context.strokes[1].dash,[6,5]);
  const [first,last]=context.strokes[1].path;
  assert.ok(Math.abs(first[1]-102.4)<1e-9);assert.ok(Math.abs(last[1]-409.6)<1e-9);assert.equal(first[2],256);
  const native=new Context();paintVectorTile(native,tile,14,512,true,false);
  assert.equal(native.strokes[1].width,context.strokes[1].width);assert.deepEqual(tile,original);
});

test('labels are cropped before the 96-label budget and priority cities require the sourced city class',()=>{
  const features=Array.from({length:120},(_,i)=>point(10,10,{class:'city',name:`Outside ${i}`,rank:1}));
  features.push(point(1408,1856,{class:'city','name:ru':'Москва',rank:4}));
  features.push(point(1420,1860,{class:'village','name:ru':'Москва',rank:4}));
  const tile={layers:{place:layer('place',features)}},original=structuredClone(tile);
  const labels=paintVectorTile(new Context(),tile,18,8192,true,false,{symbolScale:2,labelBounds:{left:5/16,top:7/16,right:6/16,bottom:8/16}});
  assert.equal(labels.length,2);assert.equal(labels[0].priorityCity,true);assert.equal(labels[1].priorityCity,undefined);
  assert.equal(labels[0].x,1408/4096);assert.equal(labels[0].y,1856/4096);
  assert.deepEqual(tile,original);
});

test('off-child features avoid path construction but a real line crossing the child keeps all source vertices',()=>{
  const outside=Array.from({length:1000},()=>line([[0,0],[10,10]],{class:'primary'}));
  const crossing=line([[0,1920],[4096,1920]],{class:'primary'});
  const context=new Context();context.translate(-5*512,-7*512);
  paintVectorTile(context,{layers:{transportation:layer('transportation',[...outside,crossing])}},18,8192,true,false,
    {symbolScale:2,geometryBounds:{left:5/16,top:7/16,right:6/16,bottom:8/16}});
  assert.equal(context.strokes.length,2,'only the intersecting source feature reaches the path painter');
  assert.deepEqual(context.strokes[0].path,[['M',-2560,256],['L',5632,256]]);
});

test('polygon holes, buffered coordinates and source ring order remain intact',()=>{
  const feature={type:3,properties:{},geometry:[[{x:-20,y:-20},{x:4096,y:-20},{x:4096,y:4096},{x:-20,y:4096},{x:-20,y:-20}],
    [{x:512,y:512},{x:512,y:1024},{x:1024,y:1024},{x:1024,y:512},{x:512,y:512}]]};
  const context=new Context();paintVectorTile(context,{layers:{water:layer('water',[feature])}},18,8192,true,false,{symbolScale:2});
  assert.equal(context.fills.length,1);assert.equal(context.fills[0].rule,'evenodd');
  assert.equal(context.fills[0].path.filter(command=>command[0]==='Z').length,2);
  assert.deepEqual(context.fills[0].path[0],['M',-40,-40]);
});

test('contours follow measured pixel centres, have fixed child widths, and retain steep real crossings',()=>{
  const heights=new Float32Array([0,100,0,100]),context=new Context();
  assert.equal(paintContours(context,heights,2,14,512,{lineScale:1}),3);
  assert.deepEqual(context.strokes[0].path,[['M',192,128],['L',192,384],['M',256,128],['L',256,384],['M',320,128],['L',320,384]]);
  assert.equal(context.strokes[0].width,.65);
  const enlarged=new Context();paintContours(enlarged,heights,2,18,32768,{lineScale:1});assert.equal(enlarged.strokes[0].width,.65);
  assert.equal(paintContours(new Context(),new Float32Array([0,1000,0,1000]),2,18,512,{lineScale:1}),39,'steep source cells no longer lose all of their contours');
  assert.deepEqual([...heights],[0,100,0,100]);
});

test('close zoom uses every source cell in the child, including the final source row and column',()=>{
  const heights=Float32Array.from({length:16},(_,i)=>(i%4)*25+Math.floor(i/4)),context=new Context();
  paintContours(context,heights,4,18,2048,{lineScale:1,bounds:{left:.5,top:.5,right:1,bottom:1}});
  const points=context.strokes[0].path;
  assert.ok(points.some(([,x,y])=>x>1600&&y===1792),'the measured last row participates in the 75m isoline');
  const transposed=new Context();paintContours(transposed,Float32Array.from({length:16},(_,i)=>Math.floor(i/4)*25+i%4),4,18,2048,{lineScale:1,bounds:{left:.5,top:.5,right:1,bottom:1}});
  assert.ok(transposed.strokes[0].path.some(([,x,y])=>x===1792&&y>1600),'the measured last column participates too');
});

test('saddle contours choose the topology of the measured bilinear surface',()=>{
  // At level0 the positive diagonal is weaker, so its two corners stay separate.
  const context=new Context();paintContours(context,new Float32Array([10,-40,-40,10]),2,14,512,{lineScale:1});
  const atZero=context.strokes[0].path.slice(-4);
  assert.deepEqual(atZero,[['M',179.2,128],['L',128,179.2],['M',384,332.8],['L',332.8,384]]);
});

test('invalid Terrarium values fail before they create relief; hillshade uses actual source spacing',()=>{
  const rgba=new Uint8ClampedArray([0,1,2,3].flatMap(value=>scalarPixel(value*25)));
  const heights=decodeTerrarium(rgba,2,2);assert.deepEqual([...heights],[0,25,50,75]);
  const slope=Float32Array.from({length:16},(_,i)=>(i%4)*25+Math.floor(i/4)*50);
  assert.notDeepEqual(reliefPixels(slope,4,200,12),reliefPixels(slope,4,12800,18),'display zoom cannot stand in for the source resolution');
  const flat=reliefPixels(new Float32Array(4).fill(100),2,200,12);assert.ok([...flat].filter((_,i)=>i%4===3).every(alpha=>alpha===0));
  rgba[3]=0;assert.throws(()=>decodeTerrarium(rgba,2,2),/Unavailable/);
  assert.throws(()=>decodeTerrarium(new Uint8ClampedArray(16).fill(255),2,2),/invalid/);
});

const measured=(tx,ty,size=4,fn=(x,y)=>25*(x+.5)+40*(y+.5))=>Float32Array.from({length:size*size},(_,i)=>fn(tx*size+i%size,ty*size+Math.floor(i/size)));
const neighbours=(tx,ty,size=4,fn)=>Object.fromEntries([-1,0,1].flatMap(dy=>[-1,0,1].filter(dx=>dx||dy).map(dx=>[`${dx},${dy}`,elevationBorder(measured(tx+dx,ty+dy,size,fn),size,size,dx,dy)])));
const segments=context=>{const path=context.strokes.at(-1).path;return Array.from({length:path.length/2},(_,i)=>[path[2*i].slice(1),path[2*i+1].slice(1)]);};
const seamCrossings=(lines,axis,seam)=>[...new Set(lines.filter(([a,b])=>(a[axis]-seam)*(b[axis]-seam)<0).map(([a,b])=>{const t=(seam-a[axis])/(b[axis]-a[axis]);return +(a[1-axis]+t*(b[1-axis]-a[1-axis])).toFixed(8);})).values()].sort((a,b)=>a-b);

test('real neighbouring samples join contours across horizontal and vertical parent boundaries',()=>{
  for(const [tx,ty,axis] of [[1,0,0],[0,1,1]]){
    const first=new Context(),second=new Context();second.translate(tx*512,ty*512);
    paintContours(first,measured(0,0),4,18,512,{halo:neighbours(0,0)});
    paintContours(second,measured(tx,ty),4,18,512,{halo:neighbours(tx,ty)});
    const a=seamCrossings(segments(first),axis,512).filter(v=>v>=0&&v<=512),b=seamCrossings(segments(second),axis,512).filter(v=>v>=0&&v<=512);
    assert.ok(a.length>=3,'the shared real cell must cross the exact tile boundary');assert.deepEqual(a,b);
    const missing=new Context();paintContours(missing,measured(0,0),4,18,512);
    assert.deepEqual(seamCrossings(segments(missing),axis,512),[],'missing neighbours do not invent a contour connection');
  }
});

test('all four parent tiles trace the same real corner cell, and a missing diagonal remains unknown',()=>{
  const corner=lines=>lines.filter(pair=>pair.every(([x,y])=>x>=448&&x<=576&&y>=448&&y<=576))
    .map(pair=>pair.map(point=>point.map(v=>+v.toFixed(8))).sort((a,b)=>a[0]-b[0]||a[1]-b[1])).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const results=[];
  for(const [tx,ty] of [[0,0],[1,0],[0,1],[1,1]]){
    const context=new Context();context.translate(tx*512,ty*512);paintContours(context,measured(tx,ty),4,18,512,{halo:neighbours(tx,ty)});results.push(corner(segments(context)));
  }
  assert.ok(results[0].length>=2);for(const result of results.slice(1))assert.deepEqual(result,results[0]);
  const incomplete=neighbours(0,0);delete incomplete['1,1'];const context=new Context();paintContours(context,measured(0,0),4,18,512,{halo:incomplete});
  assert.deepEqual(corner(segments(context)),[],'north/east/south/west alone cannot fabricate the diagonal sample');
});

test('cross-parent hillshade equals one continuous measured grid, including the shared four-tile corner',()=>{
  const fn=(x,y)=>x*x*13+y*y*7+20*x,whole=Float32Array.from({length:64},(_,i)=>fn(i%8,Math.floor(i/8)));
  const expected=reliefPixels(whole,8,100,11);
  for(const [tx,ty] of [[0,0],[1,0],[0,1],[1,1]]){
    const pixels=reliefPixels(measured(tx,ty,4,fn),4,200+ty,12,neighbours(tx,ty,4,fn));
    for(let y=0;y<4;y++)for(let x=0;x<4;x++){
      const gx=tx*4+x,gy=ty*4+y;if(gx===0||gx===7||gy===0||gy===7)continue;
      assert.deepEqual(pixels.slice((y*4+x)*4,(y*4+x+1)*4),expected.slice((gy*8+gx)*4,(gy*8+gx+1)*4));
    }
  }
  const unknown=reliefPixels(measured(0,0,4,fn),4,200,12);assert.equal(unknown[(2*4+3)*4+3],0,'absent outside derivatives are transparent, never clamped slopes');
});

test('archived halo reduction reproduces scalar 2x2 mean and Terrarium ties-to-even without interpolating RGB',()=>{
  const source=Float32Array.from([0,0,1,1,1,1,1,3,0,0,-3,-1,-1,-1,-1,-1],value=>value/256);
  assert.deepEqual([...elevationBorder(source,4,2,1,1,true)],[0]);
  assert.deepEqual([...elevationBorder(source,4,2,-1,1,true)],[2/256]);
  assert.deepEqual([...elevationBorder(source,4,2,1,-1,true)],[0]);
  assert.deepEqual([...elevationBorder(source,4,2,-1,-1,true)],[-2/256]);
  assert.throws(()=>elevationBorder(source,4,2,1,0),/resolution/);
  assert.throws(()=>elevationBorder(source,4,3,1,0,true),/resolution/);
});

test('sourced outdoor classes retain unnamed points and high source ranks without inventing symbols from names',()=>{
  const tile={layers:{poi:layer('poi',[
    point(100,200,{class:'camp_site',rank:8}),point(120,220,{class:'campsite'}),point(140,240,{class:'shelter'}),point(160,260,{class:'natural',subclass:'spring'}),
    point(180,280,{class:'viewpoint'}),point(200,300,{class:'information'}),point(220,320,{class:'mountain_pass'}),
    point(240,340,{class:'shop',name:'Родник и стоянка',rank:2}),point(260,360,{class:'shop',name:'Unimportant shop',rank:8}),point(280,380,{class:'shop'})
  ])}},original=structuredClone(tile);
  const labels=paintVectorTile(new Context(),tile,13);
  assert.equal(labels.length,7);assert.deepEqual(labels.filter(label=>label.symbol).map(label=>label.symbol).sort(),['camp','camp','info','pass','shelter','viewpoint','water']);
  const camp=labels.find(label=>label.x===100/4096);assert.equal(camp.text,'');assert.equal(camp.rank,8);assert.equal(camp.y,200/4096);
  assert.equal(labels.find(label=>label.text==='Родник и стоянка'),undefined,'An outdoor-looking shop name does not admit a retail point');
  assert.deepEqual(paintVectorTile(new Context(),tile,12),[]);assert.deepEqual(tile,original);
});

test('hiking cartography excludes low-ranked school, medical and retail clutter but retains sourced landmarks',()=>{
  const irrelevant=['school','college','hospital','clinic','doctors','pharmacy','shop','supermarket','mall','restaurant','bank'];
  const features=irrelevant.map((category,i)=>point(500+i*100,500,{class:category,name:`Городской объект ${i}`,rank:1}));
  features.push(point(1000,1000,{class:'natural',subclass:'waterfall','name:ru':'Водопад',rank:8}));
  features.push(point(2000,2000,{class:'historic',subclass:'castle','name:ru':'Крепость',rank:8}));
  const tile={layers:{poi:layer('poi',features)}},original=structuredClone(tile);
  for(const zoom of [13,14,18]){
    const labels=paintVectorTile(new Context(),tile,zoom);
    assert.deepEqual(labels.map(label=>[label.text,label.symbol]),[['Водопад','waterfall'],['Крепость','landmark']]);
  }
  assert.deepEqual(tile,original,'Filtering presentation must not mutate source records');
});

test('unnamed measured peaks retain their original height and anchor while unknown elevation stays absent',()=>{
  const tile={layers:{mountain_peak:layer('mountain_peak',[
    point(100,200,{ele:'5642'}),point(300,400,{class:'saddle',ele:2750}),point(500,600,{ele:0}),point(700,800,{ele:''})
  ])}};
  const labels=paintVectorTile(new Context(),tile,10);assert.equal(labels.length,4);
  assert.deepEqual(labels[0],{x:100/4096,y:200/4096,text:'',kind:'peak',rank:3,elevation:5642,symbol:'peak'});
  assert.equal(labels[1].symbol,'pass');assert.equal(labels[1].elevation,2750);assert.equal(labels[2].elevation,0);assert.equal(labels[3].elevation,undefined);
  assert.deepEqual(paintVectorTile(new Context(),tile,9),[]);
});

test('source symbol labels still apply the child crop before the shared 96-label budget',()=>{
  const features=Array.from({length:120},()=>point(0,0,{class:'campsite'}));
  features.push(point(1408,1856,{class:'drinking_water'}));
  const labels=paintVectorTile(new Context(),{layers:{poi:layer('poi',features)}},18,8192,true,false,{symbolScale:2,labelBounds:{left:5/16,top:7/16,right:6/16,bottom:8/16}});
  assert.equal(labels.length,1);assert.equal(labels[0].symbol,'water');assert.equal(labels[0].text,'');assert.equal(labels[0].rank,3);
});

const archiveTile=path=>decodeVectorTile(readFileSync(new URL(`../public/offline-map/localtiles/${path}`,import.meta.url)));
test('the territorial switch removes real archived admin lines while preserving roads, water and park borders',()=>{
  const tile=archiveTile('10/626/373.pbf'),original=structuredClone(tile);
  assert.equal(tile.layers.boundary.features.filter(feature=>feature.type===2&&Number(feature.properties.admin_level)<=4).length,2);
  for(const transparent of [false,true]){
    const enabled=new Context(),hidden=new Context(),borderColor=transparent?'#e5eee1':'#97aa8e';
    const labels=paintVectorTile(enabled,tile,14,512,true,transparent),without=paintVectorTile(hidden,tile,14,512,true,transparent,{boundaries:false});
    assert.equal(enabled.strokes.filter(stroke=>stroke.color===borderColor).length,2);
    assert.deepEqual(hidden.strokes,enabled.strokes.filter(stroke=>stroke.color!==borderColor));
    assert.deepEqual(hidden.fills,enabled.fills);assert.deepEqual(without,labels);
    assert.ok(hidden.strokes.some(stroke=>stroke.color==='rgba(120,155,101,.65)'),'Protected-area outlines remain a separate real layer');
  }
  assert.deepEqual(structuredClone(tile),original);
});

test('the real archived Caucasus reserve polygon retains its fill, dashed boundary and exact rings',()=>{
  const tile=archiveTile('10/626/373.pbf'),park=tile.layers.park;
  const reserve=park.features.find(feature=>feature.type===3&&feature.properties.name==='Кавказский заповедник');assert.ok(reserve);
  assert.equal(reserve.properties.class,'conservation');assert.equal(reserve.geometry.reduce((n,part)=>n+part.length,0),290);
  const source={layers:{park}},original=structuredClone(source),polygons=park.features.filter(feature=>feature.type===3),context=new Context();
  paintVectorTile(context,source,10);
  assert.equal(context.fills.length,polygons.length);assert.equal(context.strokes.length,polygons.length,'park point anchors cannot turn into polygon boundaries');
  const index=polygons.indexOf(reserve),fill=context.fills[index],border=context.strokes[index];
  assert.equal(fill.color,'rgba(193,213,178,.22)');assert.equal(fill.rule,'evenodd');assert.equal(border.color,'rgba(120,155,101,.65)');assert.equal(border.width,1.8);assert.deepEqual(border.dash,[5.4,5.4]);
  assert.deepEqual(fill.path.filter(command=>command[0]!=='Z').map(command=>command.slice(1)),reserve.geometry.flat().map(point=>[point.x*512/park.extent,point.y*512/park.extent]));
  assert.deepEqual(border.path,fill.path);assert.deepEqual(structuredClone(source),original);
  const satellite=new Context();paintVectorTile(satellite,source,18,8192,true,true,{symbolScale:2});
  assert.equal(satellite.fills.length,0);assert.equal(satellite.strokes.length,polygons.length);assert.equal(satellite.strokes[index].width,1.8,'overzoom retains output-width boundaries');
  const coarse=new Context();paintVectorTile(coarse,source,6);assert.equal(coarse.fills.length,0);assert.equal(coarse.strokes.length,0);
  const middle=new Context();paintVectorTile(middle,source,8);assert.equal(middle.fills.length,polygons.length);assert.equal(middle.strokes.length,0);
});

function distanceToSource(point,geometry){
  let closest=Infinity;
  for(const part of geometry)for(let i=1;i<part.length;i++){
    const a=part[i-1],b=part[i],dx=b.x-a.x,dy=b.y-a.y,denominator=dx*dx+dy*dy;
    const t=denominator?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/denominator)):0;
    closest=Math.min(closest,Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy));
  }
  return closest;
}
test('a real archived path name appears at z14 and its overzoom anchor stays on the measured line inside the child',()=>{
  const tile=archiveTile('14/10025/5977.pbf'),names=tile.layers.transportation_name;
  const source=names.features.find(feature=>feature.type===2&&feature.properties.name==='набережная Полянка');assert.ok(source);assert.equal(source.properties.class,'path');
  assert.equal(source.geometry.reduce((n,part)=>n+part.length,0),29);
  const selected={layers:{transportation_name:names}},original=structuredClone(selected);
  const labels=paintVectorTile(new Context(),selected,14),label=labels.find(item=>item.text==='набережная Полянка');assert.ok(label);assert.equal(label.kind,'path');
  assert.ok(distanceToSource({x:label.x*names.extent,y:label.y*names.extent},source.geometry)<1e-7);
  assert.equal(paintVectorTile(new Context(),selected,13).length,0);assert.equal(paintVectorTile(new Context(),selected,18,512,false).length,0);
  const ix=Math.min(15,Math.floor(label.x*16)),iy=Math.min(15,Math.floor(label.y*16)),bounds={left:ix/16,top:iy/16,right:(ix+1)/16,bottom:(iy+1)/16};
  const child=paintVectorTile(new Context(),selected,18,8192,true,false,{symbolScale:2,labelBounds:bounds,geometryBounds:bounds}).find(item=>item.text===label.text);assert.ok(child);
  assert.ok(child.x>=bounds.left&&child.x<=bounds.right&&child.y>=bounds.top&&child.y<=bounds.bottom);
  assert.ok(distanceToSource({x:child.x*names.extent,y:child.y*names.extent},source.geometry)<1e-7);assert.deepEqual(structuredClone(selected),original);
});

test('path anchors clip crossing source segments, never bridge disconnected parts, and precede the shared label limit',()=>{
  const outside=Array.from({length:120},(_,i)=>line([[0,0],[10,0]],{class:'path',name:`Outside ${i}`}));
  const crossing=line([[0,1900],[4096,1900]],{class:'path','name:ru':'Настоящая тропа'});
  const pointPretendingPath=point(1400,1900,{class:'path',name:'Point is not a path'});
  const labels=paintVectorTile(new Context(),{layers:{transportation_name:layer('transportation_name',[...outside,crossing,pointPretendingPath])}},18,8192,true,false,
    {symbolScale:2,labelBounds:{left:5/16,top:7/16,right:6/16,bottom:8/16}});
  assert.deepEqual(labels,[{x:1408/4096,y:1900/4096,text:'Настоящая тропа',kind:'path',rank:4}]);
  const disconnected={type:2,properties:{class:'track',name:'Two real parts'},geometry:[[{x:-100,y:1000},{x:1000,y:1000}],[{x:2000,y:2000},{x:6000,y:2000}]]};
  const result=paintVectorTile(new Context(),{layers:{transportation_name:layer('transportation_name',[disconnected])}},14)[0];
  assert.equal(result.x,3048/4096);assert.equal(result.y,2000/4096);assert.ok(distanceToSource({x:result.x*4096,y:result.y*4096},disconnected.geometry)<1e-7);
});

test('ridge and cliff source classes keep names without acquiring peak symbols, including misleading names',()=>{
  const tile={layers:{mountain_peak:layer('mountain_peak',[
    point(100,100,{class:'ridge',name:'Хребет',ele:2500}),point(200,200,{class:'cliff',name:'Peak campsite',ele:100}),
    point(300,300,{class:'ridge',ele:2400}),point(400,400,{class:'cliff',ele:150}),point(500,500,{class:'peak',name:'Вершина',ele:2600})
  ])}};
  const labels=paintVectorTile(new Context(),tile,14);assert.equal(labels.length,3);
  assert.equal(labels.find(label=>label.text==='Хребет').symbol,undefined);assert.equal(labels.find(label=>label.text==='Peak campsite').symbol,undefined);
  assert.equal(labels.find(label=>label.text==='Вершина').symbol,'peak');
});
