import type {SatelliteSourceId} from './map-satellite';
import type {Map as MapLibreMap} from 'maplibre-gl';
import type {Map as LeafletMap,TileLayer} from 'leaflet';

export type SatelliteImageryState = {
  active: SatelliteSourceId | null;
  target: SatelliteSourceId | null;
  loading: boolean;
};

export const EMPTY_SATELLITE_STATE: SatelliteImageryState = {active:null,target:null,loading:false};

export type SatelliteCandidate = {
  ready: Promise<void>;
  show: () => void;
  /** Must release its listeners/resources and settle ready when cancelled. */
  dispose: () => void;
};

type Entry = {source:SatelliteSourceId;candidate:SatelliteCandidate;disposed:boolean;result:Promise<boolean>};
type Options = {
  prepare: (source:SatelliteSourceId) => SatelliteCandidate;
  onState: (state:SatelliteImageryState) => void;
  onError: (error:unknown,source:SatelliteSourceId) => void;
};

/** Only the latest prepared imagery can replace the visible source. The old
 * source remains owned and visible until its replacement is ready. Neither
 * this controller nor its adapters change the map camera. */
export class SatelliteImagerySession {
  private active: Entry | null = null;
  private pending: Entry | null = null;
  private disposed = false;
  private options: Options;

  constructor(options:Options) {this.options=options;}

  private release(entry:Entry|null) {
    if(entry&&!entry.disposed){entry.disposed=true;entry.candidate.dispose();}
  }
  private publish() {
    this.options.onState({active:this.active?.source??null,target:this.pending?.source??this.active?.source??null,loading:!!this.pending});
  }

  choose(source:SatelliteSourceId):Promise<boolean> {
    if(this.disposed)return Promise.resolve(false);
    if(this.pending?.source===source)return this.pending.result;
    const obsolete=this.pending;this.pending=null;this.release(obsolete);
    if(this.active?.source===source){if(obsolete)this.publish();return Promise.resolve(true);}
    let candidate:SatelliteCandidate;
    try{candidate=this.options.prepare(source);}
    catch(error){this.publish();this.options.onError(error,source);return Promise.resolve(false);}
    const entry:Entry={source,candidate,disposed:false,result:Promise.resolve(false)};
    this.pending=entry;
    entry.result=candidate.ready.then(()=>{
      if(this.disposed||this.pending!==entry){this.release(entry);return false;}
      candidate.show();
      const previous=this.active;this.active=entry;this.pending=null;
      this.release(previous);this.publish();return true;
    }).catch(error=>{
      if(this.disposed||this.pending!==entry){this.release(entry);return false;}
      this.pending=null;this.release(entry);this.publish();this.options.onError(error,source);return false;
    });
    this.publish();return entry.result;
  }

  dispose() {
    if(this.disposed)return;
    this.disposed=true;
    const pending=this.pending,active=this.active;this.pending=null;this.active=null;
    this.release(pending);this.release(active);
  }
}

const LOAD_TIMEOUT_MS=20_000;
const cancelled=()=>new DOMException('Satellite source was replaced.','AbortError');

/** Public raster APIs only. Opacity zero still loads visible raster sources;
 * visibility none does not. Readiness is checked only after a rendered frame
 * has updated the source's visible tile set, never on an unused source. */
export function prepareMapLibreSatellite(map:MapLibreMap,id:string,current:()=>boolean,onShow:()=>void=()=>{}):SatelliteCandidate {
  let disposed=false,settled=false,rendered=false;
  let resolveReady:()=>void,rejectReady:(error:unknown)=>void;
  const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const cleanup=()=>{map.off('render',onRender);map.off('moveend',onMoveEnd);map.off('error',onError);clearTimeout(timeout);};
  const fail=(error:unknown)=>{if(settled)return;settled=true;cleanup();rejectReady(error);};
  const check=()=>{
    if(disposed||settled||!rendered)return;
    if(!current()||!map.getLayer(id)){fail(cancelled());return;}
    // A flight or wheel gesture can momentarily finish the previous zoom's
    // tile set before requesting the destination. Keep the old ground until
    // a rendered, stationary viewport is complete, as the Leaflet adapter does.
    if(!map.isMoving()&&map.isSourceLoaded(id)){settled=true;cleanup();resolveReady();}
  };
  const onRender=()=>{rendered=true;check();};
  const onMoveEnd=()=>{if(!disposed&&!settled)map.triggerRepaint();};
  const onError=(event:{sourceId?:string;error?:unknown})=>{if(event.sourceId===id)fail(event.error??new Error('Satellite tile failed.'));};
  map.on('render',onRender);map.on('moveend',onMoveEnd);map.on('error',onError);
  const timeout=setTimeout(()=>fail(new Error('Satellite imagery timed out.')),LOAD_TIMEOUT_MS);
  try{
    map.setPaintProperty(id,'raster-opacity-transition',{duration:0});
    map.setPaintProperty(id,'raster-opacity',0);
    map.setLayoutProperty(id,'visibility','visible');
    map.triggerRepaint();
  }catch(error){fail(error);}
  return {ready,show:()=>{
    if(disposed||!current()||!map.getLayer(id))throw cancelled();
    onShow();
    map.setPaintProperty(id,'raster-opacity',1);
  },dispose:()=>{
    if(disposed)return;disposed=true;fail(cancelled());cleanup();
    if(current()&&map.getLayer(id)){map.setLayoutProperty(id,'visibility','none');map.setPaintProperty(id,'raster-opacity',0);}
  }};
}

/** The replacement layer is transparent while its visible tiles load. Leaflet
 * emits load after tile errors too, so errors reject before that event. */
export function prepareLeafletSatellite(layer:TileLayer,map:LeafletMap,current:()=>boolean,onShow:()=>void,canCommit:()=>boolean=()=>true):SatelliteCandidate {
  let disposed=false,settled=false;
  let resolveReady:()=>void,rejectReady:(error:unknown)=>void;
  const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const cleanup=()=>{layer.off('load',onLoad);layer.off('tileerror',onError);map.off('moveend',onMoveEnd);clearTimeout(timeout);};
  const fail=(error:unknown)=>{if(settled)return;settled=true;cleanup();rejectReady(error);};
  const onLoad=()=>{
    if(disposed||settled)return;
    if(!current()||!map.hasLayer(layer)){fail(cancelled());return;}
    if(!canCommit()||layer.isLoading())return;
    settled=true;cleanup();resolveReady();
  };
  // GridLayer's moveend handler may run later in this event dispatch. Check
  // after it has updated the grid, and never certify a previous moving view.
  const onMoveEnd=()=>{queueMicrotask(onLoad);};
  const onError=()=>fail(new Error('Satellite tile failed.'));
  layer.on('load',onLoad);layer.on('tileerror',onError);map.on('moveend',onMoveEnd);
  const timeout=setTimeout(()=>fail(new Error('Satellite imagery timed out.')),LOAD_TIMEOUT_MS);
  try{layer.setOpacity(0);layer.addTo(map);}catch(error){fail(error);}
  return {ready,show:()=>{
    if(disposed||!current()||!map.hasLayer(layer))throw cancelled();
    layer.setOpacity(1);onShow();
  },dispose:()=>{if(disposed)return;disposed=true;fail(cancelled());cleanup();layer.remove();}};
}
