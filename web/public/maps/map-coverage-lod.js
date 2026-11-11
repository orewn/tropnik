import {russiaLongitude} from './russia-viewport.js';

export const MAP_COVERAGE_MANIFEST = '/data/map-coverage/manifest.json';
export const MAP_COVERAGE_LIMITS = Object.freeze({manifestBytes:512*1024,baseBytes:8*1024*1024,cellBytes:3*1024*1024,viewBytes:24*1024*1024,cacheBytes:24*1024*1024,concurrent:3,cells:192});
const ROLES = new Set(['area','mask','territory','territory-boundary']);
const DEPTH = {Point:0,MultiPoint:1,LineString:1,MultiLineString:2,Polygon:2,MultiPolygon:3};
const fc = features => ({type:'FeatureCollection',features});
const failure = code => new Error(`coverage-${code}`);

/** Lossless transport decoding. Sharing position values never merges rings,
 * islands or roles; their original coordinate nesting is retained exactly. */
export function decodeCoverage(document) {
  if (document?.type !== 'TropnikCoverage' || document.encoding !== 'indexed-delta-1e7-v1' || !Array.isArray(document.positions) || document.positions.length % 2 || !Array.isArray(document.features)) throw failure('encoding');
  const positions = [];let x=0,y=0;
  for (let index=0;index<document.positions.length;index+=2) {
    const dx=document.positions[index],dy=document.positions[index+1];
    if (!Number.isSafeInteger(dx)||!Number.isSafeInteger(dy)) throw failure('coordinate');
    x+=dx;y+=dy;
    if (!Number.isSafeInteger(x)||!Number.isSafeInteger(y)||x<0||x>3600000000||Math.abs(y)>850511288) throw failure('coordinate');
    positions.push([x/1e7,y/1e7]);
  }
  const unpack = (value,depth) => {
    if (depth===0) {
      if (!Number.isSafeInteger(value)||value<0||value>=positions.length) throw failure('index');
      return positions[value];
    }
    if (!Array.isArray(value)||!value.length) throw failure('nesting');
    return value.map(child=>unpack(child,depth-1));
  };
  const features=document.features.map(item=>{
    if (item?.type!=='Feature'||!ROLES.has(item.properties?.role)||typeof item.properties.cell!=='string'||!(item.geometry?.type in DEPTH)) throw failure('feature');
    return {...item,geometry:{type:item.geometry.type,coordinates:unpack(item.geometry.coordinates,DEPTH[item.geometry.type])}};
  });
  return {...document,type:'FeatureCollection',positions:undefined,features};
}

export function coverageLevel(zoom) {
  return zoom<=4?'overview':zoom<=8?'regional':zoom<=12?'local':'source';
}

export function coverageCells(manifest,bounds,zoom) {
  const level=coverageLevel(zoom);
  if (level==='overview') return [];
  let [w,s,e,n]=bounds;
  if (![w,s,e,n,zoom].every(Number.isFinite)||s>n) throw failure('viewport');
  if(e<w)e+=360*Math.ceil((w-e)/360);
  if(!Number.isFinite(e-w))throw failure('viewport');
  const width=Math.min(360,e-w),center=russiaLongitude(w+width/2);
  // One small geographic buffer anticipates a pan, without fetching unseen
  // country-wide source detail. World copies map to the same cell identity.
  w=center-width*.65;e=center+width*.65;
  const height=n-s;s=Math.max(-85.0511288,s-height*.15);n=Math.min(85.0511288,n+height*.15);
  return manifest.cells.filter(cell=>cell.levels[level]&&[-360,0,360].some(shift=>cell.bounds[2]+shift>=w&&cell.bounds[0]+shift<=e&&cell.bounds[3]>=s&&cell.bounds[1]<=n));
}

