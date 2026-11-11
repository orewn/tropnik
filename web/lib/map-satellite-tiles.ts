import type * as Leaflet from 'leaflet';

type TileCommit = {ready: boolean; started: number; complete: (error?: Error) => void};
type BatchOptions<Token> = {
  current: (token: Token) => boolean;
  /** Parents/children at another native zoom may still cover the screen. */
  intersectsView?: (token: Token) => boolean;
  beforeFlush?: () => void;
  settled: () => boolean;
  timeoutMs?: number;
  maxPending?: number | (() => number);
  now?: () => number;
};

/** Hold SDK completion callbacks, not pixels. Leaflet keeps its previously
 * committed parent tiles until the whole current viewport can be published.
 * Network errors are delivered immediately; admission errors wait until the
 * SDK has finished constructing its tiles. Cancellation never becomes success. */
export class SatelliteTileBatch<Token> {
  private readonly pending = new Map<Token, TileCommit>();
  // Admission overflow exists only until the current SDK creation task ends.
  // A ready offscreen tile may free the required slot in that same flush.
  private readonly admissions = new Map<Token, TileCommit>();
  private readonly options: BatchOptions<Token>;
  private queued = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: BatchOptions<Token>) {this.options = options;}
  add(token: Token, complete: TileCommit['complete']): void {
    if (this.disposed) return;
    const target = this.pending.size < this.capacity() ? this.pending : this.admissions;
    target.set(token, {ready:false, started:this.now(), complete});
    this.schedule();
  }
  loaded(token: Token, error?: Error): void {
    const item = this.pending.get(token) ?? this.admissions.get(token);
    if (this.disposed || !item) return;
    if (error) {this.pending.delete(token); this.admissions.delete(token); item.complete(error);}
    else item.ready = true;
    this.schedule();
  }
  remove(token: Token): void {this.pending.delete(token); this.admissions.delete(token); this.schedule();}
  schedule(): void {
    if (this.disposed || this.queued) return;
    this.queued = true;
    queueMicrotask(() => {this.queued=false; if (!this.disposed) this.flush();});
  }
  dispose(): void {this.disposed=true; clearTimeout(this.timer); this.pending.clear(); this.admissions.clear();}
  private now(): number {return this.options.now?.() ?? Date.now();}
  private capacity(): number {
    const limit = typeof this.options.maxPending === 'function' ? this.options.maxPending() : this.options.maxPending ?? 128;
    return Number.isFinite(limit) ? Math.max(1, Math.min(1024, Math.floor(limit))) : 128;
  }
  private flush(): void {
    clearTimeout(this.timer); this.timer=undefined;
    this.options.beforeFlush?.();
    // GridLayer prunes obsolete tiles from completion callbacks. Holding even
    // decoded OFFSCREEN images during a long drag otherwise prevents pruning
    // and fills the bounded queue. Their completion cannot reveal part of the
    // current viewport, so it is safe while the camera is still moving.
    for (const [token,item] of [...this.pending]) {
      if (this.disposed) return;
      if (!item.ready || (this.options.intersectsView ?? this.options.current)(token) || this.pending.get(token)!==item) continue;
      this.pending.delete(token); item.complete();
    }
    for (const [token,item] of [...this.admissions]) {
      if (this.disposed) return;
      if (this.admissions.get(token)!==item) continue;
      this.admissions.delete(token);
      if (this.pending.size < this.capacity()) this.pending.set(token,item);
      else item.complete(new Error('Satellite tile queue exceeded its limit.'));
    }
    if (this.disposed) return;
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

type SatelliteTileCoords = {x:number;y:number;z:number};
type SatelliteTileView = {left:number;top:number;right:number;bottom:number;zoom:number};

/** Compare wrapped source coordinates with continuous public pixel bounds.
 * The z of createTile already includes maxNativeZoom/overzoom constraints. */
export function satelliteTileInView(coords: SatelliteTileCoords, view: SatelliteTileView, tileSize=256): boolean {
  if (coords.z!==view.zoom) return false;
  const n=2**coords.z, left=Math.floor(view.left/tileSize), right=Math.ceil(view.right/tileSize)-1;
  const top=Math.floor(view.top/tileSize), bottom=Math.ceil(view.bottom/tileSize)-1;
  const distance=((coords.x-left)%n+n)%n;
  return coords.y>=top && coords.y<=bottom && (right-left>=n-1 || distance<=right-left);
}

/** Scale the public pixel viewport into the tile's native zoom. A parent may
 * be visible after zoom-in even though it does not belong to the new grid.
 * Releasing that parent early would paint its pixels before the grid is ready. */
export function satelliteTileIntersectsView(coords: SatelliteTileCoords, view: SatelliteTileView, tileSize=256): boolean {
  const scale=2**(coords.z-view.zoom);
  return satelliteTileInView(coords,{left:view.left*scale,top:view.top*scale,right:view.right*scale,bottom:view.bottom*scale,zoom:coords.z},tileSize);
}

/** Use TileLayer's public createTile hook and documented lifecycle events.
 * A decoded image becomes visible only with its complete current viewport. */
export function createGroupedSatelliteLayer(L: typeof Leaflet, map: Leaflet.Map, url: string, options: Leaflet.TileLayerOptions, settled: () => boolean) {
  const coordinates=new Map<HTMLElement,Leaflet.Coords>();
  const tileSize=typeof options.tileSize==='number'?options.tileSize:options.tileSize?.x??256;
  let snapshot:SatelliteTileView|undefined;
  const invalidateView=()=>{snapshot=undefined;};
  const view=()=>{
    if(snapshot)return snapshot;
    const zoom=Math.max(options.minNativeZoom??0,Math.min(options.maxNativeZoom??18,Math.round(map.getZoom())));
    const bounds=map.getBounds(),min=map.project([bounds.getNorth(),bounds.getWest()],zoom),max=map.project([bounds.getSouth(),bounds.getEast()],zoom);
    return snapshot={left:min.x,top:min.y,right:max.x,bottom:max.y,zoom};
  };
  const batch=new SatelliteTileBatch<HTMLElement>({settled,beforeFlush:invalidateView,maxPending:()=>{
    const bounds=view(),buffer=options.keepBuffer??2;
    const columns=Math.max(1,Math.ceil(bounds.right/tileSize)-Math.floor(bounds.left/tileSize));
    const rows=Math.max(1,Math.ceil(bounds.bottom/tileSize)-Math.floor(bounds.top/tileSize));
    // Keep two native viewport grids plus the SDK's retention buffer. A large
    // desktop viewport must not trip the phone-sized minimum by itself.
    return Math.max(128,Math.min(1024,2*(columns+2*buffer)*(rows+2*buffer)));
  },current:tile=>{
    const coords=coordinates.get(tile); if (!coords) return false;
    return satelliteTileInView(coords,view(),tileSize);
  },intersectsView:tile=>{
    const coords=coordinates.get(tile); if (!coords) return false;
    return satelliteTileIntersectsView(coords,view(),tileSize);
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
  // All tokens and admission checks in a pass share one geometry snapshot.
  // Camera events also invalidate between createTile calls; beforeFlush covers
  // any camera update that happens between admission and its microtask.
  const cameraEvents='move moveend zoom viewreset resize';
  const viewChanged=()=>{invalidateView();batch.schedule();};
  let disposed=false;
  const dispose=()=>{
    if(disposed)return;disposed=true;batch.dispose();coordinates.clear();
    map.off(cameraEvents,viewChanged);layer.off('tileunload',unloaded);layer.off('tileabort',unloaded);layer.off('remove',dispose);
  };
  // A native zoom abort removes an unfinished image without tileunload. Drop
  // that image too, so repeated interrupted zooms cannot retain dead batches
  // or exhaust the queue while the current view is still loading.
  layer.on('tileunload',unloaded);layer.on('tileabort',unloaded);layer.on('remove',dispose);map.on(cameraEvents,viewChanged);
  return {layer,dispose};
}
