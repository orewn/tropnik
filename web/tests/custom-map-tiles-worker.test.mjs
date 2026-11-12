import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import ts from 'typescript';
import * as painter from '../lib/custom-map-painter.ts';
import {decodeVectorTile} from '../lib/custom-map-vector.ts';

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

function fixture({failTransfer=false,unavailablePixel=false,images=new Map(),vectorTile=vector,vectorDecoder}={}){
  const messages=[],canvases=[],outputs=[],decoded=[],shadeSources=[],contourViews=[],vectorViews=[];let vectorDecodes=0,imageDecodes=0,failedTransfer=false;
  const rgba=new Uint8ClampedArray(Array.from({length:16},(_,i)=>scalarPixel((i%4)*25+Math.floor(i/4))).flat());
  if(unavailablePixel)rgba[3]=0;
  class Bitmap{
    closed=0;constructor(width,height,sourcePixels){this.width=width;this.height=height;this.rgba=sourcePixels;}
    close(){this.closed++;}
  }
  class Context{
    constructor(canvas){this.canvas=canvas;this.draws=[];this.strokes=[];this.path=[];this.fills=[];this.rects=[];this.offset=[0,0];this.stack=[];this.dash=[];}
    save(){this.stack.push([...this.offset]);}restore(){this.offset=this.stack.pop();}
    translate(x,y){this.offset=[this.offset[0]+x,this.offset[1]+y];}
    clearRect(){}fillRect(...args){this.rects.push({args,color:this.fillStyle});}beginPath(){this.path=[];}
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
    contextRequests=[];
    getContext(type,attributes){assert.equal(type,'2d');this.contextRequests.push({type,attributes:copy(attributes??{})});return this.context;}
    transferToImageBitmap(){const bitmap=new Bitmap(this.width,this.height);bitmap.context=this.context;outputs.push(bitmap);return bitmap;}
  }
  class ImageData{constructor(data,width,height){this.data=data;this.width=width;this.height=height;}}
  const scope={exports:{},Error,Blob,DecompressionStream,Uint8Array,Uint8ClampedArray,Float32Array,ArrayBuffer,OffscreenCanvas,ImageData,
    createImageBitmap:async blob=>{imageDecodes++;const input=new Uint8Array(await blob.arrayBuffer()),image=images.get(input[0]);const bitmap=blob.type==='image/jpeg'?new Bitmap(512,512):new Bitmap(image?.size??4,image?.size??4,image?.rgba??rgba);decoded.push(bitmap);return bitmap;},
    require:name=>{
      if(name==='./custom-map-vector')return{decodeVectorTile:input=>{vectorDecodes++;return vectorDecoder?vectorDecoder(input):vectorTile;}};
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

test('zero-layer MVT uses the real decoder and paints an empty satellite overlay or ordinary opaque ground',async()=>{
  const gzip=gzipSync(new Uint8Array()),compressed=gzip.buffer.slice(gzip.byteOffset,gzip.byteOffset+gzip.byteLength);
  for(const source of [new ArrayBuffer(0),compressed]){
    const env=fixture({vectorDecoder:decodeVectorTile}),target={z:11,x:2046,y:495,sourceZ:11,sourceKey:'https://tiles.openfreemap.org/planet/20261101_080013_pt/11/2046/495.pbf',bytes:source};
    const overlay=await env.send(job(1,{...target,transparent:true})),detail=await env.send(job(2,{...target,transparent:false}));
    for(const result of [overlay,detail]){
      assert.equal(result.error,undefined);assert.equal(result.bitmap.width,512);assert.equal(result.bitmap.height,512);assert.deepEqual(copy(result.labels),[]);
      assert.equal(result.contours,0);assert.equal(result.bitmap.context.draws.length,0);assert.equal(result.bitmap.context.strokes.length,0);assert.equal(result.bitmap.context.fills.length,0);
    }
    assert.equal(overlay.bitmap.context.rects.length,0,'The empty satellite overlay paints no opaque pixels');
    assert.deepEqual(detail.bitmap.context.rects,[{args:[0,0,512,512],color:painter.CARTOGRAPHY.land}],'Ordinary detail retains its established paper colour');
    assert.deepEqual(env.counts(),{vectorDecodes:1,imageDecodes:0},'A valid empty parent is reused without fabricated objects or image decoding');
  }
});

test('empty images and malformed nonempty protobuf are rejected without producing a ready bitmap',async()=>{
  const env=fixture({vectorDecoder:decodeVectorTile});let id=0;
  const gzip=gzipSync(new Uint8Array()),compressed=gzip.buffer.slice(gzip.byteOffset,gzip.byteOffset+gzip.byteLength);
  for(const kind of ['raster','relief'])for(const bytes of [new ArrayBuffer(0),compressed]){
    const result=await env.send(job(++id,{kind,bytes}));assert.match(result.error,/Empty raster/);assert.equal(result.bitmap,undefined);
  }
  for(const bytes of [undefined,null,{},[],{byteLength:0},new Uint8Array(0)])assert.match((await env.send(job(++id,{bytes}))).error,/Invalid tile byte payload/);
  assert.ok((await env.send(job(++id,{kind:'unknown',bytes:new ArrayBuffer(0)}))).error);
  const malformed=await env.send(job(++id,{bytes:new Uint8Array([0x1a,0x01,0xff]).buffer}));assert.match(malformed.error,/Invalid vector tile/);
  assert.equal(env.outputs.length,0);assert.equal(env.counts().imageDecodes,0);
  const recovered=await env.send(job(++id,{bytes:new ArrayBuffer(0),transparent:true}));assert.ok(recovered.bitmap,'Rejecting malformed data must not poison the next valid empty tile');
});

test('software raster targets preserve fixed child pixels, source shading and parent reuse',async()=>{
  let expectedPaint;
  for(const softwareRaster of [undefined,false,true]){
    const env=fixture(),sourceKey='https://tiles.example/12/25/50.webp';
    const first=await env.send(job(1,{softwareRaster}));
    const second=await env.send(job(2,{softwareRaster,x:1606}));
    const relief=await env.send(job(3,{softwareRaster,kind:'relief',sourceZ:12,sourceKey}));
    const adjacent=await env.send(job(4,{softwareRaster,kind:'relief',sourceZ:12,sourceKey,x:1606}));
    const raster=await env.send(job(5,{softwareRaster,kind:'raster',mime:'image/jpeg'}));
    for(const result of [first,second,relief,adjacent,raster]){
      assert.equal(result.error,undefined);assert.equal(result.bitmap.width,512);assert.equal(result.bitmap.height,512);
      assert.deepEqual(result.bitmap.context.canvas.contextRequests[0].attributes,{alpha:true,willReadFrequently:softwareRaster===true});
    }
    assert.deepEqual(env.counts(),{vectorDecodes:1,imageDecodes:2},'Adjacent vector and DEM children must keep their shared decoded parents');
    assert.equal(env.shadeSources.length,1,'The same measured parent is shaded once');
    assert.equal(env.shadeSources[0].z,12);assert.equal(env.shadeSources[0].y,50);
    const shade=env.canvases.find(canvas=>canvas.context.imageData);
    assert.deepEqual(shade.contextRequests[0].attributes,{alpha:true,willReadFrequently:softwareRaster===true});
    const read=env.canvases.find(canvas=>canvas.context.draws[0]?.image===env.decoded[0]);
    assert.equal(read.contextRequests[0].attributes.willReadFrequently,true,'Measured elevation decoding retains its existing CPU readback context');
    const paint={labels:[copy(first.labels),copy(second.labels)],strokes:first.bitmap.context.strokes,shade:[...shade.context.imageData.data],raster:raster.bitmap.context.draws[0].args,contours:copy(env.contourViews),coverage:copy(relief.reliefCoverage)};
    if(expectedPaint)assert.deepEqual(paint,expectedPaint,'Raster policy must preserve coordinates, ink widths, heights, gaps and labels');else expectedPaint=paint;
    assert.ok(env.canvases.every(canvas=>canvas.width<=512&&canvas.height<=512));
    assert.ok(env.decoded.every(bitmap=>bitmap.closed===1));
  }
});

test('neighbouring display children share one decoded parent, retain crisp widths, and receive their own labels',async()=>{
  const env=fixture(),first=await env.send(job(1)),second=await env.send(job(2,{x:1606}));
  assert.equal(env.counts().vectorDecodes,1);assert.equal(env.counts().imageDecodes,0);
  assert.deepEqual(copy(first.labels),[{x:.5,y:.25,text:'Москва',kind:'place',rank:1,placeClass:'city',priorityCity:true}]);
  assert.deepEqual(copy(second.labels),[{x:.5,y:.25,text:'Сочи',kind:'place',rank:1,placeClass:'city',priorityCity:true}]);
  assert.equal(first.bitmap.width,512);assert.equal(first.bitmap.height,512);assert.equal(second.bitmap.width,512);
  assert.equal(first.bitmap.context.strokes[1].width,2.2);assert.deepEqual(first.bitmap.context.strokes[1].dash,[6,5]);
  assert.ok(env.canvases.every(canvas=>canvas.width<=512&&canvas.height<=512),'no parent-sized render target is allocated');
  assert.ok(env.outputs.every(bitmap=>bitmap.closed===0),'transferred child bitmaps belong to the receiver');
});

test('boundary variants repaint the same decoded source and preserve child roads and labels',async()=>{
  const tile=structuredClone(vector);tile.layers.boundary={name:'boundary',extent:4096,features:[{type:2,properties:{admin_level:4},geometry:[[{x:1331.2,y:1960},{x:1484.8,y:1960}]]}]};
  const original=structuredClone(tile),env=fixture({vectorTile:tile});
  const enabled=await env.send(job(1)),hidden=await env.send(job(2,{boundaries:false})),restored=await env.send(job(3,{boundaries:true}));
  assert.equal(env.counts().vectorDecodes,1,'Visibility changes must not invalidate measured parent geometry');
  assert.equal(enabled.bitmap.context.strokes.length,3);assert.equal(hidden.bitmap.context.strokes.length,2);
  assert.deepEqual(hidden.bitmap.context.strokes,enabled.bitmap.context.strokes.slice(1));
  assert.deepEqual(restored.bitmap.context.strokes,enabled.bitmap.context.strokes);
  assert.deepEqual(copy(hidden.labels),copy(enabled.labels));assert.deepEqual(copy(restored.labels),copy(enabled.labels));
  assert.ok([enabled,hidden,restored].every(result=>result.bitmap.width===512&&result.bitmap.height===512));assert.deepEqual(tile,original);
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

test('adjacent measured parents reuse compact neighbour borders without decoding the same image again',async()=>{
  const images=new Map([[1,sourceImage(4,(x,y)=>x*25+y)],[2,sourceImage(4,(x,y)=>(x-4)*25+y)]]),env=fixture({images});
  const primary={kind:'relief',z:12,sourceZ:12,x:25,y:50,sourceKey:'https://tiles.example/12/25/50.webp'};
  const first=await env.send(job(1,{...primary,halo:{tiles:[haloSource(-1,0)],missing:[]}}));
  assert.equal(first.error,undefined);assert.equal(env.counts().imageDecodes,2);
  const adjacent=await env.send(job(2,{...primary,y:51,sourceKey:'https://tiles.example/12/25/51.webp',halo:{tiles:[haloSource(-1,-1,2,{sourceKey:'https://tiles.example/12/24/50.webp'})],missing:[]}}));
  assert.equal(adjacent.error,undefined);assert.equal(env.counts().imageDecodes,3,'only the new full primary raster is decoded');
  assert.equal(adjacent.reliefCoverage.available,1);assert.equal(adjacent.reliefCoverage.missingDataFilled,false);
  assert.deepEqual(Object.values(env.shadeSources.at(-1).halo['-1,-1']),[-22],'the reused corner is the actual neighbour sample');
  assert.ok(env.decoded.every(image=>image.closed===1));
});

test('compact measured borders retain exactly 64 source entries independently of four full parents',async()=>{
  for(const fillerCount of [62,63]){
    const env=fixture(),target='https://tiles.example/12/49/50.webp';let id=0;
    const primary=(x,y,sourceKey)=>job(++id,{kind:'relief',z:12,sourceZ:12,x,y,sourceKey});
    await env.send(primary(49,50,target));
    for(let index=0;index<fillerCount;index++)await env.send(primary(1000+index,1000,`https://tiles.example/12/${1000+index}/1000.webp`));
    const last=primary(50,50,'https://tiles.example/12/50/50.webp');await env.send(last);
    const before=env.counts().imageDecodes;
    const result=await env.send({...last,id:++id,halo:{tiles:[haloSource(-1,0,1,{sourceKey:target})],missing:[]}});
    assert.equal(result.error,undefined);assert.equal(result.reliefCoverage.available,1);
    assert.equal(env.counts().imageDecodes-before,fillerCount===62?0:1,'the 65th distinct source evicts the oldest compact border, without retaining full DEM rasters');
    assert.ok(env.canvases.filter(canvas=>canvas.context.imageData&&canvas.width>1).length<=4);
  }
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

test('real contour heights are returned in child coordinates with a fixed candidate budget and shared parent shade',async()=>{
  const size=32,height=(x,y)=>100+x*40+y*20,env=fixture({images:new Map([[1,sourceImage(size,height)]])});
  const common={kind:'relief',z:14,sourceZ:12,sourceKey:'https://tiles.example/12/25/50.webp',x:102,y:201};
  const first=await env.send(job(1,common)),second=await env.send(job(2,{...common,x:103})),fallback=await env.send(job(3,{...common,paintZoom:15}));
  for(const [result,childX] of [[first,2],[second,3],[fallback,2]]){
    assert.equal(result.error,undefined);assert.ok(result.labels.length>0&&result.labels.length<=4);
    for(const label of result.labels){
      assert.equal(label.kind,'contour');assert.equal(label.text,`${label.elevation} м`);assert.equal(label.elevation%100,0);
      assert.ok(label.x>=0&&label.x<1&&label.y>=0&&label.y<1);
      const x=(childX+label.x)/4*size-.5,y=(1+label.y)/4*size-.5;
      assert.ok(Math.abs(height(x,y)-label.elevation)<1e-9,'Display child normalization must retain the measured height at the geographic anchor');
    }
  }
  assert.deepEqual(copy(fallback.labels),copy(first.labels));
  assert.equal(env.counts().imageDecodes,1);assert.equal(env.shadeSources.length,1,'No extra decoded DEM or shade is retained for contour text');
  assert.ok(env.canvases.every(canvas=>canvas.width<=512&&canvas.height<=512));
});