function validateManifest(value) {
  if (value?.schemaVersion!==1||value.encoding!=='indexed-delta-1e7-v1'||!/^[a-f0-9]{16}$/.test(value.version)||!Array.isArray(value.cells)||value.cells.length>1024) throw failure('manifest');
  const descriptor=(item,limit)=>{
    if (!item||typeof item.url!=='string'||!/^\/(?:[\w-]+\/)*data\/map-coverage\//.test(item.url)||item.url.includes('..')||!item.url.endsWith('.coverage')||!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>limit||!/^[a-f0-9]{64}$/.test(item.sha256)) throw failure('descriptor');
  };
  descriptor(value.base,MAP_COVERAGE_LIMITS.baseBytes);
  const ids=new Set();
  for (const cell of value.cells) {
    if (typeof cell.id!=='string'||ids.has(cell.id)||!Array.isArray(cell.bounds)||cell.bounds.length!==4||!cell.bounds.every(Number.isFinite)||cell.bounds[0]<0||cell.bounds[2]>360||cell.bounds[0]>=cell.bounds[2]||cell.bounds[1]>=cell.bounds[3]||!cell.levels) throw failure('cell');
    ids.add(cell.id);
    for (const [level,item] of Object.entries(cell.levels)) {if(!['regional','local','source'].includes(level))throw failure('level');descriptor(item,MAP_COVERAGE_LIMITS.cellBytes);}
  }
  return value;
}

async function boundedBytes(fetcher,url,limit,signal) {
  const response=await fetcher(url,{signal,credentials:'same-origin'});
  if (!response.ok) throw failure('http');
  const length=Number(response.headers?.get?.('content-length'));
  if (length>limit) {await response.body?.cancel();throw failure('size');}
  if (!response.body?.getReader) {
    const value=new Uint8Array(await response.arrayBuffer());
    if(value.byteLength>limit)throw failure('size');
    return value;
  }
  const reader=response.body.getReader(),parts=[];let size=0;
  try {
    for (;;) {
      const {value,done}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>limit){await reader.cancel();throw failure('size');}parts.push(value);
    }
  } finally {reader.releaseLock();}
  const result=new Uint8Array(size);let offset=0;
  for(const part of parts){result.set(part,offset);offset+=part.byteLength;}
  return result;
}

