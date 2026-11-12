import type * as GeoJSON from 'geojson';
import {mercatorProject} from './custom-map-camera.ts';

type Rectangle={left:number;top:number;right:number;bottom:number};
type Ring={points:Float64Array;bounds:Rectangle};
type Polygon={rings:Ring[];bounds:Rectangle};
type CoverageIndex={valid:boolean;polygons:Polygon[]};
const indexes=new WeakMap<GeoJSON.GeoJSON,CoverageIndex>();
const overlaps=(a:Rectangle,b:Rectangle)=>a.left<=b.right&&a.right>=b.left&&a.top<=b.bottom&&a.bottom>=b.top;

/** Use the same continuous longitude and Mercator segments as geometryPath.
 * Immutable geometry owns its compact index; visiting tiles adds no history. */
function ringIndex(coordinates:GeoJSON.Position[]):Ring|undefined{
  if(coordinates.length<3)return;
  const points=new Float64Array(coordinates.length*2),bounds={left:Infinity,top:Infinity,right:-Infinity,bottom:-Infinity};
  let reference=105;
  for(let i=0;i<coordinates.length;i++){
    const coordinate=coordinates[i];if(!Number.isFinite(coordinate[0])||!Number.isFinite(coordinate[1]))return;
    const longitude=coordinate[0]+360*Math.round((reference-coordinate[0])/360);reference=longitude;
    let point;try{point=mercatorProject([longitude,coordinate[1]]);}catch{return;}
    points[i*2]=point.x;points[i*2+1]=point.y;
    bounds.left=Math.min(bounds.left,point.x);bounds.top=Math.min(bounds.top,point.y);
    bounds.right=Math.max(bounds.right,point.x);bounds.bottom=Math.max(bounds.bottom,point.y);
  }
  return{points,bounds};
}

function coverageIndex(geometry:GeoJSON.GeoJSON):CoverageIndex{
  const cached=indexes.get(geometry);if(cached)return cached;
  let result:CoverageIndex={valid:true,polygons:[]};
  if(geometry.type==='Feature'||geometry.type==='FeatureCollection'||geometry.type==='GeometryCollection'){
    if(geometry.type==='Feature'&&!geometry.geometry)return{valid:false,polygons:[]};
    const children=geometry.type==='Feature'?(geometry.geometry?[geometry.geometry]:[]):geometry.type==='FeatureCollection'?geometry.features:geometry.geometries;
    for(const child of children){const index=coverageIndex(child);result.valid&&=index.valid;result.polygons.push(...index.polygons);}
  }else if(geometry.type==='Polygon'||geometry.type==='MultiPolygon'){
    for(const coordinates of geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates){
      const rings=coordinates.map(ringIndex);
      if(!rings.length||rings.some(ring=>!ring)){result.valid=false;continue;}
      const complete=rings as Ring[];result.polygons.push({rings:complete,bounds:complete[0].bounds});
    }
  }else result={valid:false,polygons:[]};
  indexes.set(geometry,result);return result;
}

function segmentIntersects(ax:number,ay:number,bx:number,by:number,rect:Rectangle){
  let start=0,end=1;
  const dx=bx-ax,dy=by-ay,p=[-dx,dx,-dy,dy],q=[ax-rect.left,rect.right-ax,ay-rect.top,rect.bottom-ay];
  for(let i=0;i<4;i++){
    if(p[i]===0){if(q[i]<0)return false;continue;}
    const t=q[i]/p[i];if(p[i]<0)start=Math.max(start,t);else end=Math.min(end,t);if(start>end)return false;
  }
  return true;
}

function ringIntersects(ring:Ring,rect:Rectangle){
  if(!overlaps(ring.bounds,rect))return false;
  const points=ring.points;
  for(let i=0,j=points.length-2;i<points.length;j=i,i+=2)if(segmentIntersects(points[j],points[j+1],points[i],points[i+1],rect))return true;
  return false;
}

function insideRing(x:number,y:number,ring:Ring){
  const points=ring.points;let inside=false;
  for(let i=0,j=points.length-2;i<points.length;j=i,i+=2){
    const ax=points[j],ay=points[j+1],bx=points[i],by=points[i+1];
    if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;
  }
  return inside;
}

/** A missing source is optional only when the actual outside mask hides every
 * pixel of its tile. Two CSS pixels conservatively protect antialiased edges.
 * Insets and source HTTP status provide no proof about geographic coverage.
 * The tile/viewport intersection remains the renderer's existing SAT test;
 * this additional test can over-request, but never omits intersecting land. */
export function mapTileIntersectsCoverage(geometry:GeoJSON.GeoJSON|undefined,tile:{z:number;x:number;y:number},cameraZoom:number,pitch=0):boolean{
  if(!geometry||typeof geometry!=='object'||!Number.isInteger(tile.z)||tile.z<0||tile.z>18||!Number.isSafeInteger(tile.x)||!Number.isInteger(tile.y)||tile.y<0||tile.y>=2**tile.z||!Number.isFinite(cameraZoom)||!Number.isFinite(pitch)||pitch<0||pitch>60)return true;
  const n=2**tile.z,margin=2/(256*2**cameraZoom*Math.cos(pitch*Math.PI/180)),rect={left:tile.x/n-margin,top:tile.y/n-margin,right:(tile.x+1)/n+margin,bottom:(tile.y+1)/n+margin};
  if(!Number.isFinite(margin)||margin<=0)return true;
  let index:CoverageIndex;try{index=coverageIndex(geometry);}catch{return true;}if(!index.valid)return true;
  for(const polygon of index.polygons){
    if(!overlaps(polygon.bounds,rect))continue;
    if(polygon.rings.some(ring=>ringIntersects(ring,rect)))return true;
    if(insideRing(rect.left,rect.top,polygon.rings[0])&&!polygon.rings.slice(1).some(ring=>insideRing(rect.left,rect.top,ring)))return true;
  }
  return false;
}
