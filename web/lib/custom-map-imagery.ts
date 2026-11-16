import type {CustomMapTile,CustomTileRequest} from './custom-map-tiles';

type Cell={z:number;x:number;y:number};
const MAX_FALLBACK=64;
const cellKey=({z,x,y}:Cell)=>`${z}/${x}/${y}`;
const parent=({z,x,y}:Cell):Cell=>({z:z-1,x:Math.floor(x/2),y:Math.floor(y/2)});
const validCell=(cell:Cell,maxZoom:number)=>Number.isInteger(cell.z)&&cell.z>=0&&cell.z<=maxZoom&&Number.isSafeInteger(cell.x)&&Number.isSafeInteger(cell.y)&&cell.y>=0&&cell.y<2**cell.z;
function intersects(a:Cell,b:Cell):boolean{
  const small=a.z>=b.z?a:b,large=a.z>=b.z?b:a,factor=2**(small.z-large.z);
  return Math.floor(small.x/factor)===large.x&&Math.floor(small.y/factor)===large.y;
}
function childrenCovered(cell:Cell,coverage:ReadonlySet<string>):boolean{
  const z=cell.z+1,x=cell.x*2,y=cell.y*2;
  return coverage.has(`${z}/${x}/${y}`)&&coverage.has(`${z}/${x+1}/${y}`)&&coverage.has(`${z}/${x}/${y+1}`)&&coverage.has(`${z}/${x+1}/${y+1}`);
}
/** Proof cells are keys only: collapsing four children never creates a bitmap. */
function coverageOf(tiles:readonly Cell[]):Set<string>{
  const coverage=new Set<string>();
  for(const tile of tiles){
    let cell:Cell=tile;coverage.add(cellKey(cell));
    while(cell.z>0){
      const ancestor=parent(cell);if(!childrenCovered(ancestor,coverage))break;
      coverage.add(cellKey(ancestor));cell=ancestor;
    }
  }
  return coverage;
}
function coveredBy(coverage:ReadonlySet<string>,tile:Cell):boolean{
  let cell:Cell=tile;
  for(;;){if(coverage.has(cellKey(cell)))return true;if(cell.z===0)return false;cell=parent(cell);}
}
function coarseFirst(tiles:CustomMapTile[]):CustomMapTile[]{return tiles.sort((a,b)=>a.z-b.z);}
function minimalCover(tiles:readonly CustomMapTile[]):CustomMapTile[]{
  const result:CustomMapTile[]=[],coverage=new Set<string>();
  for(const tile of coarseFirst([...tiles]))if(!coveredBy(coverage,tile)){result.push(tile);coverage.add(cellKey(tile));}
  return result;
}
/** Remove actual redundant draws only when space is required. A complete set
 * of real children may replace its parent; otherwise that parent stays. */
function compactCoverage(tiles:CustomMapTile[],limit:number):CustomMapTile[]{
  let result=coarseFirst([...tiles]);
  while(result.length>limit){
    const coverage=coverageOf(result),actual=new Set(result.map(cellKey));
    const index=result.findIndex(tile=>childrenCovered(tile,coverage)||(tile.z>0&&coveredBy(actual,parent(tile))));
    if(index<0)break;
    result=result.filter((_,at)=>at!==index);
  }
  return result;
}

/** Retain a bounded real-image fallback between camera generations.
 *
 * Requests must be one provider on one XYZ grid, with at most 64 cells.
 * Previous fallback coverage is preserved for valid bounded input (previous
 * has at most limit visible, distinct tiles). Additional ready detail yields
 * to that coverage under pressure. Oversized malformed input is best effort.
 * No source data, tile object, bitmap lifetime, request or pin is changed.
 * World-copy x coordinates remain unwrapped, including negative x.
 */
export function retainImageryFallback(previous:readonly CustomMapTile[],ready:readonly CustomMapTile[],requests:readonly CustomTileRequest[],limit=MAX_FALLBACK):CustomMapTile[]{
  const capacity=Number.isFinite(limit)?Math.max(0,Math.min(MAX_FALLBACK,Math.floor(limit))):0;
  if(!capacity||!requests.length||requests.length>MAX_FALLBACK)return[];
  const kind=requests[0].kind,maxZoom=kind==='eox-s2'?14:kind==='eox-bluemarble'?8:-1,z=requests[0].z;
  if(maxZoom<0||requests.some(request=>request.kind!==kind||request.z!==z||!validCell(request,maxZoom)))return[];
  const normalize=(tiles:readonly CustomMapTile[])=>{
    const unique=new Map<string,CustomMapTile>();
    for(const tile of tiles){
      if(tile.kind!==kind||!validCell(tile,maxZoom)||tile.bitmap?.width!==512||tile.bitmap?.height!==512||!requests.some(request=>intersects(tile,request)))continue;
      unique.set(cellKey(tile),tile);
    }
    return coarseFirst([...unique.values()]);
  };
  let retained=compactCoverage(normalize(previous),capacity).slice(0,capacity);
  const incoming=normalize(ready),incomingCoverage=coverageOf(incoming);
  const replace=(additions:readonly CustomMapTile[])=>{
    const coverage=coverageOf(additions);
    return [...retained.filter(tile=>!coveredBy(coverage,tile)),...additions];
  };
  // Replace complete groups atomically. Four real children may replace one
  // parent even when keeping that parent as a fifth draw would exceed the cap.
  for(const tile of [...retained])if(coveredBy(incomingCoverage,tile)){
    const group=minimalCover(incoming.filter(candidate=>intersects(tile,candidate)));
    const proposal=compactCoverage(replace(group),capacity);
    if(proposal.length<=capacity)retained=proposal;
  }
  // New geographical coverage takes any spare room before extra detail inside
  // an already covered cell. Redundant old refinements can yield that room.
  for(const tile of incoming)if(!coveredBy(coverageOf(retained),tile)){
    const proposal=compactCoverage(replace([tile]),capacity);
    if(proposal.length<=capacity)retained=proposal;
  }
  for(const tile of incoming){
    if(retained.includes(tile))continue;
    const proposal=replace([tile]);
    if(proposal.length<=capacity)retained=proposal;
  }
  return coarseFirst(retained);
}
