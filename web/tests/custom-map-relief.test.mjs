import test from 'node:test';
import assert from 'node:assert/strict';
import {reliefContourIntervals} from '../lib/custom-map-relief.ts';
import {elevationBorder,paintContours,reliefPixels} from '../lib/custom-map-painter.ts';

class Context {
  strokes=[];path=[];
  beginPath(){this.path=[];}
  moveTo(x,y){this.path.push([x,y]);}
  lineTo(x,y){this.path.push([x,y]);}
  stroke(){this.strokes.push({path:this.path,width:this.lineWidth,color:this.strokeStyle});}
}
const raster=(size,fn,tx=0,ty=0)=>Float32Array.from({length:size*size},(_,i)=>fn(tx*size+i%size,ty*size+Math.floor(i/size)));
const halo=(size,fn)=>Object.fromEntries([-1,0,1].flatMap(dy=>[-1,0,1].filter(dx=>dx||dy).map(dx=>[`${dx},${dy}`,elevationBorder(raster(size,fn,dx,dy),size,size,dx,dy)])));
const metresAt=(size,y,z,row)=>40075016.68557849*Math.cos(Math.atan(Math.sinh(Math.PI*(1-2*(y+(row+.5)/size)/2**z))))/(2**z*size);

test('the contour interval contract distinguishes display hierarchy from source resolution',()=>{
  for(const zoom of [-1,0,9.99,NaN,Infinity])assert.equal(reliefContourIntervals(zoom),null);
  for(const zoom of [10,11,11.99])assert.deepEqual(reliefContourIntervals(zoom),{minorM:100,indexM:500});
  for(const zoom of [12,13,13.99])assert.deepEqual(reliefContourIntervals(zoom),{minorM:50,indexM:250});
  for(const zoom of [14,16,18])assert.deepEqual(reliefContourIntervals(zoom),{minorM:25,indexM:100});
});

test('multidirectional hillshade agrees with independent GDAL plane references in east/south axes',()=>{
  // Reference bytes from GDAL DEMProcessing(multidirectional=True,
  // altitude=45,zFactor=1) on metre-scaled planes. Their 8-bit rounding gives
  // a tolerance of at most two output alpha units after our display transfer.
  const references=[[0,0,181],[.5,0,230],[0,.5,202],[-.5,0,93],[0,-.5,121],[.5,.5,236],[.5,-.5,199],[-.5,.5,96],[-.5,-.5,59],[2,0,218]];
  const size=5,y=1441,z=12,metres=metresAt(size,y,z,2);
  for(const [east,south,reference] of references){
    const heights=raster(size,(x,y)=>1000+(x-2)*east*metres+(y-2)*south*metres),original=heights.slice();
    const pixels=reliefPixels(heights,size,y,z),pixel=pixels.slice((2*size+2)*4,(2*size+3)*4);
    if(!east&&!south){assert.equal(pixel[3],0);continue;}
    const delta=(reference-1)/254-Math.SQRT1_2,dark=delta<0,alpha=Math.min(dark?148:108,Math.abs(delta)*(dark?300:360));
    assert.ok(Math.abs(pixel[3]-alpha)<=2,`${east},${south}: ${pixel[3]} vs ${alpha}`);
    assert.deepEqual([...pixel.slice(0,3)],dark?[45,60,54]:[255,251,231]);
    assert.deepEqual(heights,original);
  }
});

test('flat heights stay transparent and an elevation datum shift cannot change hillshade',()=>{
  const size=8,flat=()=>270,plane=(x,y)=>200+x*25-y*50;
  assert.ok(reliefPixels(raster(size,flat),size,1441,12,halo(size,flat)).every((value,index)=>index%4!==3||value===0));
  assert.deepEqual(reliefPixels(raster(size,plane),size,1441,12,halo(size,plane)),reliefPixels(raster(size,(x,y)=>plane(x,y)+3000),size,1441,12,halo(size,(x,y)=>plane(x,y)+3000)));
});

