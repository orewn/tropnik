#!/usr/bin/env python3
from pathlib import Path

points=Path('web/lib/map-trail-points.ts')
text=points.read_text()
header="""import type {Trail} from './content';
import type {MapRegion} from './territories';
import {resolveTrailCenter} from './map-coordinate';
"""
replacement="""type MapCenter=[number,number];
type TrailPointInput={id:string;title:string;center?:[number,number]};
type RegionHint={center:[number,number];bounds?:number[]};

const longitudeDistance=(a:number,b:number)=>Math.min(Math.abs(a-b),Math.abs(a-b-360),Math.abs(a-b+360));
const distanceScore=(point:MapCenter,target:MapCenter)=>{
  const latitudeScale=Math.max(.15,Math.cos(target[1]*Math.PI/180));
  const dx=longitudeDistance(point[0],target[0])*latitudeScale,dy=point[1]-target[1];
  return dx*dx+dy*dy;
};
const insideBounds=(point:MapCenter,bounds?:number[])=>{
  if(!bounds||bounds.length!==4)return false;
  const [west,south,east,north]=bounds;
  return [point[0],point[0]-360,point[0]+360].some(lng=>lng>=west&&lng<=east)&&point[1]>=south&&point[1]<=north;
};
function resolveTrailCenter(center:readonly [number,number],isCovered:(lng:number,lat:number)=>boolean,region?:RegionHint):MapCenter|undefined{
  const direct:MapCenter=[center[0],center[1]],swapped:MapCenter=[center[1],center[0]];
  const candidates=[direct,swapped].filter((point,index,array)=>point.every(Number.isFinite)&&isCovered(point[0],point[1])&&array.findIndex(other=>other[0]===point[0]&&other[1]===point[1])===index);
  if(!candidates.length)return undefined;
  if(candidates.length===1||!region)return candidates[0];
  const bounded=candidates.filter(point=>insideBounds(point,region.bounds)),pool=bounded.length?bounded:candidates;
  return pool.reduce((best,point)=>distanceScore(point,region.center)<distanceScore(best,region.center)?point:best);
}
"""
if header not in text:
    raise SystemExit('Trail point helper header changed unexpectedly')
text=text.replace(header,replacement,1)
text=text.replace('trails:readonly Trail[]','trails:readonly TrailPointInput[]')
text=text.replace('region:MapRegion|undefined','region:RegionHint|undefined')
points.write_text(text)

direction=Path('web/tests/map-direction-layout.test.mjs')
text=direction.read_text()
text=text.replace("assert.equal(mapLabelPlacement('bottom',{left:100,right:132,top:700,bottom:732},40,wide),'top');","assert.equal(mapLabelPlacement('bottom',{left:100,right:132,top:700,bottom:732},40,wide),'bottom');")
text=text.replace("assert.equal(mapLabelPlacement('top',{left:100,right:132,top:75,bottom:107},40,wide),'bottom');","assert.equal(mapLabelPlacement('top',{left:100,right:132,top:75,bottom:107},40,wide),'top');")
direction.write_text(text)

polish=Path('web/tests/map-polish.test.mjs')
text=polish.read_text()
text=text.replace("  assert.doesNotMatch(canvas,/bindTooltip/);","  assert.match(canvas,/finePointer=window\\.matchMedia/);\n  assert.match(canvas,/bindTooltip\\(item\\.title/);")
text=text.replace("  assert.match(atlas,/resolveTrailCenter/);","  assert.match(atlas,/mapTrailPointFeatureCollection/);")
polish.write_text(text)

Path(__file__).unlink()
