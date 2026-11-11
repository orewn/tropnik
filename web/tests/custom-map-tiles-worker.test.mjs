import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import * as painter from '../lib/custom-map-painter.ts';

// Execute the actual worker protocol with controlled image/Canvas APIs. Numeric
// painting is real; recorded commands do not claim to measure GPU output.
const source=await readFile(new URL('../lib/custom-map-tiles.worker.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const copy=value=>JSON.parse(JSON.stringify(value));
const point=(x,y,name)=>({type:1,properties:{class:'city','name:ru':name,rank:1},geometry:[[{x,y}]]});
const vector={layers:{place:{name:'place',extent:4096,features:[point(1408,1856,'Москва'),point(1664,1856,'Сочи')]},
  transportation:{name:'transportation',extent:4096,features:[{type:2,properties:{class:'path'},geometry:[[{x:1331.2,y:1920},{x:1484.8,y:1920}]]}]}}};
const bytes=()=>new Uint8Array([1,2,3]).buffer;
const job=(id,overrides={})=>({id,kind:'vector',bytes:bytes(),z:18,x:1605,y:3207,sourceZ:14,sourceKey:'https://tiles.example/14/100/200.pbf',paths:true,...overrides});
const scalarPixel=height=>{const value=height+32768;return[Math.floor(value/256),Math.floor(value)%256,Math.round(value%1*256),255];};

function fixture({failTransfer=false,unavailablePixel=false,images=new Map()}={}){
  const messages=[],canvases=[],outputs=[],decoded=[],shadeSources=[],contourViews=[],vectorViews=[];let vectorDecodes=0,imageDecodes=0,failedTransfer=false;
  const rgba=new Uint8ClampedArray(Array.from({length:16},(_,i)=>scalarPixel((i%4)*25+Math.floor(i/4))).flat());
  if(unavailablePixel)rgba[3]=0;
  class Bitmap{
    closed=0;constructor(width,height,sourcePixels){this.width=width;this.height=height;this.rgba=sourcePixels;}
    close(){this.closed++;}
  }
  class Context{
    constructor(canvas){this.canvas=canvas;this.draws=[];this.strokes=[];this.path=[];this.fills=[];this.offset=[0,0];this.stack=[];this.dash=[];}
    save(){this.stack.push([...this.offset]);}restore(){this.offset=this.stack.pop();}
    translate(x,y){this.offset=[this.offset[0]+x,this.offset[1]+y];}
    clearRect(){}fillRect(){}beginPath(){this.path=[];}
    moveTo(x,y){this.path.push(['M',x+this.offset[0],y+this.offset[1]]);}
    lineTo(x,y){this.path.push(['L',x+this.offset[0],y+this.offset[1]]);}
    closePath(){this.path.push(['Z']);}
    setLineDash(value){this.dash=[...value];}
    fill(rule){this.fills.push({path:this.path,rule});}
    stroke(){this.strokes.push({path:this.path,width:this.lineWidth,dash:[...this.dash]});}
    drawImage(image,...args){this.draws.push({image,args});}
    getImageData(){return{data:this.draws.at(-1).image.rgba};}
    putImageData(image){this.imageData=image;}
  }
  class OffscreenCanvas{
    constructor(width,height){this.width=width;this.height=height;this.context=new Context(this);canvases.push(this);}
    getContext(){return this.context;}
    transferToImageBitmap(){const bitmap=new Bitmap(this.width,this.height);bitmap.context=this.context;outputs.push(bitmap);return bitmap;}
  }
  class ImageData{constructor(data,width,height){this.data=data;this.width=width;this.height=height;}}
  const scope={exports:{},Error,Blob,DecompressionStream,Uint8Array,Uint8ClampedArray,Float32Array,ArrayBuffer,OffscreenCanvas,ImageData,
    createImageBitmap:async blob=>{imageDecodes++;const input=new Uint8Array(await blob.arrayBuffer()),image=images.get(input[0]);const bitmap=blob.type==='image/jpeg'?new Bitmap(512,512):new Bitmap(image?.size??4,image?.size??4,image?.rgba??rgba);decoded.push(bitmap);return bitmap;},
    require:name=>{
      if(name==='./custom-map-vector')return{decodeVectorTile:()=>{vectorDecodes++;return vector;}};
      assert.equal(name,'./custom-map-painter');return{...painter,
        paintVectorTile:(...args)=>{vectorViews.push({z:args[2],size:args[3],options:args[6]});return painter.paintVectorTile(...args);},
        reliefPixels:(heights,size,y,z,halo)=>{shadeSources.push({y,z,heights:[...heights],halo:copy(halo)});return painter.reliefPixels(heights,size,y,z,halo);},
        paintContours:(...args)=>{contourViews.push({z:args[3],size:args[4],options:args[5]});return painter.paintContours(...args);}};
    },
    self:{postMessage(message,options){
      if(message.bitmap&&failTransfer&&!failedTransfer){failedTransfer=true;throw new Error('Transfer unavailable');}
      if(message.bitmap)assert.equal(options.transfer[0],message.bitmap);
      messages.push(message);
    }},
  };
  vm.runInNewContext(compiled,scope);
  return{messages,canvases,outputs,decoded,shadeSources,contourViews,vectorViews,
    counts:()=>({vectorDecodes,imageDecodes}),window:scope.exports.tileRenderWindow,
    send:async data=>{await scope.self.onmessage({data});return messages.find(message=>message.id===data.id);}};
}

test('display/source windows wrap dateline parents and crop the exact positive child at high zoom',()=>{
  const env=fixture();
  const negative=env.window(18,-1,3207,14);
  assert.deepEqual(copy(negative),{factor:16,childX:15,childY:7,sourceX:16383,sourceY:200,sourceZ:14,paintSize:8192,
    bounds:{left:15/16,top:7/16,right:1,bottom:8/16}});
  const east=env.window(18,2**18+5,3207,14);assert.equal(east.sourceX,0);assert.equal(east.childX,5);
  assert.equal(env.window(18,1605,3207,12).factor,64);
  for(const values of [[19,0,0,14],[18,0,-1,14],[12,0,0,14],[18,NaN,0,14]])assert.throws(()=>env.window(...values),/coordinates/);
});

test('neighbouring display children share one decoded parent, retain crisp widths, and receive their own labels',async()=>{
  const env=fixture(),first=await env.send(job(1)),second=await env.send(job(2,{x:1606}));
  assert.equal(env.counts().vectorDecodes,1);assert.equal(env.counts().imageDecodes,0);
  assert.deepEqual(copy(first.labels),[{x:.5,y:.25,text:'Москва',kind:'place',rank:1,priorityCity:true}]);
  assert.deepEqual(copy(second.labels),[{x:.5,y:.25,text:'Сочи',kind:'place',rank:1,priorityCity:true}]);
  assert.equal(first.bitmap.width,512);assert.equal(first.bitmap.height,512);assert.equal(second.bitmap.width,512);
  assert.equal(first.bitmap.context.strokes[1].width,2.2);assert.deepEqual(first.bitmap.context.strokes[1].dash,[6,5]);
  assert.ok(env.canvases.every(canvas=>canvas.width<=512&&canvas.height<=512),'no parent-sized render target is allocated');
  assert.ok(env.outputs.every(bitmap=>bitmap.closed===0),'transferred child bitmaps belong to the receiver');
});

test('decoded parent LRU has four entries and separates exact source URLs',async()=>{
  const env=fixture();let id=0;
  const source=letter=>env.send(job(++id,{sourceKey:`https://tiles.example/${letter}/14/100/200.pbf`}));
  await source('a');await source('b');await source('c');await source('d');assert.equal(env.counts().vectorDecodes,4);
  await source('a');await source('e');assert.equal(env.counts().vectorDecodes,5);
  await source('a');assert.equal(env.counts().vectorDecodes,5,'touching a parent preserves it in the four-entry LRU');
  await source('b');assert.equal(env.counts().vectorDecodes,6,'the least recently used parent was released');
});

test('relief uses source zoom and source latitude once, then renders display-zoom contours for every cropped child',async()=>{
  const env=fixture(),sourceKey='https://tiles.example/12/25/50.webp';
  const first=await env.send(job(1,{kind:'relief',sourceZ:12,sourceKey}));
  const second=await env.send(job(2,{kind:'relief',x:1606,sourceZ:12,sourceKey}));
  assert.equal(first.error,undefined);assert.equal(second.error,undefined);
  assert.equal(env.counts().imageDecodes,1);assert.equal(env.decoded[0].closed,1);
  assert.equal(env.shadeSources.length,1);assert.equal(env.shadeSources[0].z,12);assert.equal(env.shadeSources[0].y,50);
  assert.equal(env.contourViews.length,2);assert.ok(env.contourViews.every(view=>view.z===18&&view.size===32768&&view.options.lineScale===1));
  assert.ok(env.outputs.every(bitmap=>bitmap.width===512&&bitmap.height===512));
});

test('evicting a measured relief parent releases its cached shading canvas',async()=>{
  const env=fixture();
  await env.send(job(1,{kind:'relief',sourceZ:12,sourceKey:'https://tiles.example/a.webp'}));
  const firstShade=env.canvases.find(canvas=>canvas.context.imageData);assert.equal(firstShade.width,4);
  for(let i=2;i<=5;i++)await env.send(job(i,{kind:'relief',sourceZ:12,sourceKey:`https://tiles.example/${i}.webp`}));
  assert.equal(env.counts().imageDecodes,5);assert.equal(firstShade.width,1);assert.equal(firstShade.height,1);
  assert.equal(env.canvases.filter(canvas=>canvas.context.imageData&&canvas.width>1).length,4);
});

test('a raster crop retains only its real pixels and closes the temporary decoded image',async()=>{
  const env=fixture(),result=await env.send(job(1,{kind:'raster',mime:'image/jpeg'}));
  assert.equal(result.bitmap.width,512);assert.equal(result.bitmap.height,512);
  assert.deepEqual(result.bitmap.context.draws[0].args,[-2560,-3584,8192,8192]);
  assert.equal(env.decoded[0].closed,1);assert.equal(env.counts().vectorDecodes,0);
});

test('failed output transfer closes the unowned bitmap and the worker can handle the next tile',async()=>{
  const env=fixture({failTransfer:true}),failed=await env.send(job(1));
  assert.match(failed.error,/Transfer unavailable/);assert.equal(env.outputs[0].closed,1);
  const retry=await env.send(job(2));assert.ok(retry.bitmap);assert.equal(env.counts().vectorDecodes,1);
});

test('missing elevation pixels or oversized messages never publish a falsely ready bitmap',async()=>{
  const env=fixture({unavailablePixel:true}),invalid=await env.send(job(1,{kind:'relief',sourceZ:12}));
  assert.match(invalid.error,/Unavailable/);assert.equal(env.outputs.length,0);assert.equal(env.decoded[0].closed,1);
  const oversized=await env.send(job(2,{bytes:new ArrayBuffer(8*1024*1024+1)}));assert.match(oversized.error,/byte budget/);
  assert.equal(env.outputs.length,0);assert.equal(env.counts().vectorDecodes,0);
});

test('an overlapping worker request is rejected rather than creating an unbounded second decoder',async()=>{
  const env=fixture(),first=env.send(job(1,{kind:'relief',sourceZ:12})),second=await env.send(job(2));
  assert.match(second.error,/busy/);await first;
  const next=await env.send(job(3));assert.ok(next.bitmap);assert.equal(env.counts().vectorDecodes,1);
});

const haloSource=(dx,dy,tag=2,extra={})=>({dx,dy,sourceKey:`https://tiles.example/12/${25+dx}/${50+dy}.webp`,mime:'image/webp',bytes:new Uint8Array([tag]).buffer,...extra});
const sourceImage=(size,fn)=>{const rgba=new Uint8ClampedArray(size*size*4);for(let y=0;y<size;y++)for(let x=0;x<size;x++)rgba.set(scalarPixel(fn(x,y)),(y*size+x)*4);return{size,rgba};};

test('an interior or failed first child never poisons later real halo data in the decoded parent cache',async()=>{
  const images=new Map([[1,sourceImage(4,(x,y)=>x*25+y)],[2,sourceImage(4,(x,y)=>(x-4)*25+y)]]),env=fixture({images});
  const primary={kind:'relief',z:14,sourceZ:12,sourceKey:'https://tiles.example/12/25/50.webp',x:101,y:201};
  const interior=await env.send(job(1,primary));assert.equal(interior.reliefCoverage.required,0);assert.equal(env.counts().imageDecodes,1);
  const absent=await env.send(job(2,{...primary,x:100,halo:{tiles:[],missing:[{dx:-1,dy:0,reason:'unavailable'}]}}));
  assert.equal(absent.reliefCoverage.available,0);assert.equal(absent.reliefCoverage.missingDataFilled,false);assert.equal(env.counts().imageDecodes,1);
  const recovered=await env.send(job(3,{...primary,x:100,halo:{tiles:[haloSource(-1,0)],missing:[]}}));
  assert.equal(recovered.error,undefined);assert.equal(recovered.reliefCoverage.required,1);assert.equal(recovered.reliefCoverage.available,1);assert.deepEqual(copy(recovered.reliefCoverage.missing),[]);
  assert.equal(env.counts().imageDecodes,2);assert.equal(env.shadeSources.length,2,'only new measured neighbours repaint the cached shade');
  assert.deepEqual(Object.values(env.shadeSources.at(-1).halo['-1,0']),[-25,-24,-23,-22]);
  await env.send(job(4,{...primary,x:100,halo:{tiles:[haloSource(-1,0)],missing:[]}}));
  assert.equal(env.counts().imageDecodes,2,'another display child reuses both primary heights and the real strip');
  assert.equal(env.shadeSources.length,2);assert.ok(env.decoded.every(image=>image.closed===1));
});

test('all eight neighbours are decoded serially and only four rows, four columns and corner values survive',async()=>{
  const images=new Map([[1,sourceImage(4,(x,y)=>x*25+y)]]),tiles=[];let tag=1;
  for(const dy of [-1,0,1])for(const dx of [-1,0,1])if(dx||dy){images.set(++tag,sourceImage(4,(x,y)=>(dx*4+x)*25+dy*4+y));tiles.push(haloSource(dx,dy,tag));}
  const env=fixture({images}),result=await env.send(job(1,{kind:'relief',z:12,sourceZ:12,x:25,y:50,sourceKey:'https://tiles.example/12/25/50.webp',halo:{tiles,missing:[]}}));
  assert.equal(result.error,undefined);assert.equal(result.reliefCoverage.required,8);assert.equal(result.reliefCoverage.available,8);
  assert.equal(env.counts().imageDecodes,9);assert.equal(env.shadeSources.length,1);
  const halo=env.shadeSources[0].halo;assert.equal(Object.keys(halo).length,8);assert.equal(Object.values(halo).reduce((n,strip)=>n+Object.keys(strip).length,0),20);
  assert.ok(env.decoded.every(image=>image.closed===1));assert.equal(env.canvases.filter(canvas=>canvas.context.draws.some(draw=>draw.image.rgba)&&canvas.width>1).length,0,'every temporary neighbouring raster is released');
});

test('invalid or mismatched neighbour pixels degrade only that boundary and remain explicit',async()=>{
  const invalid=sourceImage(4,(x,y)=>x+y);invalid.rgba[3]=0;
  const env=fixture({images:new Map([[2,invalid],[3,sourceImage(8,(x,y)=>x+y)]])});
  const primary={kind:'relief',z:14,sourceZ:12,x:100,y:201,sourceKey:'https://tiles.example/12/25/50.webp'};
  const result=await env.send(job(1,{...primary,halo:{tiles:[haloSource(-1,0)],missing:[]}}));
  assert.ok(result.bitmap);assert.equal(result.reliefCoverage.missing[0].reason,'invalid');assert.equal(result.reliefCoverage.available,0);
  const mismatch=await env.send(job(2,{...primary,halo:{tiles:[haloSource(-1,0,3)],missing:[]}}));
  assert.ok(mismatch.bitmap);assert.equal(mismatch.reliefCoverage.missing[0].reason,'resolution');assert.equal(mismatch.reliefCoverage.available,0);
});

test('world wrapping reuses the real same source at z0 and never wraps the north or south limit',async()=>{
  const env=fixture(),sourceKey='https://tiles.example/0/0/0.webp',primary=bytes();
  const result=await env.send(job(1,{kind:'relief',z:0,sourceZ:0,x:-1,y:0,bytes:primary,sourceKey,halo:{tiles:[haloSource(-1,0,1,{sourceKey,bytes:primary}),haloSource(1,0,1,{sourceKey,bytes:primary})],missing:[]}}));
  assert.equal(result.error,undefined);assert.equal(env.counts().imageDecodes,1);assert.equal(result.reliefCoverage.available,2);
  assert.equal(result.reliefCoverage.missing.length,6);assert.ok(result.reliefCoverage.missing.every(item=>item.reason==='coverage'&&item.dy!==0));
});

test('the worker independently enforces the complete primary plus halo payload budget',async()=>{
  const env=fixture(),tooLarge=await env.send(job(1,{kind:'relief',bytes:new ArrayBuffer(4*1024*1024),halo:{tiles:[haloSource(-1,0,1,{bytes:new ArrayBuffer(4*1024*1024+1)})],missing:[]}}));
  assert.match(tooLarge.error,/halo.*byte budget/);assert.equal(env.counts().imageDecodes,0);assert.equal(env.outputs.length,0);
  const duplicate=await env.send(job(2,{kind:'relief',halo:{tiles:[haloSource(-1,0),haloSource(-1,0)],missing:[]}}));
  assert.match(duplicate.error,/offsets/);assert.equal(env.counts().imageDecodes,0);
});

test('online gaps next to the documented PNG256 archive use actual WEBP512 scalar averages with provenance',async()=>{
  const images=new Map([[1,sourceImage(256,()=>200)],[2,sourceImage(512,(x,y)=>x*.25+y*.5)]]),env=fixture({images});
  const result=await env.send(job(1,{kind:'relief',z:18,x:100*64,y:200*64+5,sourceZ:12,mime:'image/png',sourceKey:'/offline-map/terrain/tiles/12/100/200.png',
    halo:{tiles:[haloSource(-1,0,2,{sourceKey:'https://tiles.mapterhorn.com/12/99/200.webp',reduceToArchive:true})],missing:[]}}));
  assert.equal(result.error,undefined);assert.equal(result.reliefCoverage.sourceSize,256);assert.equal(result.reliefCoverage.available,1);assert.equal(result.reliefCoverage.missingDataFilled,false);
  assert.deepEqual(copy(result.reliefCoverage.resampled),[{dx:-1,dy:0}]);
  const strip=Object.values(env.shadeSources[0].halo['-1,0']);assert.equal(strip.length,256);assert.equal(strip[0],127.875);assert.equal(strip[255],382.875);
  assert.equal(env.counts().imageDecodes,2);assert.ok(env.decoded.every(image=>image.closed===1));
});

test('paintZoom18 over geographic z17 halves ink widths and dashes without changing source geometry or label anchors',async()=>{
  const env=fixture(),geography={z:17,x:802,y:1603,sourceZ:14};
  const normal=await env.send(job(1,geography)),fallback=await env.send(job(2,{...geography,paintZoom:18}));
  assert.equal(normal.error,undefined);assert.equal(fallback.error,undefined);assert.equal(env.counts().vectorDecodes,1,'style variants share measured source geometry, not rendered bitmaps');
  assert.deepEqual(copy(fallback.labels),copy(normal.labels));assert.equal(fallback.labels[0].x,.75);assert.equal(fallback.labels[0].y,.625);
  const before=normal.bitmap.context.strokes[1],after=fallback.bitmap.context.strokes[1];
  assert.equal(before.width,2.2);assert.equal(after.width,1.1);assert.deepEqual(before.dash,[6,5]);assert.deepEqual(after.dash,[3,2.5]);assert.deepEqual(after.path,before.path);
  assert.equal(env.vectorViews[0].z,17);assert.equal(env.vectorViews[1].z,18);assert.equal(env.vectorViews[1].size,4096);assert.equal(env.vectorViews[1].options.symbolScale,1);
  assert.equal(fallback.bitmap.width,512);assert.equal(fallback.bitmap.height,512);assert.ok(env.canvases.every(canvas=>canvas.width<=512&&canvas.height<=512));
});

test('contour paint zoom and width change independently of source height spacing and geographic crop',async()=>{
  const env=fixture(),geography={kind:'relief',z:17,x:819,y:1620,sourceZ:12,sourceKey:'https://tiles.example/12/25/50.webp'};
  const normal=await env.send(job(1,geography)),fallback=await env.send(job(2,{...geography,paintZoom:18}));
  assert.equal(normal.error,undefined);assert.equal(fallback.error,undefined);assert.equal(env.counts().imageDecodes,1);assert.equal(env.shadeSources.length,1);
  assert.equal(env.shadeSources[0].z,12);assert.equal(env.shadeSources[0].y,50);
  assert.equal(env.contourViews[0].z,17);assert.equal(env.contourViews[1].z,18);assert.equal(env.contourViews[1].options.lineScale,.5);
  assert.deepEqual(copy(env.contourViews[0].options.bounds),copy(env.contourViews[1].options.bounds));
  const before=normal.bitmap.context.strokes[0],after=fallback.bitmap.context.strokes[0];assert.ok(before.path.length>0);assert.deepEqual(after.path,before.path);assert.equal(after.width,before.width/2);
  assert.deepEqual(fallback.bitmap.context.draws[0].args,normal.bitmap.context.draws[0].args);assert.equal(fallback.bitmap.width,512);
});

test('invalid style zooms are rejected before any decoded source or render target is allocated',async()=>{
  const env=fixture();let id=0;
  for(const paintZoom of [16,17.5,19,-1,NaN,Infinity,null]){
    const result=await env.send(job(++id,{z:17,x:802,y:1603,paintZoom}));assert.match(result.error,/paint zoom/);
  }
  assert.equal(env.counts().vectorDecodes,0);assert.equal(env.counts().imageDecodes,0);assert.equal(env.canvases.length,0);assert.equal(env.outputs.length,0);
  const recovered=await env.send(job(++id,{z:17,x:802,y:1603,paintZoom:17}));assert.ok(recovered.bitmap);
});
