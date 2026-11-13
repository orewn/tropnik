import {decodeVectorTile,type VectorTile} from './custom-map-vector';
import {decodeTerrarium,elevationBorder,paintContours,paintVectorTile,reliefPixels,type TilePaintBounds,type ReliefCoverage,type ReliefHalo,type ReliefHaloKey,type ReliefHaloOffset,type ReliefHaloPayload,type ReliefHaloSource} from './custom-map-painter';

type TileJob={id:number;kind:'vector'|'relief'|'raster';bytes:ArrayBuffer;z:number;x?:number;y:number;paintZoom?:number;sourceZ?:number;sourceKey?:string;paths:boolean;transparent?:boolean;boundaries?:boolean;softwareRaster?:boolean;mime?:string;halo?:ReliefHaloPayload};
type RenderWindow={factor:number;childX:number;childY:number;sourceX:number;sourceY:number;sourceZ:number;paintSize:number;bounds:TilePaintBounds};
type ParentBase={bytes:number};
type VectorParent=ParentBase&{kind:'vector';tile:VectorTile};
type ReliefParent=ParentBase&{kind:'relief';heights:Float32Array;size:number;shade:OffscreenCanvas;shaded:boolean;halo:ReliefHalo;haloSources:Partial<Record<ReliefHaloKey,{key:string;resampled:boolean}>>};
type Parent=VectorParent|ReliefParent;
type ElevationBorders={size:number;sourceSize:number;values:ReliefHalo;bytes:number;resampled:boolean};
const TILE_SIZE=512,MAX_BYTES=8*1024*1024,MAX_PARENTS=4,MAX_PARENT_BYTES=24*1024*1024,MAX_BORDER_TILES=64,MAX_BORDER_BYTES=2*1024*1024;
const parents=new Map<string,Parent>();let parentBytes=0,busy=false;
const borders=new Map<string,ElevationBorders>();let borderBytes=0;

/** Display tiles retain their own 512px raster even above the source's zoom.
 * Negative/world-copy x values select the same parent and positive child. */
