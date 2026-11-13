import type {TrailRasterWorkerRequest} from './custom-map-trail-raster';

const MAX_BYTES=32*1024*1024,MAX_PARTS=100000,MAX_DIMENSION=16384;
const parts=new Map<number,{path:Path2D;bytes:number}>();
let retainedBytes=0;
const validId=(id:number)=>Number.isSafeInteger(id)&&id>0;

/** Registered parts are already projected and verified by the main loader.
 * This worker only moves the unchanged two-pass Canvas paint off the UI thread. */
self.onmessage=({data:job}:MessageEvent<TrailRasterWorkerRequest>)=>{
  let bitmap:ImageBitmap|undefined;
  try{
    if(!validId(job.id)||!Number.isInteger(job.width)||!Number.isInteger(job.height)||job.width<=0||job.height<=0||job.width>MAX_DIMENSION||job.height>MAX_DIMENSION||job.width*job.height*4>MAX_BYTES)throw new Error('Invalid trail backing frame');
    if(!Array.isArray(job.transform)||job.transform.length!==6||!job.transform.every(Number.isFinite)||!Number.isFinite(job.transform[0]*job.transform[3]-job.transform[1]*job.transform[2])||job.transform[0]*job.transform[3]===job.transform[1]*job.transform[2])throw new Error('Invalid trail transform');
    if(![job.haloWidth,job.lineWidth].every(value=>Number.isFinite(value)&&value>0)||job.haloWidth<job.lineWidth||![job.haloColor,job.lineColor].every(value=>typeof value==='string'&&value.length>0&&value.length<=128))throw new Error('Invalid trail paint');
    if(!Array.isArray(job.partIds)||job.partIds.length>MAX_PARTS||!job.partIds.every(validId)||!Array.isArray(job.dropPartIds)||job.dropPartIds.length>MAX_PARTS||!job.dropPartIds.every(validId)||!Array.isArray(job.addParts)||job.addParts.length>MAX_PARTS)throw new Error('Invalid trail part registration');
    for(const id of job.dropPartIds){const old=parts.get(id);if(old){retainedBytes-=old.bytes;parts.delete(id);}}
    const additions=new Map<number,{path:Path2D;bytes:number}>();let bytes=retainedBytes;
    for(const part of job.addParts){
      if(!validId(part.id)||parts.has(part.id)||additions.has(part.id)||!(part.points instanceof Float64Array)||part.points.length<4||part.points.length%2||!part.points.every(Number.isFinite))throw new Error('Invalid projected trail part');
      bytes+=part.points.byteLength;
      if(bytes>MAX_BYTES||parts.size+additions.size+1>MAX_PARTS)throw new Error('Trail part memory budget exceeded');
      const path=new Path2D();path.moveTo(part.points[0],part.points[1]);
      for(let index=2;index<part.points.length;index+=2)path.lineTo(part.points[index],part.points[index+1]);
      additions.set(part.id,{path,bytes:part.points.byteLength});
    }
    for(const id of job.partIds)if(!parts.has(id)&&!additions.has(id))throw new Error('A requested trail part is not registered');
    for(const [id,part]of additions)parts.set(id,part);retainedBytes=bytes;
    const path=new Path2D();for(const id of job.partIds)path.addPath(parts.get(id)!.path);
    const canvas=new OffscreenCanvas(job.width,job.height),context=canvas.getContext('2d',{alpha:true,willReadFrequently:!!job.softwareRaster});
    if(!context)throw new Error('Trail Canvas painter is unavailable');
    context.setTransform(...job.transform as [number,number,number,number,number,number]);
    context.lineCap='round';context.lineJoin='round';
    context.strokeStyle=job.haloColor;context.lineWidth=job.haloWidth;context.stroke(path);
    context.strokeStyle=job.lineColor;context.lineWidth=job.lineWidth;context.stroke(path);
    bitmap=canvas.transferToImageBitmap();self.postMessage({id:job.id,bitmap},{transfer:[bitmap]});bitmap=undefined;
  }catch(error){bitmap?.close();self.postMessage({id:job?.id,error:error instanceof Error?error.message:'Trail raster could not be prepared'});}
};