async function loadBundle(fetcher,descriptor,version,lod,cell,signal) {
  const bytes=await boundedBytes(fetcher,descriptor.url,descriptor.bytes,signal);
  if(signal?.aborted)throw new DOMException('Aborted','AbortError');
  if(bytes.byteLength!==descriptor.bytes)throw failure('size');
  const hash=[...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
  if(hash!==descriptor.sha256)throw failure('integrity');
  const document=JSON.parse(new TextDecoder().decode(bytes));
  if(document.coverageVersion!==version||document.lod!==lod||(cell&&document.cell!==cell))throw failure('identity');
  const result=decodeCoverage(document);
  if(cell&&result.features.some(feature=>feature.properties.cell!==cell))throw failure('identity');
  return result;
}

function canonicalFeature(feature,manifestCells) {
  const west=manifestCells.get(feature.properties.cell)?.bounds[0];
  if (!(west>=180)) return feature;
  const shift=coordinates=>typeof coordinates[0]==='number'?[coordinates[0]-360,coordinates[1]]:coordinates.map(shift);
  return {...feature,geometry:{...feature.geometry,coordinates:shift(feature.geometry.coordinates)}};
}

/** One map owns one session. Each generation swaps all four roles together.
 * Earlier requests can neither overwrite a later viewport nor move its camera. */
export function createMapCoverage(manifest,base,options={}) {
  validateManifest(manifest);
  const fetcher=options.fetch??globalThis.fetch.bind(globalThis),cellsById=new Map(manifest.cells.map(cell=>[cell.id,cell]));
  const baseCells=new Map(manifest.cells.map(cell=>[cell.id,[]]));
  for(const feature of base.features){const target=baseCells.get(feature.properties.cell);if(!target)throw failure('identity');target.push(feature);}
  const listeners=new Set(),cache=new Map();let bytesCached=0,generation=0,controller,disposed=false,requestedKey='overview:',appliedKey='overview:';
  const session={manifest,version:manifest.version,area:fc([]),mask:fc([]),territories:fc([]),boundaries:fc([]),cellFeatures:new Map(),
    status:{version:manifest.version,lod:'overview',cells:[],pending:0,error:'',ready:true,revision:0},
    subscribe(callback){listeners.add(callback);return()=>listeners.delete(callback);},
    updateView,dispose(){disposed=true;generation++;controller?.abort();listeners.clear();cache.clear();},
  };
  const notify=()=>{for(const callback of listeners)callback(session);};
  const compose=(bundles)=>{
    const features=[];session.cellFeatures=new Map();
    for(const [id,initial] of baseCells){const items=bundles.get(id)?.features??initial;session.cellFeatures.set(id,items);features.push(...items);}
    session.area=fc(features.filter(item=>item.properties.role==='area'));
    const canonical=items=>options.canonicalMask?items.map(item=>canonicalFeature(item,cellsById)):items;
    session.mask=fc(canonical(features.filter(item=>item.properties.role==='mask')));
    session.territories=fc(features.filter(item=>item.properties.role==='territory'));
    session.boundaries=fc(features.filter(item=>item.properties.role==='territory-boundary'));
  };
  compose(new Map());
  async function updateView(bounds,zoom) {
    if(disposed)return;
    const level=coverageLevel(zoom),cells=coverageCells(manifest,bounds,zoom),ids=cells.map(cell=>cell.id).sort(),key=`${level}:${ids.join(',')}`;
    if(key===requestedKey&&(session.status.ready||session.status.pending>0))return;
    requestedKey=key;const current=++generation;controller?.abort();controller=new AbortController();const signal=controller.signal;
    const active=()=>!disposed&&current===generation&&!signal.aborted;
    session.status={...session.status,lod:level,cells:ids,pending:cells.length,error:'',ready:false};notify();
    try {
      if(cells.length>MAP_COVERAGE_LIMITS.cells||cells.reduce((sum,cell)=>sum+cell.levels[level].bytes,0)>MAP_COVERAGE_LIMITS.viewBytes)throw failure('budget');
      const bundles=new Map();let next=0;
      const worker=async()=>{
        while(next<cells.length&&active()) {
          const cell=cells[next++],descriptor=cell.levels[level],cacheKey=`${level}:${cell.id}`;
          let bundle=cache.get(cacheKey)?.bundle;
          if(bundle){const entry=cache.get(cacheKey);cache.delete(cacheKey);cache.set(cacheKey,entry);}
          else {
            bundle=await loadBundle(fetcher,descriptor,manifest.version,level,cell.id,signal);
            if(!active())return;
            cache.set(cacheKey,{bundle,bytes:descriptor.bytes});bytesCached+=descriptor.bytes;
            while(bytesCached>MAP_COVERAGE_LIMITS.cacheBytes&&cache.size){const oldest=cache.keys().next().value;bytesCached-=cache.get(oldest).bytes;cache.delete(oldest);}
          }
          if(!active())return;
          bundles.set(cell.id,bundle);session.status={...session.status,pending:session.status.pending-1};notify();
        }
      };
      await Promise.all(Array.from({length:Math.min(MAP_COVERAGE_LIMITS.concurrent,cells.length)},worker));
      if(!active())return;
      if(appliedKey!==key){compose(bundles);session.status={...session.status,revision:session.status.revision+1};appliedKey=key;}
      session.status={...session.status,pending:0,ready:true,error:''};notify();
    } catch(error) {
      if(!active())return;
      controller.abort();session.status={...session.status,pending:0,ready:false,error:error instanceof Error&&error.message.startsWith('coverage-')?error.message:'coverage-unavailable'};notify();
    }
  }
  return session;
}

const bootstraps=new Map();
export async function loadMapCoverage(options={}) {
  const url=options.manifestURL??MAP_COVERAGE_MANIFEST,fetcher=options.fetch??globalThis.fetch.bind(globalThis);
  let bootstrap=!options.fetch&&bootstraps.get(url);
  if(!bootstrap) {
    bootstrap=(async()=>{
      const bytes=await boundedBytes(fetcher,url,MAP_COVERAGE_LIMITS.manifestBytes);
      const manifest=validateManifest(JSON.parse(new TextDecoder().decode(bytes)));
      const base=await loadBundle(fetcher,manifest.base,manifest.version,'overview');return{manifest,base};
    })();
    if(!options.fetch){bootstraps.set(url,bootstrap);void bootstrap.catch(()=>bootstraps.delete(url));}
  }
  const {manifest,base}=await bootstrap;return createMapCoverage(manifest,base,options);
}