export function tileRenderWindow(z:number,x:number,y:number,sourceZ=z):RenderWindow{
  if(!Number.isInteger(z)||z<0||z>18||!Number.isInteger(sourceZ)||sourceZ<0||sourceZ>z||!Number.isSafeInteger(x)||!Number.isInteger(y)||y<0||y>=2**z)throw new Error('Invalid display/source tile coordinates');
  const factor=2**(z-sourceZ),rawSourceX=Math.floor(x/factor),sourceY=Math.floor(y/factor);
  const childX=x-rawSourceX*factor,childY=y-sourceY*factor,count=2**sourceZ;
  return{factor,childX,childY,sourceX:((rawSourceX%count)+count)%count,sourceY,sourceZ,paintSize:TILE_SIZE*factor,
    bounds:{left:childX/factor,top:childY/factor,right:(childX+1)/factor,bottom:(childY+1)/factor}};
}
function release(parent:Parent){if(parent.kind==='relief'){parent.shade.width=1;parent.shade.height=1;}}
function remember(key:string|undefined,parent:Parent){
  if(!key)return false;
  if(parent.bytes>MAX_PARENT_BYTES){for(const cached of parents.values())release(cached);parents.clear();parentBytes=0;return false;}
  while(parents.size>=MAX_PARENTS||parentBytes+parent.bytes>MAX_PARENT_BYTES){
    const oldest=parents.keys().next().value;if(oldest===undefined)break;
    const cached=parents.get(oldest)!;parents.delete(oldest);parentBytes-=cached.bytes;release(cached);
  }
  parents.set(key,parent);parentBytes+=parent.bytes;return true;
}
function vectorBytes(tile:VectorTile){
  let bytes=0;
  for(const layer of Object.values(tile.layers))for(const feature of layer.features){
    bytes+=128;for(const part of feature.geometry)bytes+=32+part.length*48;
    for(const [key,value] of Object.entries(feature.properties))bytes+=64+key.length*2+(typeof value==='string'?value.length*2:8);
  }
  return bytes;
}
async function unpack(input:ArrayBuffer,allowEmptyVector=false){
  if(!(input instanceof ArrayBuffer))throw new Error('Invalid tile byte payload');
  if(input.byteLength>MAX_BYTES)throw new Error('Tile exceeds the byte budget');
  if(!input.byteLength&&!allowEmptyVector)throw new Error('Empty raster tile');
  const signature=new Uint8Array(input,0,Math.min(input.byteLength,2));
  if(signature[0]!==31||signature[1]!==139)return input;
  const reader=new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks:Uint8Array[]=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>MAX_BYTES)throw new Error('Decoded tile exceeds budget');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  if(!length&&!allowEmptyVector)throw new Error('Empty raster tile');
  const decompressed=new Uint8Array(length);let offset=0;for(const chunk of chunks){decompressed.set(chunk,offset);offset+=chunk.length;}
  return decompressed.buffer;
}
async function readElevation(bytes:ArrayBuffer,mime='image/webp'){
  const bitmap=await createImageBitmap(new Blob([bytes],{type:mime}),{colorSpaceConversion:'none',premultiplyAlpha:'none'});
  let source:OffscreenCanvas|undefined,heights:Float32Array,size:number;
  try{
    if(bitmap.width!==bitmap.height||bitmap.width>1024||bitmap.width<2)throw new Error('Elevation tile exceeds dimensions');
    size=bitmap.width;source=new OffscreenCanvas(size,size);const read=source.getContext('2d',{willReadFrequently:true});
    if(!read)throw new Error('Elevation decoder unavailable');
    read.drawImage(bitmap,0,0);heights=decodeTerrarium(read.getImageData(0,0,size,size).data,size,size);
  }finally{bitmap.close();if(source){source.width=1;source.height=1;}}
  return{heights,size};
}
async function elevationParent(bytes:ArrayBuffer,mime:string|undefined):Promise<ReliefParent>{
  const {heights,size}=await readElevation(bytes,mime);
  return{kind:'relief',heights,size,shade:new OffscreenCanvas(size,size),shaded:false,halo:{},haloSources:{},
    // Reserve the complete border in the LRU budget even before it is loaded.
    bytes:heights.byteLength+size*size*4+(4*size+4)*4};
}
function haloKey(offset:ReliefHaloOffset):ReliefHaloKey{return `${offset.dx},${offset.dy}` as ReliefHaloKey;}
function borderKey(sourceKey:string,size:number,allowReduction=false){return `${sourceKey}:border:${size}:${allowReduction?1:0}`;}
function measuredBorders(source:{heights:Float32Array;size:number},size:number,reduce=false):ElevationBorders{
  const values:ReliefHalo={};let bytes=0;
  for(const dy of [-1,0,1] as const)for(const dx of [-1,0,1] as const)if(dx||dy){
    const strip=elevationBorder(source.heights,source.size,size,dx,dy,reduce);values[haloKey({dx,dy})]=strip;bytes+=strip.byteLength;
  }
  return{size,sourceSize:source.size,values,bytes,resampled:reduce};
}
function rememberBorders(key:string,value:ElevationBorders){
  const old=borders.get(key);if(old){borders.delete(key);borderBytes-=old.bytes;}
  while(borders.size>=MAX_BORDER_TILES||borderBytes+value.bytes>MAX_BORDER_BYTES){
    const oldest=borders.keys().next().value;if(oldest===undefined)break;
    borderBytes-=borders.get(oldest)!.bytes;borders.delete(oldest);
  }
  if(value.bytes<=MAX_BORDER_BYTES){borders.set(key,value);borderBytes+=value.bytes;}
  return value;
}
function validateHalo(job:TileJob){
  const halo=job.halo;if(!halo)return;
  if(!Array.isArray(halo.tiles)||!Array.isArray(halo.missing)||halo.tiles.length+halo.missing.length>8)throw new Error('Invalid elevation halo payload');
  const offsets=new Set<string>(),buffers=new Set<ArrayBuffer>([job.bytes]);let bytes=job.bytes.byteLength;
  for(const item of [...halo.tiles,...halo.missing]){
    if(![item.dx,item.dy].every(value=>Number.isInteger(value)&&Math.abs(value)<=1)||!item.dx&&!item.dy||offsets.has(haloKey(item)))throw new Error('Invalid elevation halo offsets');
    offsets.add(haloKey(item));
    if('bytes' in item){
      if(!item.bytes?.byteLength||typeof item.sourceKey!=='string'||item.sourceKey.length>4096)throw new Error('Invalid elevation halo source');
      if(!buffers.has(item.bytes)){buffers.add(item.bytes);bytes+=item.bytes.byteLength;}
    }
  }
  if(bytes>MAX_BYTES)throw new Error('Elevation halo exceeds the byte budget');
}
async function prepareRelief(parent:ReliefParent,job:TileJob,view:RenderWindow):Promise<ReliefCoverage>{
  const needed:ReliefHaloOffset[]=[];
  for(const dy of [-1,0,1] as const)for(const dx of [-1,0,1] as const){
    if(!dx&&!dy||dx<0&&view.childX!==0||dx>0&&view.childX!==view.factor-1||dy<0&&view.childY!==0||dy>0&&view.childY!==view.factor-1)continue;
    needed.push({dx,dy});
  }
  const required=new Set(needed.map(haloKey)),missing=new Map((job.halo?.missing??[]).map(item=>[haloKey(item),item.reason]));
  const groups=new Map<string,ReliefHaloSource[]>();let changed=false;
  for(const item of job.halo?.tiles??[]){
    const key=haloKey(item),signature=`${item.sourceKey}:${item.reduceToArchive?1:0}`;
    if(!required.has(key)||parent.haloSources[key]?.key===signature)continue;
    if(view.sourceY+item.dy<0||view.sourceY+item.dy>=2**view.sourceZ){missing.set(key,'coverage');continue;}
    const group=groups.get(signature);if(group)group.push(item);else groups.set(signature,[item]);
  }
  // Decode at most one extra raster at a time and retain only its 1px border.
  // Existing measured parents can supply those pixels without another decode.
  for(const [signature,items] of groups){
    const first=items[0],count=2**view.sourceZ,nx=((view.sourceX+first.dx)%count+count)%count,ny=view.sourceY+first.dy;
    const sourceKey=`relief:${view.sourceZ}/${nx}/${ny}:${first.sourceKey}`;
    const cached=first.sourceKey===job.sourceKey&&nx===view.sourceX&&ny===view.sourceY?parent:parents.get(sourceKey);
    try{
      const allowReduction=!!first.reduceToArchive&&job.mime==='image/png'&&!!job.sourceKey?.startsWith('/offline-map/terrain/tiles/')&&first.sourceKey.startsWith('https://tiles.mapterhorn.com/')&&parent.size===256;
      const key=borderKey(sourceKey,parent.size,allowReduction);let border=borders.get(key);
      if(border){borders.delete(key);borders.set(key,border);}
      else{
        const source=cached?.kind==='relief'?cached:await readElevation(await unpack(first.bytes),first.mime);
        const reduce=allowReduction&&source.size===512;
        if(source.size!==parent.size&&!reduce){for(const item of items)missing.set(haloKey(item),'resolution');continue;}
        // A viewport's neighbouring parents repeatedly need the same measured
        // edges. Retain only those strips, never 64 full DEMs or GPU targets.
        border=rememberBorders(key,measuredBorders(source,parent.size,reduce));
      }
      for(const item of items){
        const key=haloKey(item);parent.halo[key]=border.values[key];
        parent.haloSources[key]={key:signature,resampled:border.resampled};missing.delete(key);changed=true;
      }
    }catch{for(const item of items)missing.set(haloKey(item),'invalid');}
  }
  if(changed||!parent.shaded){
    const context=parent.shade.getContext('2d',{alpha:true,willReadFrequently:!!job.softwareRaster});if(!context)throw new Error('Relief painter unavailable');
    // Physical spacing and latitude belong to the measured parent. Unknown
    // outside derivatives stay transparent; no edge-clamped terrain is made.
    context.putImageData(new ImageData(new Uint8ClampedArray(reliefPixels(parent.heights,parent.size,view.sourceY,view.sourceZ,parent.halo)),parent.size,parent.size),0,0);
    parent.shaded=true;
  }
  const unavailable:ReliefCoverage['missing']=[],resampled:ReliefHaloOffset[]=[];let available=0;
  for(const offset of needed){
    const key=haloKey(offset);
    if(parent.halo[key]){available++;if(parent.haloSources[key]?.resampled)resampled.push(offset);}
    else unavailable.push({...offset,reason:view.sourceY+offset.dy<0||view.sourceY+offset.dy>=2**view.sourceZ?'coverage':missing.get(key)??'unavailable'});
  }
  return{sourceSize:parent.size,required:needed.length,available,missing:unavailable,resampled,missingDataFilled:false};
}
self.onmessage=async({data:job}:MessageEvent<TileJob>)=>{
  if(busy){self.postMessage({id:job.id,error:'Tile painter is busy'});return;}
  busy=true;let decoded:ImageBitmap|undefined,painted:ImageBitmap|undefined,parent:Parent|undefined,retained=false;
  try{
    if(!(job.bytes instanceof ArrayBuffer))throw new Error('Invalid tile byte payload');
    if(job.bytes.byteLength>MAX_BYTES)throw new Error('Tile exceeds the byte budget');
    if(!job.bytes.byteLength&&job.kind!=='vector')throw new Error('Empty raster tile');
    const view=tileRenderWindow(job.z,job.x??0,job.y,job.sourceZ??job.z);
    const paintZoom=job.paintZoom===undefined?job.z:job.paintZoom;
    if(!Number.isInteger(paintZoom)||paintZoom<job.z||paintZoom>18)throw new Error('Invalid map paint zoom');
    // Viewport-budget fallback changes geographic tile coverage, not the
    // intended on-screen ink width. Keep the fixed 512px output allocation.
    const paintScale=2**(job.z-paintZoom);
    validateHalo(job);
    // Ordinary vector tiles begin with a full opaque paper fill, including
    // cropped children and empty MVTs. Declare that same opacity to Canvas so
    // repeated map blits do not carry an unnecessary transparent source.
    // Satellite overlays, measured relief and decoded imagery keep alpha.
    const canvas=new OffscreenCanvas(TILE_SIZE,TILE_SIZE),context=canvas.getContext('2d',{alpha:job.kind!=='vector'||!!job.transparent,willReadFrequently:!!job.softwareRaster});
    if(!context)throw new Error('Tile painter unavailable');
    let labels:ReturnType<typeof paintVectorTile>=[],contours=0,reliefCoverage:ReliefCoverage|undefined;
    if(job.kind==='raster'){
      decoded=await createImageBitmap(new Blob([await unpack(job.bytes)],{type:job.mime||'image/jpeg'}));
      if(decoded.width>1024||decoded.height>1024||decoded.width<1||decoded.height<1)throw new Error('Raster tile exceeds dimensions');
      context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';
      context.drawImage(decoded,-view.childX*TILE_SIZE,-view.childY*TILE_SIZE,view.paintSize,view.paintSize);
    }else{
      if(job.kind!=='vector'&&job.kind!=='relief')throw new Error('Unknown tile kind');
      const key=typeof job.sourceKey==='string'&&job.sourceKey.length<=4096?`${job.kind}:${view.sourceZ}/${view.sourceX}/${view.sourceY}:${job.sourceKey}`:undefined;
      parent=key?parents.get(key):undefined;
      if(parent&&key){parents.delete(key);parents.set(key,parent);retained=true;}
      else{
        const bytes=await unpack(job.bytes,job.kind==='vector');
        if(job.kind==='vector'){const tile=decodeVectorTile(bytes);parent={kind:'vector',tile,bytes:vectorBytes(tile)};}
        else{
          parent=await elevationParent(bytes,job.mime);
          if(key)rememberBorders(borderKey(key,parent.size),measuredBorders(parent,parent.size));
        }
        retained=remember(key,parent);
      }
      context.save();context.translate(-view.childX*TILE_SIZE,-view.childY*TILE_SIZE);
      try{
        if(parent.kind==='vector'){
          labels=paintVectorTile(context,parent.tile,paintZoom,view.paintSize,job.paths,!!job.transparent,
            {symbolScale:2*paintScale,labelBounds:view.bounds,geometryBounds:view.bounds,boundaries:job.boundaries})
            .map(label=>({...label,x:label.x*view.factor-view.childX,y:label.y*view.factor-view.childY}));
        }else{
          reliefCoverage=await prepareRelief(parent,job,view);
          context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';
          context.drawImage(parent.shade,0,0,view.paintSize,view.paintSize);
          contours=paintContours(context,parent.heights,parent.size,paintZoom,view.paintSize,{lineScale:paintScale,bounds:view.bounds,halo:parent.halo,labels});
          labels=labels.map(label=>({...label,x:label.x*view.factor-view.childX,y:label.y*view.factor-view.childY}));
        }
      }finally{context.restore();}
    }
    painted=canvas.transferToImageBitmap();self.postMessage({id:job.id,bitmap:painted,labels,contours,...(reliefCoverage?{reliefCoverage}:{})},{transfer:[painted]});painted=undefined;
  }catch(error){self.postMessage({id:job.id,error:error instanceof Error?error.message:'Map tile could not be prepared'});}
  finally{decoded?.close();painted?.close();if(parent&&!retained)release(parent);busy=false;}
};
