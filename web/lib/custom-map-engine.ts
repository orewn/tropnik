import type * as GeoJSON from 'geojson';
import {cameraBounds,CustomMapPointerSession,fitBounds,keyboardCameraAction,mercatorProject,mercatorUnproject,project,unproject,wheelZoomDelta,zoomAt,type CustomMapCamera,type GeographicBounds,type MapInsets,type MapPoint,type MapViewport} from './custom-map-camera';
import {CustomMapTiles,customTileKey,type CustomMapTile,type CustomTileKind,type CustomTileRequest} from './custom-map-tiles';
import {loadRussiaGeometry} from './russia-map';
import {inRussiaCoverage,MAP_OUTSIDE_COLOR} from '../public/maps/russia-viewport.js';
import {constrainFramedCamera} from './map-framing';
import {satelliteSourceForBounds,type SatelliteSourceId} from './map-satellite';
import {createRouteEdgeElement,routeLineEdges,routeStrokeWidth,syncRouteEdgeAnnotations,type RouteEdgeAnnotation} from './map-route-presentation';
import {publishMapCamera} from './map-interaction';
import {createDirectionMarker} from './map-direction-marker';
import {constrainDirectionLabels,groupMapDirections,updateDirectionButtons,type MapDirectionGroup} from './map-direction-layout';
import type {MapCoverage} from '../public/maps/map-coverage-lod.js';
import type {MapTileLabel} from './custom-map-painter';
import {drawMapSymbol} from './custom-map-symbols';
import {drawMapLabel,mapLabelBudget,mapLabelLayout,mapLabelPriority,mapLabelRepeatDistance,mapLabelRepeatKey,mapLabelStyle} from './custom-map-labels';
import {mapCanvasPolicy,type MapCanvasPolicy} from './map-canvas-policy';
import {copyMapLabelDiagnostic,MAP_LABEL_INSPECTION_EVENT,MAP_LABEL_SAMPLE_LIMIT,MAX_RECORDED_MAP_LABELS,selectRecordedMapLabels} from './custom-map-label-inspection';
import {mapTileIntersectsCoverage} from './custom-map-coverage';

export type CustomMapMode='detail'|'overview'|'satellite';
export type CustomMapState={ready:boolean;loading:boolean;mode:CustomMapMode;committedMode:CustomMapMode;imagerySource?:SatelliteSourceId;imageryTarget?:SatelliteSourceId;imageryLoading:boolean;reliefReady:boolean;localDetail:boolean;error:string;residentTiles:number;pendingTiles:number};
export type CustomMapMarker={id:string;coordinate:[number,number];label:string;kind:'direction'|'trail'|'position'|'plan';count?:number;active?:boolean};
export type CustomMapLabel={id:string;coordinate:[number,number];label:string;kind?:MapTileLabel['kind'];rank?:number;color?:string};
export type CustomMapLabelDiagnostic={id:string;label:string;coordinate:[number,number];visible:boolean;reason:string;x?:number;y?:number;width?:number;rect?:{left:number;top:number;right:number;bottom:number}};
export type CustomMapOptions={camera:CustomMapCamera;onReady?:(engine:CustomMapEngine)=>void;onFrame?:(camera:CustomMapCamera)=>void;onSettled?:(camera:CustomMapCamera)=>void;onGesture?:()=>void;onClick?:(point:MapPoint,coordinate:[number,number])=>void;onMarker?:(id:string)=>void;onState?:(state:CustomMapState)=>void;maxZoom?:number};
type TileBatch={tiles:CustomMapTile[];kind:CustomTileKind;generation:number;missing?:CustomTileRequest[]};
type FeatureGeometry=GeoJSON.GeoJSON|undefined;
type PathCollection={path:Path2D;bounds:[number,number,number,number]};
const COUNTRY_BOUNDS=[19.6389282,41.1858711,191.0026658,81.858721] as const;
const MAX_VISIBLE_TILES=64;

function geometryPath(geometry:FeatureGeometry):PathCollection{
  const path=new Path2D(),bounds:[number,number,number,number]=[Infinity,Infinity,-Infinity,-Infinity];
  const line=(coordinates:GeoJSON.Position[],closed=false)=>{
    if(!coordinates.length)return;let reference=105;
    for(let i=0;i<coordinates.length;i++){
      const coordinate=coordinates[i];if(!Number.isFinite(coordinate[0])||!Number.isFinite(coordinate[1]))continue;
      const longitude=coordinate[0]+360*Math.round((reference-coordinate[0])/360);reference=longitude;
      const p=mercatorProject([longitude,coordinate[1]]);if(i)path.lineTo(p.x,p.y);else path.moveTo(p.x,p.y);
      bounds[0]=Math.min(bounds[0],longitude);bounds[1]=Math.min(bounds[1],coordinate[1]);bounds[2]=Math.max(bounds[2],longitude);bounds[3]=Math.max(bounds[3],coordinate[1]);
    }
    if(closed)path.closePath();
  };
  const visit=(g:GeoJSON.GeoJSON|null|undefined):void=>{
    if(!g)return;
    if(g.type==='FeatureCollection'){g.features.forEach(visit);return;}
    if(g.type==='Feature'){visit(g.geometry);return;}
    if(g.type==='GeometryCollection'){g.geometries.forEach(visit);return;}
    if(g.type==='LineString')line(g.coordinates);
    else if(g.type==='MultiLineString')g.coordinates.forEach(c=>line(c));
    else if(g.type==='Polygon')g.coordinates.forEach(c=>line(c,true));
    else if(g.type==='MultiPolygon')g.coordinates.forEach(p=>p.forEach(c=>line(c,true)));
  };visit(geometry);return{path,bounds};
}
function tileRequests(camera:CustomMapCamera,size:MapViewport,z:number,kind:CustomTileKind,paths=true,transparent=false,boundaries=true):CustomTileRequest[]{
  let level=Math.max(0,Math.floor(z));
  const bounds=cameraBounds(camera,size),sw=mercatorProject([bounds[0],bounds[1]]),ne=mercatorProject([bounds[2],bounds[3]]);
  const middle=mercatorProject(camera.center),angle=(camera.bearingDegrees??0)*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle),scale=256*2**camera.zoom;
  const halfW=size.width/2,halfH=size.height/2;
  let result:CustomTileRequest[]=[];
  // The source tile square and rotated viewport must overlap on both pairs of
  // separating axes. An AABB alone wastes the budget on invisible corner tiles.
  const visible=(x:number,y:number,n:number)=>{
    const dx=((x+.5)/n-middle.x)*scale,dy=((y+.5)/n-middle.y)*scale,half=scale/(2*n);
    const radius=half*(Math.abs(cos)+Math.abs(sin));
    return Math.abs(dx*cos+dy*sin)<=halfW+radius&&Math.abs(-dx*sin+dy*cos)<=halfH+radius&&
      Math.abs(dx)<=half+halfW*Math.abs(cos)+halfH*Math.abs(sin)&&Math.abs(dy)<=half+halfW*Math.abs(sin)+halfH*Math.abs(cos);
  };
  for(;level>=0;level--){
    const n=2**level,x0=Math.floor(sw.x*n),x1=Math.floor(ne.x*n),y0=Math.max(0,Math.floor(ne.y*n)),y1=Math.min(n-1,Math.floor(sw.y*n));
    result=[];
    if((x1-x0+1)*(y1-y0+1)>MAX_VISIBLE_TILES*4&&level>0)continue;
    outer:for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)if(visible(x,y,n)){
      result.push({kind,z:level,x,y,paths,transparent,...(kind==='vector'?{boundaries}:{}),...(kind==='vector'||kind==='relief'?{paintZoom:Math.max(level,Math.min(18,Math.floor(z)))}:{})});
      if(result.length>MAX_VISIBLE_TILES&&level>0)break outer;
    }
    if(result.length<=MAX_VISIBLE_TILES||level===0)break;
  }
  const n=2**level;
  return result.sort((a,b)=>Math.hypot(a.x+.5-middle.x*n,a.y+.5-middle.y*n)-Math.hypot(b.x+.5-middle.x*n,b.y+.5-middle.y*n));
}