test('the curvature cue distinguishes measured crests and hollows but remains strictly bounded',()=>{
  for(const [height,dark] of [[2000,false],[-2000,true]]){
    const heights=new Float32Array(9);heights[4]=height;
    const pixel=reliefPixels(heights,3,1441,12).slice(16,20);
    assert.ok(pixel[3]>0&&pixel[3]<=13,'A symmetric extremum has zero gradient and only the small curvature cue');
    assert.deepEqual([...pixel.slice(0,3)],dark?[45,60,54]:[255,251,231]);
  }
});

test('an absent diagonal produces a transparent unknown corner without changing measured interior pixels',()=>{
  const size=8,fn=(x,y)=>200+x*25+y*50,heights=raster(size,fn),complete=halo(size,fn);
  const known=reliefPixels(heights,size,1441,12,complete),missing={...complete};delete missing['1,1'];
  const actual=reliefPixels(heights,size,1441,12,missing),corner=(size*size-1)*4;
  assert.ok(known[corner+3]>0);assert.equal(actual[corner+3],0);
  assert.deepEqual(actual.slice(0,corner),known.slice(0,corner));
});

test('minor and index contours retain every measured crossing exactly once with a distinct hierarchy',()=>{
  const heights=Float32Array.from([0,500,0,500]),context=new Context();
  assert.equal(paintContours(context,heights,2,14,512,{lineScale:1}),19);
  assert.equal(context.strokes.length,2);const [minor,index]=context.strokes;
  assert.ok(index.width>minor.width);assert.notEqual(index.color,minor.color);
  assert.equal(minor.path.length/2,15);assert.equal(index.path.length/2,4);
  const levels=stroke=>Array.from({length:stroke.path.length/2},(_,i)=>Math.round((stroke.path[2*i][0]-128)/256*500));
  assert.deepEqual(levels(index),[100,200,300,400]);
  assert.deepEqual([...levels(minor),...levels(index)].sort((a,b)=>a-b),Array.from({length:19},(_,i)=>(i+1)*25));
  const overzoom=new Context();paintContours(overzoom,heights,2,18,32768,{lineScale:.5});
  assert.deepEqual(overzoom.strokes.map(stroke=>stroke.width),context.strokes.map(stroke=>stroke.width/2));
  assert.deepEqual([...heights],[0,500,0,500]);
});

test('numeric contour candidates are capped, cropped and anchored to the actual interpolated index levels',()=>{
  const size=32,fn=(x,y)=>x*50+y*12.5,heights=raster(size,fn),original=heights.slice(),context=new Context(),labels=[];
  const bounds={left:.5,top:.25,right:.75,bottom:.5};
  paintContours(context,heights,size,14,2048,{lineScale:1,bounds,labels});
  assert.ok(labels.length>0&&labels.length<=4);
  for(const label of labels){
    assert.equal(label.kind,'contour');assert.equal(label.text,`${label.elevation} м`);assert.equal(label.elevation%100,0);
    assert.ok(label.x>=bounds.left&&label.x<bounds.right&&label.y>=bounds.top&&label.y<bounds.bottom);
    assert.ok(Math.abs(fn(label.x*size-.5,label.y*size-.5)-label.elevation)<1e-9,'The label height comes from its actual marching-squares crossing');
    const point=[label.x*2048,label.y*2048],path=context.strokes.at(-1).path;
    assert.ok(path.some((a,i)=>{if(i%2)return false;const b=path[i+1],dx=b[0]-a[0],dy=b[1]-a[1];return Math.abs((point[0]-a[0])*dy-(point[1]-a[1])*dx)<1e-8&&(point[0]-a[0])*(point[0]-b[0])+(point[1]-a[1])*(point[1]-b[1])<=1e-8;}));
  }
  assert.deepEqual(heights,original);
  const empty=[];paintContours(new Context(),new Float32Array(16).fill(100),4,14,512,{labels:empty});assert.deepEqual(empty,[]);
  const overview=[];paintContours(new Context(),heights,size,11,512,{labels:overview});assert.deepEqual(overview,[]);
});
