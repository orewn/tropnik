import type * as Leaflet from 'leaflet';

type TileCommit = {ready: boolean; started: number; complete: (error?: Error) => void};
type BatchOptions<Token> = {
  current: (token: Token) => boolean;
  settled: () => boolean;
  timeoutMs?: number;
  maxPending?: number;
  now?: () => number;
};

/** Hold SDK completion callbacks, not pixels. Leaflet keeps its previously
 * committed parent tiles until the whole current viewport can be published.
 * Errors are delivered immediately; cancellation never becomes success. */
export class SatelliteTileBatch<Token> {
  private readonly pending = new Map<Token, TileCommit>();
  private readonly options: BatchOptions<Token>;
  private queued = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: BatchOptions<Token>) {this.options = options;}
  add(token: Token, complete: TileCommit['complete']): void {
    if (this.disposed) return;
    if (this.pending.size >= (this.options.maxPending ?? 128)) {complete(new Error('Satellite tile queue exceeded its limit.')); return;}
    this.pending.set(token, {ready:false, started:this.now(), complete});
    this.schedule();
  }
  loaded(token: Token, error?: Error): void {
    const item = this.pending.get(token);
    if (this.disposed || !item) return;
    if (error) {this.pending.delete(token); item.complete(error);}
    else item.ready = true;
    this.schedule();
  }
  remove(token: Token): void {this.pending.delete(token); this.schedule();}
  schedule(): void {
    if (this.disposed || this.queued) return;
    this.queued = true;
    queueMicrotask(() => {this.queued=false; if (!this.disposed) this.flush();});
  }
  dispose(): void {this.disposed=true; clearTimeout(this.timer); this.pending.clear();}
  private now(): number {return this.options.now?.() ?? Date.now();}
  private flush(): void {
    clearTimeout(this.timer); this.timer=undefined;
    const current = [...this.pending].filter(([token]) => this.options.current(token));
    const timeout = this.options.timeoutMs ?? 15_000;
    for (const [token, item] of current) {
      if (!item.ready && this.now()-item.started >= timeout) {
        this.pending.delete(token); item.complete(new Error('Satellite tiles timed out.'));
        if (this.disposed) return;
      }
    }
    const waiting = [...this.pending].filter(([token,item]) => !item.ready && this.options.current(token));
    if (waiting.length) {
      this.timer=setTimeout(() => this.schedule(), Math.max(1,Math.min(...waiting.map(([,item]) => timeout-(this.now()-item.started)))));
      return;
    }
    if (!this.options.settled()) return;
    // All completions run in one task, so a browser cannot paint a partially
    // committed grid between callbacks. The SDK still owns pruning/caching.
    for (const [token,item] of [...this.pending]) {
      if (this.disposed) return;
      if (!item.ready || this.pending.get(token)!==item) continue;
      this.pending.delete(token); item.complete();
    }
  }
}

/** Compare wrapped source coordinates with continuous public pixel bounds.
 * The z of createTile already includes maxNativeZoom/overzoom constraints. */
export function satelliteTileInView(coords: {x:number;y:number;z:number}, view: {left:number;top:number;right:number;bottom:number;zoom:number}, tileSize=256): boolean {
  if (coords.z!==view.zoom) return false;
  const n=2**coords.z, left=Math.floor(view.left/tileSize), right=Math.floor((view.right-1)/tileSize);
  const top=Math.floor(view.top/tileSize), bottom=Math.floor((view.bottom-1)/tileSize);
  const distance=((coords.x-left)%n+n)%n;
  return coords.y>=top && coords.y<=bottom && (right-left>=n-1 || distance<=right-left);
}

/** Use TileLayer's public createTile hook and documented lifecycle events.
 * A decoded image becomes visible only with its complete current viewport. */
export function createGroupedSatelliteLayer(L: typeof Leaflet, map: Leaflet.Map, url: string, options: Leaflet.TileLayerOptions, settled: () => boolean) {
  const coordinates=new Map<HTMLElement,Leaflet.Coords>();
  const batch=new SatelliteTileBatch<HTMLElement>({settled,current:tile=>{
    const coords=coordinates.get(tile); if (!coords) return false;
    const zoom=Math.max(options.minNativeZoom??0,Math.min(options.maxNativeZoom??18,Math.round(map.getZoom())));
    const bounds=map.getBounds(),min=map.project([bounds.getNorth(),bounds.getWest()],zoom),max=map.project([bounds.getSouth(),bounds.getEast()],zoom);
    return satelliteTileInView(coords,{left:min.x,top:min.y,right:max.x,bottom:max.y,zoom},options.tileSize as number||256);
  }});
  const Grouped=L.TileLayer.extend({
    createTile(this: Leaflet.TileLayer, coords: Leaflet.Coords, done: Leaflet.DoneCallback) {
      const image=L.TileLayer.prototype.createTile.call(this,coords,(error,element)=>{
        if (!element || !coordinates.has(element)) return;
        if (error) {batch.loaded(element,error); return;}
        const decoded=element as HTMLImageElement;
        const ready=typeof decoded.decode==='function'?decoded.decode():Promise.resolve();
        void ready.then(()=>batch.loaded(element),()=>batch.loaded(element,new Error('Satellite image could not be decoded.')));
      });
      coordinates.set(image,coords);
      batch.add(image,error=>done(error,image));
      return image;
    },
  }) as {new(url:string,options:Leaflet.TileLayerOptions):Leaflet.TileLayer};
  const layer=new Grouped(url,options);
  const unloaded=(event:Leaflet.TileEvent)=>{coordinates.delete(event.tile);batch.remove(event.tile);};
  const viewChanged=()=>batch.schedule();
  let disposed=false;
  const dispose=()=>{
    if(disposed)return;disposed=true;batch.dispose();coordinates.clear();
    map.off('moveend',viewChanged);map.off('resize',viewChanged);layer.off('tileunload',unloaded);layer.off('tileabort',unloaded);layer.off('remove',dispose);
  };
  // A native zoom abort removes an unfinished image without tileunload. Drop
  // that image too, so repeated interrupted zooms cannot retain dead batches
  // or exhaust the queue while the current view is still loading.
  layer.on('tileunload',unloaded);layer.on('tileabort',unloaded);layer.on('remove',dispose);map.on('moveend',viewChanged);map.on('resize',viewChanged);
  return {layer,dispose};
}