/** Own camera, input, raster/vector composition and geographic hit surface.
 * No map SDK, style interpreter, vendor controls or idle render loop. */
export class CustomMapEngine {
  readonly canvas:HTMLCanvasElement;
  readonly element:HTMLElement;
  private context:CanvasRenderingContext2D;
  private labelCanvas:HTMLCanvasElement;
  private labelContext:CanvasRenderingContext2D;
  private options:CustomMapOptions;
  private tiles:CustomMapTiles;
  private rasterPolicy:MapCanvasPolicy;
  private camera:CustomMapCamera;
  private floor:CustomMapCamera;
  private framed:CustomMapCamera|null=null;
  private pitch=0;
  private padding:Partial<MapInsets>={};
  private size:MapViewport={width:1,height:1};
  private pixelRatio=1;
  private coverage?:MapCoverage;
  private coverageTask?:Promise<void>;
  private retryAfterCurrent=false;
  private coverageRevision=-1;
  private coveragePaths=new WeakMap<GeoJSON.Geometry,Path2D>();
  private area?:Path2D;
  private mask?:Path2D;
  private boundaries?:Path2D;
  private selectedArea?:Path2D;
  private selectedBoundary?:Path2D;
  private route?:PathCollection;
  private routeId?:string;
  private markerLayer:HTMLDivElement;
  private markers=new Map<string,{marker:CustomMapMarker;button:HTMLButtonElement}>();
  private markerGroups=new Map<string,MapDirectionGroup<{id:string;name:string;center:[number,number]}>>();
  private routeEdges:RouteEdgeAnnotation[]=[];
  private selectedShapes:string[]=[];
  private mode:CustomMapMode='detail';
  private paths=true;
  private boundaryVisible=true;
  private reliefVisible=true;
  private overview?:TileBatch;
  private detail?:TileBatch;
  private relief?:TileBatch;
  private imagery?:TileBatch;
  private imageryOverlay?:TileBatch;
  private generation=0;
  private currentKeys='';
  private disposed=false;
  private active=true;
  private eco=false;
  private additionalLabels:CustomMapLabel[]=[];
  private labelDiagnostics:CustomMapLabelDiagnostic[]=[];
  private labelDiagnosticTotal=0;
  private drawRevision=0;
  private labelRevision=0;
  private frame=0;
  private paintRequested=false;
  private labelsRequested=false;
  private animation=0;
  private zoomTarget:number|null=null;
  private settleTimer?:ReturnType<typeof setTimeout>;
  private resize:ResizeObserver;
  private unbindCoverage?:()=>void;
  private pointer=new CustomMapPointerSession({minZoom:-2,maxZoom:18,rotate:true});
  private pointerRect?:DOMRect;
  private pointerStart?:{x:number;y:number;time:number;id:number};
  private pointerMoved=false;
  private listeners:Array<[EventTarget,string,EventListener,AddEventListenerOptions|boolean|undefined]>=[];
  private obstacles:Array<{left:number;top:number;right:number;bottom:number}>=[];
  private state:CustomMapState={ready:false,loading:false,mode:'detail',committedMode:'overview',imageryLoading:false,reliefReady:false,localDetail:false,error:'',residentTiles:0,pendingTiles:0};
  constructor(element:HTMLElement,options:CustomMapOptions){
    this.element=element;this.options=options;this.camera={...options.camera};this.floor={...options.camera};
    this.rasterPolicy=mapCanvasPolicy(element.ownerDocument??document);this.tiles=new CustomMapTiles(this.rasterPolicy.softwareRaster);
    this.canvas=document.createElement('canvas');this.canvas.className='tropnik-map-canvas';this.canvas.tabIndex=0;
    this.canvas.setAttribute('aria-label','Карта России: перетаскивание и стрелки перемещают карту, колёсико и плюс или минус меняют масштаб.');
    this.canvas.setAttribute('role','img');element.appendChild(this.canvas);
    this.labelCanvas=document.createElement('canvas');this.labelCanvas.className='tropnik-map-labels';this.labelCanvas.hidden=true;
    this.labelCanvas.setAttribute('aria-hidden','true');element.appendChild(this.labelCanvas);
    this.markerLayer=document.createElement('div');this.markerLayer.className='tropnik-marker-layer';element.appendChild(this.markerLayer);
    // Map pixels and the DOM controls share the normal compositor. A forced
    // low-latency surface uses a different presentation path on some devices.
    const context=this.canvas.getContext('2d',{alpha:false,willReadFrequently:this.rasterPolicy.softwareRaster});if(!context)throw new Error('Canvas map is unavailable');this.context=context;
    const labelContext=this.labelCanvas.getContext('2d',{alpha:true,willReadFrequently:this.rasterPolicy.softwareRaster});if(!labelContext)throw new Error('Canvas map labels are unavailable');this.labelContext=labelContext;
    this.resize=new ResizeObserver(()=>this.resizeCanvas());this.resize.observe(element);this.resizeCanvas();this.bindInput();
    this.loadCoverage();
  }
  private loadCoverage(){
    if(this.disposed||this.coverage||this.coverageTask)return;
    this.updateState({loading:true});
    this.coverageTask=loadRussiaGeometry().then(coverage=>{
      if(this.disposed){coverage.dispose();return;}
      this.coverage=coverage;this.applyCoverage();this.unbindCoverage=coverage.subscribe(()=>this.applyCoverage());
      this.updateState({ready:true,loading:false,error:''});this.options.onReady?.(this);this.schedule();this.settled();
    }).catch(()=>this.updateState({loading:false,error:'Границы карты не загрузились. Проверьте подключение и повторите загрузку.'}))
      .finally(()=>{this.coverageTask=undefined;this.retryAfterOnline();});
  }
  /** Retry the current view without changing its camera or displayed ground.
   * Repeated input shares an existing attempt instead of adding generations. */
  retry(){
    if(this.disposed)return;
    if(!this.coverage){this.loadCoverage();return;}
    if(this.state.loading)return;
    this.currentKeys='';this.refreshTiles();
  }
  private retryAfterOnline(){
    if(!this.retryAfterCurrent)return;
    this.retryAfterCurrent=false;
    if(this.state.error)this.retry();
  }
  getCamera():CustomMapCamera{return{...this.camera,center:[...this.camera.center]};}
  getSize():MapViewport{return{...this.size};}
  getBounds():GeographicBounds{return cameraBounds(this.camera,this.virtualSize());}
  /** Current unobscured ground; reading it never recentres the camera. Insets
   * are CSS pixels, so undo the flat renderer's pitch compression as well. */
  getVisibleBounds(padding:Partial<MapInsets>=this.padding):GeographicBounds{
    const pitchScale=Math.cos(this.pitch*Math.PI/180);
    return cameraBounds(this.camera,this.virtualSize(),{...padding,top:(padding.top??0)/pitchScale,bottom:(padding.bottom??0)/pitchScale});
  }
  getPitch(){return this.pitch;}
  getCoverage(){return this.coverage;}
  getState(){return{...this.state};}
  inspect(){
    const describe=(batch?:TileBatch)=>batch?.tiles.map(tile=>{const n=2**tile.z,sw=mercatorUnproject({x:tile.x/n,y:(tile.y+1)/n}),ne=mercatorUnproject({x:(tile.x+1)/n,y:tile.y/n});return{key:tile.key,kind:tile.kind,z:tile.z,x:tile.x,y:tile.y,local:tile.local,width:tile.bitmap.width,height:tile.bitmap.height,bounds:[sw[0],sw[1],ne[0],ne[1]],transparent:!!tile.transparent,...(tile.reliefCoverage?{reliefCoverage:tile.reliefCoverage}:{})};})||[];
    const padding={top:this.padding.top??0,right:this.padding.right??0,bottom:this.padding.bottom??0,left:this.padding.left??0};
    // During resize the previous sheet insets can briefly exceed the new size.
    // Inspection must stay safe until the layout observer supplies fresh values.
    const visible=Object.values(padding).every(value=>Number.isFinite(value)&&value>=0)&&padding.left+padding.right<this.size.width&&padding.top+padding.bottom<this.size.height;
    return{engine:'tropnik-canvas',rasterPolicy:this.rasterPolicy,contextAttributes:this.context.getContextAttributes?.()??null,camera:this.getCamera(),pitch:this.pitch,viewport:{...this.size,padding},visibleBounds:visible?this.getVisibleBounds(padding):null,state:this.getState(),coverage:this.coverage?.status,routeId:this.routeId||'',drawnRoute:this.element.dataset.mapDrawnRoute||'',drawRevision:this.drawRevision,labelRevision:this.labelRevision,tiles:{overview:describe(this.overview),detail:describe(this.displayDetail()),relief:describe(this.relief),imagery:describe(this.imagery)},labels:this.getLabelDiagnostics(),resources:this.tiles.snapshot()};
  }
  private publishInspection(){if(this.disposed)return;this.element.dataset.mapTilesState=this.state.loading?'loading':this.state.error?'error':'ready';this.element.dataset.mapInspection=JSON.stringify(this.inspect());}
  private setMoving(moving:boolean){this.element.dataset.mapMoving=String(moving);if(moving)this.element.dataset.mapCamera='moving';else delete this.element.dataset.mapCamera;}
  setActive(active:boolean){if(this.active===active)return;this.active=active;this.tiles.setActive(active);if(!active){this.pointer.cancel();this.stopAnimation();cancelAnimationFrame(this.frame);this.frame=0;clearTimeout(this.settleTimer);this.setMoving(false);}else{this.schedule();this.settled();}}
  setEco(enabled:boolean){if(this.eco===enabled)return;this.eco=enabled;this.canvas.width=1;this.resizeCanvas();}
  setLabels(labels:readonly CustomMapLabel[]){this.additionalLabels=labels.slice(0,256).map(label=>({...label,coordinate:[...label.coordinate]}));this.scheduleLabels();}
  getLabelDiagnostics():CustomMapLabelDiagnostic[]{return this.labelDiagnostics.slice(0,MAP_LABEL_SAMPLE_LIMIT).map(copyMapLabelDiagnostic);}
  inspectLabels(request:unknown){
    const selection=selectRecordedMapLabels(this.labelDiagnostics,this.labelDiagnosticTotal,request);
    if(!selection)return{error:'Invalid label inspection request'};
    const {candidates,...labelInspection}=selection;
    return{...this.inspect(),labels:candidates,labelInspection};
  }
  project(coordinate:readonly number[]){const point=project(this.camera,this.size,coordinate);return{x:point.x,y:this.size.height/2+(point.y-this.size.height/2)*Math.cos(this.pitch*Math.PI/180)};}
  unproject(point:MapPoint){return unproject(this.camera,this.size,this.flatPoint(point));}
  private flatPoint(point:MapPoint){return{x:point.x,y:this.size.height/2+(point.y-this.size.height/2)/Math.cos(this.pitch*Math.PI/180)};}
  private virtualSize(){return{width:this.size.width,height:this.size.height/Math.cos(this.pitch*Math.PI/180)};}
  setPitch(degrees:number){if(!Number.isFinite(degrees))return;this.pitch=Math.max(0,Math.min(60,degrees));this.element.dataset.mapPitch=String(this.pitch);this.currentKeys='';this.pointer.cancel();this.settled();}
  setPadding(padding:Partial<MapInsets>){
    if((['top','right','bottom','left'] as const).every(side=>(padding[side]??0)===(this.padding[side]??0)))return;
    this.padding={...padding};this.publishInspection();
  }
  setFloor(camera:CustomMapCamera){this.floor={...camera};}
  setObstacles(rectangles:typeof this.obstacles){
    // Count/label reflow can measure the same controls after every keystroke.
    // Their unchanged footprints do not invalidate any map pixels.
    if(rectangles.length===this.obstacles.length&&rectangles.every((rect,index)=>{
      const previous=this.obstacles[index];return rect.left===previous.left&&rect.top===previous.top&&rect.right===previous.right&&rect.bottom===previous.bottom;
    }))return;
    this.obstacles=rectangles.map(rect=>({...rect}));this.scheduleLabels();
  }
  private stopAnimation(){cancelAnimationFrame(this.animation);this.animation=0;this.zoomTarget=null;}
  setCamera(next:CustomMapCamera,animate=false){this.moveCamera(next,animate);}
  private moveCamera(next:CustomMapCamera,animate:boolean,zoomControl=false){
    if(this.disposed)return;
    this.pointer.cancel();this.stopAnimation();
    const constrained=constrainFramedCamera(next.center[0],next.center[1],next.zoom,{...this.floor,center:[...this.floor.center]},this.framed?{...this.framed,center:[...this.framed.center]}:null);
    const target:CustomMapCamera={center:constrained.center as [number,number],zoom:Math.min(this.options.maxZoom??18,constrained.zoom),bearingDegrees:next.bearingDegrees??0};
    if(!animate||!this.active||this.eco||matchMedia('(prefers-reduced-motion: reduce)').matches){this.camera=target;this.schedule();this.settled();return;}
    const start=this.getCamera(),from=mercatorProject(start.center),to=mercatorProject(target.center),at=performance.now();
    // A burst owns one clamped destination. Interpolated frames must not eat
    // subsequent button/key steps or accumulate debt beyond either limit.
    this.zoomTarget=zoomControl?target.zoom:null;
    this.setMoving(true);
    const tick=()=>{
      if(this.disposed)return;const t=Math.min(1,(performance.now()-at)/240),eased=1-(1-t)**3;
      this.camera={center:mercatorUnproject({x:from.x+(to.x-from.x)*eased,y:from.y+(to.y-from.y)*eased}),zoom:start.zoom+(target.zoom-start.zoom)*eased,bearingDegrees:(start.bearingDegrees??0)+((target.bearingDegrees??0)-(start.bearingDegrees??0))*eased};
      this.draw();if(t<1)this.animation=requestAnimationFrame(tick);else{this.animation=0;this.zoomTarget=null;this.settled();}
    };this.animation=requestAnimationFrame(tick);
  }
  fit(bounds:GeographicBounds,padding:Partial<MapInsets>={},maxZoom=14,animate=true){
    this.padding=padding;this.framed=fitBounds(bounds,this.size,{padding,maxZoom,minZoom:this.floor.zoom,referenceLongitude:105});this.setCamera(this.framed,animate);
  }
  zoomBy(delta:number){if(this.disposed||!Number.isFinite(delta))return;const zoom=(this.zoomTarget??this.camera.zoom)+delta;this.options.onGesture?.();this.moveCamera(zoomAt(this.camera,this.size,zoom,undefined,{minZoom:this.floor.zoom,maxZoom:this.options.maxZoom??18}),true,true);}
  north(){this.options.onGesture?.();this.setCamera({...this.camera,bearingDegrees:0},true);}
  setMode(mode:CustomMapMode){
    if(this.mode===mode){if(this.state.error)this.retry();return;}this.mode=mode;this.currentKeys='';
    if(mode==='overview'){
      this.detail=undefined;this.relief=undefined;this.imagery=undefined;this.imageryOverlay=undefined;
      this.updateState({committedMode:'overview',reliefReady:false,localDetail:false,imagerySource:undefined});
    }
    // Both directions keep the last complete ground. A transparent overlay
    // never replaces opaque relief, and a cold relief load never drops imagery.
    this.updateState({mode,imageryLoading:false,imageryTarget:undefined});this.refreshTiles();this.schedule();
  }
  setLayers(layers:{paths?:boolean;boundaries?:boolean;relief?:boolean}){
    if(layers.paths!==undefined&&layers.paths!==this.paths){this.paths=layers.paths;this.currentKeys='';}
    if(layers.boundaries!==undefined&&layers.boundaries!==this.boundaryVisible){this.boundaryVisible=layers.boundaries;this.currentKeys='';}
    if(layers.relief!==undefined)this.reliefVisible=layers.relief;
    this.refreshTiles();this.schedule();
  }
  setRegion(shapes:string[]=[]){this.selectedShapes=[...shapes];this.updateSelectedArea();this.schedule();}
  setRoute(geometry:FeatureGeometry,id?:string){
    const path=geometry?geometryPath(geometry):undefined;
    this.route=path?.bounds.every(Number.isFinite)?path:undefined;this.routeId=this.route?id:undefined;this.element.dataset.mapRouteId=this.routeId||'';
    this.routeEdges.forEach(edge=>edge.element.remove());this.routeEdges=[];
    if(geometry)for(const edge of routeLineEdges(geometry)){const element=createRouteEdgeElement(edge);this.markerLayer.appendChild(element);this.routeEdges.push({element,project:()=>this.project(edge.coordinate)});}
    this.schedule();
  }
  setMarkers(markers:readonly CustomMapMarker[]){
    const ids=new Set(markers.map(marker=>marker.id));
    for(const [id,record] of this.markers)if(!ids.has(id)){record.button.remove();this.markers.delete(id);}
    for(const marker of markers){
      let record=this.markers.get(marker.id);
      if(record&&record.marker.kind!==marker.kind){record.button.remove();this.markers.delete(marker.id);record=undefined;}
      if(!record){
        const button=marker.kind==='direction'?createDirectionMarker({id:marker.id,name:marker.label}):document.createElement('button');
        button.type='button';button.dataset.mapMarkerId=marker.id;
        if(marker.kind!=='direction')button.className=`tropnik-point-marker tropnik-point-marker--${marker.kind}`;
        button.addEventListener('click',()=>{
          const group=this.markerGroups.get(marker.id);
          if(group&&group.members.length>1){this.options.onGesture?.();const camera=fitBounds(group.bounds,this.size,{padding:this.padding,maxZoom:11,referenceLongitude:105});this.setCamera({...camera,zoom:Math.max(this.camera.zoom+1,camera.zoom)},true);}
          else this.options.onMarker?.(marker.id);
        });
        this.markerLayer.appendChild(button);record={marker,button};this.markers.set(marker.id,record);
      }
      record.marker=marker;
      if(marker.kind!=='direction'){
        record.button.setAttribute('aria-label',marker.kind==='trail'?`Открыть маршрут ${marker.label}`:marker.label);
        record.button.dataset.trailId=marker.kind==='trail'?marker.id:'';
        record.button.classList.toggle('is-selected',!!marker.active);
        record.button.textContent=marker.kind==='plan'?marker.label.slice(0,2):'';
      }
    }
    this.schedule(false);
  }
  setPosition(coordinate:[number,number]|null){const others=[...this.markers.values()].map(r=>r.marker).filter(marker=>marker.id!=='current-position');if(coordinate)others.push({id:'current-position',coordinate,label:'Моё местоположение',kind:'position'});this.setMarkers(others);}
  private coveragePath(geometry:FeatureGeometry):Path2D{
    if(!geometry)return new Path2D();
    if(geometry.type==='Feature')return this.coveragePath(geometry.geometry??undefined);
    if(geometry.type==='FeatureCollection'||geometry.type==='GeometryCollection'){
      const children=geometry.type==='FeatureCollection'?geometry.features:geometry.geometries;
      if(children.length===1)return this.coveragePath(children[0]);
      const path=new Path2D();for(const child of children)path.addPath(this.coveragePath(child));return path;
    }
    // Coverage commits reuse immutable cell geometry. Keep each source path at
    // its original precision and append it in source order, including every
    // ring and hole. Rewalking the whole country makes closePath costly on the
    // final zoom frame even when only a few cells have changed.
    // Weak keys follow the bounded coverage cache (24 MiB) and current view;
    // visiting new cells never creates a second, strongly retained history.
    let path=this.coveragePaths.get(geometry);
    if(!path){path=geometryPath(geometry).path;this.coveragePaths.set(geometry,path);}
    return path;
  }
  private selectedCoveragePath(source:GeoJSON.FeatureCollection|undefined){
    const features=source?.features.filter(f=>this.selectedShapes.includes(String(f.properties?.shapeName)))||[];
    return features.length?this.coveragePath({type:'FeatureCollection',features}):undefined;
  }
  private updateSelectedArea(){
    const area=this.selectedCoveragePath(this.coverage?.territories),boundary=this.selectedCoveragePath(this.coverage?.boundaries);
    this.selectedArea=area;this.selectedBoundary=boundary;
  }
  private applyCoverage(){
    if(!this.coverage)return;
    const s=this.coverage.status,changed=s.revision!==this.coverageRevision;
    // Coverage progress and errors keep the current immutable geometry. Only
    // an atomic source commit advances its revision and needs new paths.
    if(changed){
      const area=this.coveragePath(this.coverage.area),boundaries=this.coveragePath(this.coverage.boundaries),selected=this.selectedCoveragePath(this.coverage.territories),selectedBoundary=this.selectedCoveragePath(this.coverage.boundaries);
      const mask=new Path2D();mask.rect(-3,-3,8,8);mask.addPath(area);
      this.area=area;this.boundaries=boundaries;this.mask=mask;this.selectedArea=selected;this.selectedBoundary=selectedBoundary;this.coverageRevision=s.revision;
    }
    this.element.dataset.mapCoverage=JSON.stringify(s);this.element.dataset.mapCoverageLod=s.lod;this.element.dataset.mapCoverageState=s.ready?'ready':'loading';
    if(changed){
      // A more precise immutable mask can reveal an island in a tile which was
      // previously wholly hidden. Revalidate saved omissions without a pan;
      // an in-flight replacement checks the current mask at its own commit.
      if(this.state.ready&&!this.state.loading&&[this.detail,this.relief,this.imagery,this.imageryOverlay].some(batch=>!this.batchCoversMask(batch))){this.currentKeys='';this.refreshTiles();}
      this.schedule();
    }else this.publishInspection();
  }
  private listen(target:EventTarget,name:string,fn:EventListener,options?:AddEventListenerOptions|boolean){target.addEventListener(name,fn,options);this.listeners.push([target,name,fn,options]);}
  private bindInput(){
    // Return the decisions of the last label paint without drawing, measuring
    // text again or changing the ordinary bounded DOM sample.
    this.listen(this.element,MAP_LABEL_INSPECTION_EVENT,((event:CustomEvent<{request:unknown;response?:string}>)=>{
      const detail=event.detail;if(!detail||typeof detail!=='object')return;
      detail.response=JSON.stringify(this.inspectLabels(detail.request));
    }) as EventListener);
    const local=(event:PointerEvent|WheelEvent)=>{const rect=this.pointerRect??this.canvas.getBoundingClientRect();return{x:event.clientX-rect.left,y:event.clientY-rect.top};};
    this.listen(this.canvas,'pointerdown',((event:PointerEvent)=>{
      if(event.button!==0||!this.state.ready||!this.active)return;event.preventDefault();this.canvas.focus({preventScroll:true});
      this.stopAnimation();clearTimeout(this.settleTimer);this.options.onGesture?.();
      this.pointerRect=this.canvas.getBoundingClientRect();const point=local(event);this.pointer.begin(event.pointerId,this.flatPoint(point),this.camera,this.size);
      this.setMoving(true);
      if(this.pointer.activePointers===1){this.pointerStart={...point,time:performance.now(),id:event.pointerId};this.pointerMoved=false;}else this.pointerMoved=true;
      this.canvas.setPointerCapture(event.pointerId);this.canvas.classList.add('is-moving');
    }) as EventListener);
    this.listen(this.canvas,'pointermove',((event:PointerEvent)=>{
      if(!this.pointer.activePointers)return;const point=local(event),next=this.pointer.move(event.pointerId,this.flatPoint(point));if(!next)return;
      if(this.pointerStart&&Math.hypot(point.x-this.pointerStart.x,point.y-this.pointerStart.y)>5)this.pointerMoved=true;
      const constrained=constrainFramedCamera(next.center[0],next.center[1],next.zoom,{...this.floor,center:[...this.floor.center]},this.framed?{...this.framed,center:[...this.framed.center]}:null);
      this.camera={...next,center:constrained.center as [number,number],zoom:constrained.zoom};this.schedule();
    }) as EventListener);
    const end=((event:PointerEvent)=>{
      const start=this.pointerStart,point=local(event),tap=event.type==='pointerup'&&!this.pointerMoved&&start?.id===event.pointerId&&performance.now()-start.time<700;
      this.pointer.end(event.pointerId);if(this.canvas.hasPointerCapture(event.pointerId))this.canvas.releasePointerCapture(event.pointerId);
      if(!this.pointer.activePointers){this.pointerRect=undefined;this.pointerStart=undefined;this.canvas.classList.remove('is-moving');this.settled();}
      if(tap)this.options.onClick?.(point,this.unproject(point));
    }) as EventListener;
    this.listen(this.canvas,'pointerup',end);this.listen(this.canvas,'pointercancel',end);
    this.listen(this.canvas,'lostpointercapture',((event:PointerEvent)=>{
      const wasActive=this.pointer.activePointers;this.pointer.end(event.pointerId);
      if(wasActive&&!this.pointer.activePointers){this.pointerRect=undefined;this.pointerStart=undefined;this.canvas.classList.remove('is-moving');this.settled();}
    }) as EventListener);
    this.listen(this.canvas,'wheel',((event:WheelEvent)=>{
      if(!this.state.ready||!this.active)return;event.preventDefault();this.options.onGesture?.();this.stopAnimation();
      const next=zoomAt(this.camera,this.size,this.camera.zoom+wheelZoomDelta(event.deltaY,event.deltaMode,this.size.height),this.flatPoint(local(event)),{minZoom:this.floor.zoom,maxZoom:this.options.maxZoom??18});
      const constrained=constrainFramedCamera(next.center[0],next.center[1],next.zoom,{...this.floor,center:[...this.floor.center]},this.framed?{...this.framed,center:[...this.framed.center]}:null);
      this.camera={...next,center:constrained.center as [number,number],zoom:constrained.zoom};this.setMoving(true);this.schedule();
      clearTimeout(this.settleTimer);this.settleTimer=setTimeout(()=>this.settled(),110);
    }) as EventListener,{passive:false});
    this.listen(this.canvas,'dblclick',((event:MouseEvent)=>{if(!this.state.ready||!this.active)return;event.preventDefault();const rect=this.canvas.getBoundingClientRect();this.options.onGesture?.();this.setCamera(zoomAt(this.camera,this.size,this.camera.zoom+1,this.flatPoint({x:event.clientX-rect.left,y:event.clientY-rect.top}),{minZoom:this.floor.zoom,maxZoom:this.options.maxZoom??18}),true);}) as EventListener);
    this.listen(this.canvas,'keydown',((event:KeyboardEvent)=>{
      if(event.altKey||event.ctrlKey||event.metaKey||!this.state.ready||!this.active)return;
      if(['+','=','Add','PageUp','-','−','Subtract','PageDown'].includes(event.key)){event.preventDefault();this.zoomBy(['+','=','Add','PageUp'].includes(event.key)?1:-1);return;}
      const next=keyboardCameraAction(this.camera,this.size,event.key,{minZoom:this.floor.zoom,maxZoom:this.options.maxZoom??18});
      if(next){event.preventDefault();this.options.onGesture?.();this.setCamera(next,true);}else if(event.key==='Home'){event.preventDefault();this.options.onGesture?.();this.setCamera(this.floor,true);}
    }) as EventListener);
    this.listen(window,'blur',()=>{this.pointer.cancel();this.canvas.classList.remove('is-moving');this.settled();});
    this.listen(window,'online',()=>{
      if(this.coverageTask||this.state.loading)this.retryAfterCurrent=true;
      else this.retry();
    });
    this.listen(window,'offline',()=>{this.currentKeys='';this.updateState({error:'Нет сети. Доступны сохранённые границы, маршруты и загруженные участки карты.'});this.refreshTiles();});
  }
  private resizeCanvas(){
    if(this.disposed)return;const width=Math.max(1,this.element.clientWidth),height=Math.max(1,this.element.clientHeight);
    if(width===this.size.width&&height===this.size.height&&this.canvas.width>1)return;
    this.pointer.cancel();this.size={width,height};this.pixelRatio=this.eco?1:Math.min(devicePixelRatio||1,matchMedia('(pointer:coarse)').matches?1.5:2);
    this.canvas.width=Math.round(width*this.pixelRatio);this.canvas.height=Math.round(height*this.pixelRatio);
    this.labelCanvas.width=this.canvas.width;this.labelCanvas.height=this.canvas.height;
    for(const surface of [this.canvas,this.labelCanvas]){surface.style.width=`${width}px`;surface.style.height=`${height}px`;}
    this.currentKeys='';this.schedule();if(this.state.ready)this.settled();
  }
  private updateState(change:Partial<CustomMapState>){
    if(this.disposed)return;this.state={...this.state,...change,residentTiles:this.tiles.resident,pendingTiles:this.tiles.pending};this.publishInspection();this.options.onState?.({...this.state});
  }
  private schedule(paint=true){
    this.paintRequested||=paint;
    if(!this.frame&&!this.disposed&&this.active)this.frame=requestAnimationFrame(()=>{
      this.frame=0;const repaint=this.paintRequested,relabel=this.labelsRequested;this.paintRequested=false;this.labelsRequested=false;
      if(repaint)this.draw();else{
        if(relabel){this.drawLabels();this.publishInspection();}
        this.drawMarkers();
      }
    });
  }
  private scheduleLabels(){this.labelsRequested=true;this.schedule(false);}
  private settled(){
    if(this.disposed||!this.active)return;
    this.setMoving(false);
    publishMapCamera(this.element,{longitude:this.camera.center[0],latitude:this.camera.center[1],zoom:this.camera.zoom,tileSize:256,engine:'tropnik-canvas',centerX:this.size.width/2,centerY:this.size.height/2});
    this.element.dataset.mapBearing=String(this.camera.bearingDegrees??0);
    this.options.onSettled?.(this.getCamera());const b=this.getBounds();
    requestAnimationFrame(()=>{if(!this.disposed){constrainDirectionLabels(new Map([...this.markers].filter(([,r])=>r.marker.kind==='direction').map(([id,r])=>[id,r.button])),this.element);syncRouteEdgeAnnotations(this.routeEdges);}});
    void this.coverage?.updateView([...b],this.camera.zoom).catch(()=>undefined);
    this.refreshTiles();this.schedule();
  }
  private refreshTiles(){
    if(this.disposed||!this.active||!this.coverage)return;
    const view=this.virtualSize(),z=Math.max(0,Math.floor(this.camera.zoom)),overviewRequests=tileRequests(this.camera,view,Math.min(4,z),'overview');
    const detailLevel=Math.min(18,Math.ceil(this.camera.zoom));
    const detailRequests=this.mode!=='overview'&&z>=5?tileRequests(this.camera,view,detailLevel,'vector',this.paths,this.mode==='satellite',this.boundaryVisible):[];
    const reliefRequests=this.mode==='detail'&&this.reliefVisible&&z>=5?tileRequests(this.camera,view,detailLevel,'relief'):[];
    const b=this.getBounds(),source=satelliteSourceForBounds({west:b[0],south:b[1],east:b[2],north:b[3]});
    const imageryRequests=this.mode==='satellite'?tileRequests(this.camera,view,Math.min(source==='eox-s2'?14:8,z),source):[];
    const requests=[...overviewRequests,...detailRequests,...reliefRequests,...imageryRequests],keys=requests.map(customTileKey).join('|');
    if(keys===this.currentKeys)return;this.currentKeys=keys;const generation=++this.generation;
    const retainedKeys=()=>[this.overview,this.detail,this.relief,this.imagery,this.imageryOverlay].flatMap(batch=>batch?.tiles.map(t=>t.key)||[]);
    this.tiles.pin([...requests.map(customTileKey),...retainedKeys()]);
    this.updateState({loading:requests.length>0,imageryLoading:imageryRequests.length>0,imageryTarget:imageryRequests.length?source:undefined});
    const current=()=>!this.disposed&&generation===this.generation;
    let checkedCoverageRevision=this.coverageRevision;
    const batch=async(list:CustomTileRequest[],kind:CustomTileKind)=>{
      const result=await Promise.allSettled(list.map(request=>this.tiles.load(request)));
      const ready=result.flatMap(value=>value.status==='fulfilled'?[value.value]:[]),failed=result.length-ready.length;
      const missing=list.filter((_,index)=>result[index].status==='rejected');
      return{value:{tiles:ready,kind,generation,missing} satisfies TileBatch,failed};
    };
    const overview=batch(overviewRequests,'overview').then(result=>{
      if(!current())return;
      // The overview remains a usable fallback while the selected detailed
      // ground is staged. An incomplete replacement cannot erase a saved view.
      if(result.value.tiles.length&&(!result.failed||!this.overview)){this.overview=result.value;this.schedule();}
      if(!detailRequests.length&&!imageryRequests.length){
        if(result.failed){this.updateState({error:'Обзор карты загрузился не полностью. Повторите загрузку.'});return;}
        this.detail=undefined;this.relief=undefined;this.imagery=undefined;this.imageryOverlay=undefined;
        this.updateState({committedMode:'overview',reliefReady:false,localDetail:false,imagerySource:undefined,...(navigator.onLine?{error:''}:{})});this.schedule();
      }
    });
    const ground=Promise.all([batch(detailRequests,'vector'),batch(reliefRequests,'relief'),batch(imageryRequests,source)]).then(([detail,relief,imagery])=>{
      if(!current()||!detailRequests.length&&!imageryRequests.length)return;
      checkedCoverageRevision=this.coverageRevision;
      const detailFailed=!this.batchCoversMask(detail.value),reliefFailed=!this.batchCoversMask(relief.value),imageryFailed=!this.batchCoversMask(imagery.value);
      if(imageryFailed||!imageryRequests.length&&(detailFailed||reliefFailed)){
        this.updateState({imageryLoading:false,error:imageryRequests.length?'Спутниковая карта загрузилась не полностью. Повторите загрузку.':'Подробная карта загрузилась не полностью. Повторите загрузку.'});return;
      }
      if(imageryRequests.length){
        // A complete photograph is useful even if the independent map-object
        // service failed. Keep a prior complete overlay, never a partial one,
        // and report missing objects instead of discarding available imagery.
        this.imagery=imagery.value;if(!detailFailed)this.imageryOverlay=detail.value;this.detail=undefined;this.relief=undefined;
        const overlay=this.imageryOverlay;
        this.updateState({committedMode:'satellite',imageryLoading:false,imagerySource:source,reliefReady:false,localDetail:!!overlay?.tiles.length&&overlay.tiles.every(t=>t.local),...(detailFailed?{error:'Подписи и тропы на спутниковой карте загрузились не полностью. Повторите загрузку.'}:navigator.onLine?{error:''}:{})});
      }else{
        this.detail=detail.value;this.relief=reliefRequests.length?relief.value:undefined;this.imagery=undefined;this.imageryOverlay=undefined;
        this.updateState({committedMode:'detail',imagerySource:undefined,imageryTarget:undefined,reliefReady:relief.value.tiles.length>0,localDetail:detail.value.tiles.length>0&&detail.value.tiles.every(t=>t.local),...(navigator.onLine?{error:''}:{})});
      }
      this.schedule();
    });
    void Promise.all([overview,ground]).finally(()=>{if(current()){
      this.tiles.pin([...requests.map(customTileKey),...retainedKeys()]);this.updateState({loading:false});
      // Ground may commit before the independent overview finishes. Recheck
      // omissions if the mask advanced in that interval; a failed retry at the
      // same revision remains an error, never an automatic request loop.
      if(checkedCoverageRevision!==this.coverageRevision&&[this.detail,this.relief,this.imagery,this.imageryOverlay].some(batch=>!this.batchCoversMask(batch)))this.retry();
      this.retryAfterOnline();
    }});
  }
  private batchCoversMask(batch:TileBatch|undefined){return !batch?.missing?.some(tile=>mapTileIntersectsCoverage(this.coverage?.area,tile,this.camera.zoom,this.pitch));}
  private displayingSatellite(){return this.state.committedMode==='satellite'&&!!this.imagery;}
  private displayDetail(){return this.displayingSatellite()?this.imageryOverlay:this.detail;}
  private worldTransform(){
    const ctx=this.context,s=256*2**this.camera.zoom,c=mercatorProject(this.camera.center),angle=(this.camera.bearingDegrees??0)*Math.PI/180;
    ctx.setTransform(this.pixelRatio,0,0,this.pixelRatio,0,0);ctx.translate(this.size.width/2,this.size.height/2);ctx.scale(1,Math.cos(this.pitch*Math.PI/180));ctx.rotate(-angle);ctx.scale(s,s);ctx.translate(-c.x,-c.y);return s;
  }
  private drawTiles(batch:TileBatch|undefined,alpha=1){
    if(!batch)return;const ctx=this.context;ctx.globalAlpha=alpha;
    for(const tile of batch.tiles){const n=2**tile.z;ctx.drawImage(tile.bitmap,tile.x/n,tile.y/n,1/n+1e-10,1/n+1e-10);}ctx.globalAlpha=1;
  }
  private detailCoversViewport(batch:TileBatch|undefined):boolean{
    if(this.mode!=='detail'||this.pitch!==0||(this.camera.bearingDegrees??0)!==0||this.camera.zoom<4.7||this.camera.zoom>12||batch?.kind!=='vector'||!batch.tiles.length||batch.tiles.length>MAX_VISIBLE_TILES)return false;
    const ratio=this.pixelRatio,width=this.canvas.width,height=this.canvas.height,scale=256*2**this.camera.zoom,center=mercatorProject(this.camera.center),z=batch.tiles[0].z;
    if(![ratio,width,height,this.size.width,this.size.height,scale,center.x,center.y].every(Number.isFinite)||ratio<=0||ratio>2||width<=0||height<=0||width>32768||height>32768||this.size.width<=0||this.size.height<=0||Math.abs(center.x)>2||center.y<0||center.y>1||!Number.isInteger(z)||z<0||z>18)return false;
    const n=2**z;
    // Axis-aligned tile images wider than one device pixel have no edge AA.
    // Keep this proof inside a bounded float32 transform range. Four physical
    // pixels cover rounding of the source points and native canvas matrix;
    // higher zoom, rotation, pitch and distant world copies keep the underlays.
    if(scale*ratio/n<=1)return false;
    const margin=4,left=(center.x+(-margin/ratio-this.size.width/2)/scale)*n,right=(center.x+((width+margin)/ratio-this.size.width/2)/scale)*n;
    const top=(center.y+(-margin/ratio-this.size.height/2)/scale)*n,bottom=(center.y+((height+margin)/ratio-this.size.height/2)/scale)*n;
    const x0=Math.floor(left),x1=Math.floor(right),y0=Math.floor(top),y1=Math.floor(bottom);
    if(![x0,x1,y0,y1].every(Number.isSafeInteger)||x1<x0||y1<y0||y0<0||y1>=n||(x1-x0+1)*(y1-y0+1)>MAX_VISIBLE_TILES)return false;
    const cells=new Set<string>();
    for(const tile of batch.tiles){
      // Every admitted worker output is a full 512px opaque vector raster.
      // Closed/missing bitmaps, mixed grids and satellite overlays cannot hide
      // the base, even when the batch itself has already been committed.
      if(tile.kind!=='vector'||tile.transparent!==false||tile.z!==z||!Number.isSafeInteger(tile.x)||!Number.isInteger(tile.y)||tile.y<0||tile.y>=n||tile.bitmap.width!==512||tile.bitmap.height!==512)return false;
      cells.add(`${tile.x}/${tile.y}`);
    }
    // Recheck the current backing pixels on every frame: a retained batch can
    // expose an edge during a pan or resize, and a failed batch may have holes.
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)if(!cells.has(`${x}/${y}`))return false;
    return true;
  }
  private draw(){
    if(this.disposed||!this.active)return;const ctx=this.context;
    const detail=this.displayDetail(),covered=this.detailCoversViewport(detail);
    ctx.setTransform(1,0,0,1,0,0);
    // Fully opaque detail overwrites every backing pixel, including the guard
    // margin. A missing cell or exposed pan edge retains the original clear.
    if(!covered){ctx.fillStyle=MAP_OUTSIDE_COLOR;ctx.fillRect(0,0,this.canvas.width,this.canvas.height);}
    const scale=this.worldTransform();
    if(!covered){
      if(this.area){ctx.fillStyle='#dce5cf';ctx.fill(this.area,'evenodd');}
      this.drawTiles(this.overview,.95);
    }
    const satellite=this.displayingSatellite();
    if(satellite)this.drawTiles(this.imagery);
    if(this.mode!=='overview'&&this.camera.zoom>=4.7&&(!satellite||detail?.tiles[0]?.transparent))this.drawTiles(detail);
    if(!satellite&&(this.mode==='detail'||this.state.committedMode==='detail')&&this.reliefVisible&&this.camera.zoom>=4.7)this.drawTiles(this.relief,.82);
    if(this.boundaryVisible&&this.boundaries){ctx.strokeStyle=satellite?'rgba(245,248,232,.45)':'rgba(95,123,87,.45)';ctx.lineWidth=.65/scale;ctx.stroke(this.boundaries);}
    if(this.selectedArea){ctx.fillStyle='rgba(92,128,70,.10)';ctx.fill(this.selectedArea,'evenodd');}
    // Clipped territory polygons include artificial coverage-cell edges. Only
    // the source boundary lines may outline the selected territory.
    if(this.selectedBoundary){ctx.strokeStyle=satellite?'#e7eacc':'#688360';ctx.lineWidth=1.3/scale;ctx.stroke(this.selectedBoundary);}
    if(this.route){ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#fffef5';ctx.lineWidth=(routeStrokeWidth(this.camera.zoom)+3)/scale;ctx.stroke(this.route.path);ctx.strokeStyle='#244d3c';ctx.lineWidth=routeStrokeWidth(this.camera.zoom)/scale;ctx.stroke(this.route.path);}
    if(this.mask){ctx.fillStyle=MAP_OUTSIDE_COLOR;ctx.fill(this.mask,'evenodd');}
    this.drawLabels();
    this.element.dataset.mapPainted='true';this.element.dataset.mapCanvas='custom';this.element.dataset.mapDrawnRoute=this.routeId||'';
    this.drawRevision++;this.drawMarkers();if(!this.pointer.activePointers&&!this.animation)this.publishInspection();this.options.onFrame?.(this.getCamera());
  }
  private drawMarkers(){
    const directions=[...this.markers.values()].filter(record=>record.marker.kind==='direction');
    const groups=groupMapDirections(directions.map(({marker:m})=>({id:m.id,name:m.label,center:m.coordinate})),coordinate=>this.project(coordinate),new Set([...this.markerGroups.values()].map(group=>group.key)));
    this.markerGroups=updateDirectionButtons(new Map(directions.map(r=>[r.marker.id,r.button])),groups,new Map(directions.map(r=>[r.marker.id,r.marker.count||0])),this.camera.zoom<5,directions.find(r=>r.marker.active)?.marker.id);
    for(const {marker,button} of this.markers.values()){
      const p=this.project(marker.coordinate),outside=p.x< -22||p.x>this.size.width+22||p.y< -22||p.y>this.size.height+22;
      if(marker.kind!=='direction')button.hidden=outside;
      else if(outside)button.hidden=true;
      button.style.transform=`translate(${p.x-22}px,${p.y-22}px)`;
    }
    for(const edge of this.routeEdges){const p=edge.project();edge.element.style.position='absolute';edge.element.style.left=`${p.x}px`;edge.element.style.top=`${p.y}px`;}
  }
  private drawLabels(){
    this.labelDiagnostics=[];this.labelDiagnosticTotal=0;
    // Control widths and the sheet affect label collisions, not terrain. Keep
    // those pixels on their own surface so input never replays the base paths.
    const ctx=this.labelContext;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,this.labelCanvas.width,this.labelCanvas.height);
    ctx.setTransform(this.pixelRatio,0,0,this.pixelRatio,0,0);this.labelRevision++;
    if(!this.coverage){this.labelCanvas.hidden=true;return;}
    const occupied=this.obstacles.map(r=>({...r})),seen=new Set<string>(),repeated=new Map<string,MapPoint[]>();
    const candidates:Array<{id:string;coordinate:[number,number];label:MapTileLabel;color?:string}>=this.additionalLabels.map(label=>({id:label.id,coordinate:label.coordinate,label:{x:0,y:0,text:label.label,kind:label.kind??'place',rank:label.rank??0},color:label.color}));
    const detail=this.displayDetail(),satellite=this.displayingSatellite();
    const labelBatches=[detail];
    // Height annotations belong to the committed measured relief. They follow
    // its visibility, including the retained ground during an imagery load.
    if(!satellite&&(this.mode==='detail'||this.state.committedMode==='detail')&&this.reliefVisible&&this.camera.zoom>=10)labelBatches.push(this.relief);
    if(this.mode!=='overview'&&this.camera.zoom>=5)for(const batch of labelBatches)if(batch)for(const tile of batch.tiles)for(const label of tile.labels){const n=2**tile.z;candidates.push({id:`${tile.key}:${label.text}`,coordinate:mercatorUnproject({x:(tile.x+label.x)/n,y:(tile.y+label.y)/n}),label});}
    candidates.sort((a,b)=>mapLabelPriority(a.label)-mapLabelPriority(b.label)||a.label.rank-b.label.rank);
    this.labelDiagnosticTotal=candidates.length;let count=0;const budget=mapLabelBudget(this.size.width,this.size.height);
    for(const {id,coordinate,label,color} of candidates){
      const diagnostic:CustomMapLabelDiagnostic={id,label:label.text,coordinate,visible:false,reason:'budget'};
      if(this.labelDiagnostics.length<MAX_RECORDED_MAP_LABELS)this.labelDiagnostics.push(diagnostic);
      const sourceAnchor=`${label.kind}:${label.symbol||''}:${label.text}:${coordinate[0].toFixed(6)},${coordinate[1].toFixed(6)}`;
      if(count>=budget)continue;
      if(seen.has(sourceAnchor)){diagnostic.reason='duplicate';continue;}
      if(!inRussiaCoverage(coordinate[0],coordinate[1],this.coverage.area)){diagnostic.reason='outside-coverage';continue;}
      const p=this.project(coordinate),style=mapLabelStyle(label,this.camera.zoom,color);
      if(p.x<24||p.x>this.size.width-24||p.y<32||p.y>this.size.height-20){diagnostic.reason='outside-viewport';continue;}
      const value=label.kind==='peak'&&label.elevation!==undefined?`${label.text?label.text+' · ':''}${Math.round(label.elevation)} м`:label.text;
      ctx.font=`${style.weight} ${style.fontSize}px Manrope, sans-serif`;
      const width=ctx.measureText(value).width,layout=mapLabelLayout(label,p,width,!!value,style),{rect}=layout;
      diagnostic.x=p.x;diagnostic.y=p.y;diagnostic.width=width;diagnostic.rect=rect;
      if(rect.left<12||rect.right>this.size.width-12||rect.top<12||rect.bottom>this.size.height-12){diagnostic.reason='outside-viewport';continue;}
      const repeatDistance=mapLabelRepeatDistance(label),repeatKey=mapLabelRepeatKey(label);
      if(value&&repeatDistance&&(repeated.get(repeatKey)||[]).some(previous=>Math.hypot(p.x-previous.x,p.y-previous.y)<repeatDistance)){diagnostic.reason='repeated-name';continue;}
      if(occupied.some(r=>rect.left<r.right&&rect.right>r.left&&rect.top<r.bottom&&rect.bottom>r.top)){diagnostic.reason='collision';continue;}
      occupied.push(rect);seen.add(sourceAnchor);
      if(value&&repeatDistance){const points=repeated.get(repeatKey)||[];points.push(p);repeated.set(repeatKey,points);}
      if(label.symbol)drawMapSymbol(ctx,label.symbol,p.x,p.y);
      drawMapLabel(ctx,value,p,layout,style);
      count++;diagnostic.visible=true;diagnostic.reason='drawn';
    }
    this.labelCanvas.hidden=count===0;
  }
  destroy(){
    if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.frame);this.stopAnimation();clearTimeout(this.settleTimer);
    this.resize.disconnect();this.pointer.cancel();this.listeners.forEach(([target,name,fn,options])=>target.removeEventListener(name,fn,options));this.listeners=[];
    this.unbindCoverage?.();this.coverage?.dispose();this.tiles.destroy();this.canvas.remove();this.labelCanvas.remove();this.markerLayer.remove();this.markers.clear();this.routeEdges=[];
    this.coveragePaths=new WeakMap();this.area=undefined;this.mask=undefined;this.boundaries=undefined;this.selectedArea=undefined;this.selectedBoundary=undefined;
    this.labelDiagnostics=[];this.labelDiagnosticTotal=0;
  }
}
export {COUNTRY_BOUNDS,geometryPath,tileRequests};
