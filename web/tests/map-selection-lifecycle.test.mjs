import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import {createTerrainModel,terrainRoute,drapeTerrainRoute} from '../public/terrain/terrain-renderer.js';
import {readRouteGeometry,routeGeometryPositions} from '../lib/route-geometry.ts';
import {cameraBounds} from '../lib/custom-map-camera.ts';
import {RUSSIA_BOUNDS,russiaCamera,russiaPadding} from '../public/maps/russia-viewport.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),compiled=new Map();
const turn=()=>new Promise(done=>setImmediate(done));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const line=(west=40.02,east=40.08)=>({type:'LineString',coordinates:[[west,43.05],[east,43.05]]});
const region={id:'region',name:'Район',center:[40.05,43.05],zoom:10,bounds:[40,43,40.1,43.1]};
const grid={schemaVersion:1,bounds:[40,43,40.1,43.1],width:9,height:9,elevations:Array.from({length:81},(_,i)=>100+i%9*3),minElevation:100,maxElevation:124};

// Run the real TSX lifecycle and event handlers. Only React's hook scheduler,
// browser elements, transport and renderer delivery are controlled; no source
// text matching or copy of the selection/notification logic is used.
function componentHost(file,name,dependencies={}){
  const hooks=[],refs=new WeakMap(),frames=new Map();let cursor=0,dirty=false,serial=0,tree,props,disposed=false;
  const layout=[],effects=[];
  const nodes=()=>{const out=[];const visit=node=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}out.push(node);visit(node.props?.children);};visit(tree);return out;};
  const element=()=>({dataset:{},clientWidth:800,clientHeight:600,
    getBoundingClientRect:()=>({left:0,top:0,right:800,bottom:600,width:800,height:600}),
    closest:()=>({querySelector:()=>null,querySelectorAll:()=>[]}),querySelectorAll:()=>[],
    querySelector:()=>host.visibleCanvas||host.canvas});
  const effect=(queue,callback,deps)=>{const index=cursor++,previous=hooks[index],changed=!previous||deps===undefined||deps.some((value,i)=>!Object.is(value,previous.deps?.[i]));
    if(changed){hooks[index]={deps,cleanup:previous?.cleanup};queue.push(()=>{hooks[index].cleanup?.();hooks[index].cleanup=callback();});}};
  const react={memo:value=>value,
    useRef:initial=>{const index=cursor++;return hooks[index]??= {current:initial};},
    useState:initial=>{const index=cursor++;if(!hooks[index])hooks[index]={value:typeof initial==='function'?initial():initial};return[hooks[index].value,value=>{if(disposed)return;const next=typeof value==='function'?value(hooks[index].value):value;if(!Object.is(next,hooks[index].value)){hooks[index].value=next;dirty=true;}}];},
    useEffect:(callback,deps)=>effect(effects,callback,deps),useLayoutEffect:(callback,deps)=>effect(layout,callback,deps)};
  const jsx=(type,props,key)=>({type,props:props||{},key});
  const noop=()=>{};
  const environment=vm.createContext({console,AbortController,URL,navigator:{onLine:true},window:{addEventListener:noop,removeEventListener:noop},
    ResizeObserver:class{observe(){}disconnect(){}},
    requestAnimationFrame:callback=>{const id=++serial;frames.set(id,callback);return id;},cancelAnimationFrame:id=>frames.delete(id)});
  if(!compiled.has(file))compiled.set(file,ts.transpileModule(readFileSync(resolve(root,file),'utf8'),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText);
  const testModule={exports:{}},require=id=>{if(id==='react')return react;if(id==='react/jsx-runtime')return{jsx,jsxs:jsx};assert.ok(Object.hasOwn(dependencies,id),`Uncontrolled dependency ${id}`);return dependencies[id];};
  vm.runInContext(`(function(require,module,exports){${compiled.get(file)}\n})`,environment)(require,testModule,testModule.exports);
  const host={canvas:null,visibleCanvas:null,
    render(next=props){if(disposed)return tree;props=next;let count=0;do{assert.ok(count++<30,'Component left a synchronous render loop');dirty=false;cursor=0;tree=testModule.exports[name](props);
      for(const node of nodes())if(typeof node.type==='string'&&node.props.ref){const ref=node.props.ref,old=refs.get(ref);let record=old;if(!old||old.key!==node.key){record={key:node.key,element:element()};refs.set(ref,record);}ref.current=record.element;if(node.type==='canvas')host.canvas=record.element;}
      while(layout.length)layout.shift()();while(effects.length)effects.shift()();
    }while(dirty);return tree;},
    async settle(){await turn();this.render();},
    nodes,find:predicate=>nodes().find(predicate),text:()=>{const visit=node=>typeof node==='string'?node:typeof node==='number'?String(node):Array.isArray(node)?node.map(visit).join(' '):node&&typeof node==='object'?visit(node.props?.children):'';return visit(tree);},
    click(label){const button=this.find(node=>node.type==='button'&&node.props['aria-label']===label);assert.ok(button,`Missing button ${label}`);button.props.onClick();this.render();},
    unmount(){disposed=true;for(const hook of hooks)hook?.cleanup?.();frames.clear();}};
  return host;
}

function atlasFixture(){
  const requests=new Map(),maps=[],notes=[],chosen=[];const scene=function Scene(){};
  class AtlasEngine{
    constructor(_element,options){this.options=options;this.route=undefined;this.routeId=undefined;this.fits=[];this.cameras=[];this.visibleBounds=grid.bounds;maps.push(this);queueMicrotask(()=>options.onReady());}
    getState(){return{ready:true,mode:'detail',committedMode:'detail',error:'',loading:false};}
    getCoverage(){return{area:{},territories:{features:[]}};}
    setRoute(geometry,id){this.route=geometry;this.routeId=id;}
    setFloor(){}setPadding(){}setRegion(){}setActive(){}setMarkers(){}setPitch(){}setObstacles(){}setCamera(camera){this.cameras.push(camera);}destroy(){this.destroyed=true;}
    fit(bounds){this.fits.push(bounds);}getVisibleBounds(){return this.visibleBounds;}getCamera(){return{center:region.center,zoom:10};}getSize(){return{width:800,height:600};}
  }
  const host=componentHost('components/CustomAtlas.tsx','CustomAtlas',{
    './TropnikIcons':{Check:'check'},'./MapIcon':{MapIcon:'icon'},'./MapAttribution':{MapAttribution:'credit'},'./MapRouteContext':{MapRouteContext:'context'},'./MapLandscapeScene':{MapLandscapeScene:scene},
    '@/lib/custom-map-engine':{CustomMapEngine:AtlasEngine},'@/lib/custom-map-camera':{hitGeometry:()=>true,mercatorProject:()=>({x:.6,y:.4}),mercatorUnproject:()=>region.center},
    '@/lib/content':{regions:[],routeCountLabel:()=>''},'@/lib/map-catalog':{mapDirectionCounts:()=>new globalThis.Map()},'@/lib/territories':{territoryForMapPoint:()=>undefined},
    '@/lib/russia-map':{russiaView:()=>({camera:{center:region.center,zoom:1},padding:{}})},
    '@/lib/map-preload':{loadPublicJSON:url=>{const request=deferred();requests.set(url,request);return request.promise;}},
    '@/lib/map-trail-points':{mapTrailPointEntries:()=>[]},'@/lib/route-geometry':{readRouteGeometry,routeGeometryPositions},
    '@/public/maps/russia-viewport.js':{coveredRussiaBounds:positions=>positions.length?grid.bounds:null,inRussiaCoverage:()=>true,RUSSIA_BOUNDS},
    '@/lib/map-framing':{MapFrameRefit:class{select(){}cancel(){}dispose(){}resized(){}},bindMapFrameRefit:()=>()=>{}},
    '@/lib/map-direction-layout':{bindMapLabelReflow:()=>()=>{},constrainDirectionLabels(){},MAP_LABEL_OBSTACLE_SELECTORS:[]},
    '@/lib/map-config':{MAP_CONFIG:{trailHitRadiusPx:12,routeMaxZoom:14,territoryMaxZoom:14},viewportRegionId:()=>region.id},
    '@/lib/map-route-presentation':{OVERVIEW_MESSAGE:'',overviewContextCaption:()=>'',ROUTE_PRESENTATION:{closeZoom:12}},'@/lib/map-types':{EMPTY_MAP_TRAILS:[]},
  });
  const select=trail=>host.render({region,trail,onRegion(){},onTrail:value=>chosen.push(value),onMapNote:value=>notes.push(value)});
  return{host,requests,maps,notes,chosen,select,scene:()=>host.find(node=>node.type===scene)?.props};
}

test('selecting a loading or failed route clears the previous line and cannot lend it to 3D',async t=>{
  const env=atlasFixture();t.after(()=>env.host.unmount());
  const a={id:'a',title:'Первый',geometry:line()},b={id:'b',title:'Второй',geometryUrl:'/b.geojson'};
  env.select(a);await env.host.settle();await env.host.settle();assert.equal(env.maps[0].route,a.geometry);
  env.select(b);assert.equal(env.maps[0].route,undefined);assert.equal(env.maps[0].routeId,undefined);
  env.host.click('Рельеф всей карты');assert.equal(env.scene().title,b.title);assert.equal(env.scene().geometry,undefined);assert.equal(env.scene().routeStatus,'loading');
  env.requests.get('/b.geojson').reject(new Error('Unavailable'));await env.host.settle();
  assert.equal(env.maps[0].route,undefined);assert.equal(env.scene().geometry,undefined);assert.equal(env.scene().routeStatus,'unavailable');
  env.maps[0].options.onClick({x:100,y:100},[40.05,43.05]);assert.deepEqual(env.chosen,[],'The old line is no longer a selectable hit target');
});

test('late responses, including a changed source for the same id, cannot take ownership from the current card',async t=>{
  const env=atlasFixture();t.after(()=>env.host.unmount());
  const old={id:'same',title:'Старая ревизия',geometryUrl:'/old.geojson'},current={id:'same',title:'Новая ревизия',geometryUrl:'/new.geojson'};
  env.select(old);await env.host.settle();env.select(current);env.host.click('Рельеф всей карты');
  const actual=line(40.03,40.07);env.requests.get('/new.geojson').resolve(actual);await env.host.settle();
  assert.equal(env.maps[0].route,actual);assert.equal(env.scene().geometry,actual);assert.equal(env.scene().routeStatus,'ready');
  env.requests.get('/old.geojson').resolve(line());await env.host.settle();
  assert.equal(env.maps[0].route,actual);assert.equal(env.scene().geometry,actual);assert.equal(env.scene().title,current.title);
  env.maps[0].options.onClick({x:100,y:100},[40.05,43.05]);assert.equal(env.chosen.at(-1),current);
  const count=env.notes.length;env.select({id:'none',title:'Без линии'});assert.equal(env.maps[0].route,undefined);assert.equal(env.scene(),undefined);assert.equal(env.notes.length,count);
});

test('an unmounted selection cannot apply a late geometry or notification',async()=>{
  const env=atlasFixture();env.select({id:'late',title:'Поздний',geometryUrl:'/late.geojson'});await env.host.settle();
  env.host.unmount();env.requests.get('/late.geojson').resolve(line());await turn();assert.equal(env.maps[0].route,undefined);assert.deepEqual(env.notes,[]);
});

test('portrait and wide country views open only their real visible display extent in 3D without moving the map',async t=>{
  const env=atlasFixture();t.after(()=>env.host.unmount());env.select();await env.host.settle();
  const map=env.maps[0],moves=map.cameras.length,fits=map.fits.length;
  for(const [width,height,covered] of [[390,844,350],[393,851,0],[360,800,300],[1600,500,0]]){
    const padding=russiaPadding(width,height,covered),camera=russiaCamera(width,height,padding,256);
    const visible=cameraBounds(camera,{width,height},padding);map.visibleBounds=visible;
    if(width<400)assert.ok(visible[3]>85,'The real portrait viewport extends beyond valid DEM latitudes');
    env.host.click('Рельеф всей карты');const bounds=Array.from(env.scene().bounds);
    assert.deepEqual(bounds,[Math.max(visible[0],RUSSIA_BOUNDS[0][0]),Math.max(visible[1],RUSSIA_BOUNDS[0][1]),Math.min(visible[2],RUSSIA_BOUNDS[1][0]),Math.min(visible[3],RUSSIA_BOUNDS[1][1])]);
    assert.ok(bounds[1]>=-85&&bounds[3]<=85&&bounds[2]-bounds[0]<=360);
    const actualGrid={...grid,bounds};assert.doesNotThrow(()=>createTerrainModel(actualGrid),'The scene bounds are accepted by the production terrain model');
    env.host.click('Карта сверху');
  }
  map.visibleBounds=grid.bounds;env.host.click('Рельеф всей карты');assert.deepEqual(Array.from(env.scene().bounds),grid.bounds,'A local viewport is preserved exactly');env.host.click('Карта сверху');
  map.visibleBounds=[192,50,193,51];env.host.click('Рельеф всей карты');assert.equal(env.scene(),undefined);assert.match(env.notes.at(-1),/Выберите участок карты России/);
  assert.equal(map.cameras.length,moves);assert.equal(map.fits.length,fits);
});

function sceneFixture(initial){
  const renderers=[],loads=[],model=createTerrainModel(grid),source=deferred();let host;
  class Renderer{
    constructor(canvas,data,options){this.canvas=canvas;this.options=options;this.model=model;this.segments=[];this.yaw=.25;renderers.push(this);}
    setGeometry(geometry){const result=terrainRoute(this.model,geometry);this.segments=result.segments;this.canvas.dataset.routeSegments=String(result.segments.length);this.canvas.dataset.routeClipped=String(result.clipped);return{segments:result.segments.length,clipped:result.clipped};}
    setCartography(){}warmup(){}zoomBy(){}rotate(){}reset(){}destroy(){this.destroyed=true;}
    frame({routeFails=false,replacedCanvas=false}={}){if(replacedCanvas){this.canvas={dataset:{}};host.visibleCanvas=this.canvas;}
      const route=routeFails?[]:drapeTerrainRoute(this.model,this.segments,1);this.canvas.dataset.routeRenderSegments=String(route.length);
      if(routeFails)this.options.onError('Геометрия не помещается в предпросмотр. Откройте маршрут на основной карте.');
      this.options.onRender({renderer:'canvas2d',ms:1,triangles:128,meshStride:1,quality:'full',view:{yaw:this.yaw}});host.render();}
  }
  const loader={load:(bounds,options)=>{loads.push({bounds,options});return source.promise;},dispose(){this.disposed=true;}};
  host=componentHost('components/MapLandscapeScene.tsx','MapLandscapeScene',{
    './MapIcon':{MapIcon:'icon'},'./MapAttribution':{MapAttribution:'credit'},'@/lib/custom-map-landscape':{createCustomLandscapeLoader:()=>loader},
    '@/lib/custom-map-surface':{createLandscapeSurface:async()=>({width:1,height:1,source:{loadedTiles:0}})},'@/lib/terrain-viewport':{observeTerrainViewport:()=>()=>{}},
  });
  let props={bounds:grid.bounds,title:'Ландшафт',onClose(){},...initial};host.render(props);
  return{host,loads,renderers,loader,source,
    update(change){props={...props,...change};host.render(props);},
    async ready(){source.resolve({prepared:[{TerrainRenderer:Renderer},grid,model],provenance:{}});await host.settle();return renderers.at(-1);},
    inspection:()=>JSON.parse(host.find(node=>node.type==='section').props.ref.current.dataset.terrainInspection),
  };
}

test('a late route updates the existing 3D scene and clearing it removes its painted line',async t=>{
  const env=sceneFixture({routeStatus:'loading'});t.after(()=>env.host.unmount());const renderer=await env.ready();renderer.frame();
  assert.match(env.host.text(),/Линия маршрута загружается/);renderer.yaw=1.4;
  env.update({geometry:line(),routeStatus:'ready'});renderer.frame();assert.equal(env.loads.length,1);assert.equal(env.renderers.length,1);assert.equal(renderer.yaw,1.4);
  assert.equal(env.inspection().route.state,'ready');assert.ok(env.inspection().route.renderedSegments>0);assert.doesNotMatch(env.host.text(),/Линия маршрута загружается/);
  env.update({geometry:undefined,routeStatus:'unavailable'});renderer.frame();assert.equal(renderer.segments.length,0);assert.equal(env.inspection().route.renderedSegments,0);assert.match(env.host.text(),/Линия этого маршрута недоступна/);
});

test('partial and failed route rendering stay disclosed after successful terrain frames and canvas recovery',async t=>{
  const env=sceneFixture({geometry:line(39.98,40.12),routeStatus:'ready'});t.after(()=>env.host.unmount());const renderer=await env.ready();renderer.frame();
  assert.equal(env.inspection().route.state,'partial');assert.match(env.host.text(),/Показана только часть маршрута/);
  renderer.options.onError('Восстанавливаем графический контекст');env.host.render();assert.match(env.host.text(),/Восстанавливаем графический контекст/);
  renderer.frame({replacedCanvas:true});assert.match(env.host.text(),/Показана только часть маршрута/);assert.doesNotMatch(env.host.text(),/Восстанавливаем графический контекст/);
  env.update({geometry:line()});renderer.frame({routeFails:true});assert.equal(env.inspection().state,'ready');assert.equal(env.inspection().route.state,'render-failed');assert.match(env.host.text(),/Не удалось отрисовать линию маршрута/);
  renderer.frame({routeFails:true});assert.match(env.host.text(),/Не удалось отрисовать линию маршрута/);
  env.update({geometry:line(41,41.1)});renderer.frame();assert.equal(env.inspection().route.state,'unavailable');assert.match(env.host.text(),/не отображается в пределах этого участка/);
});

test('late terrain preparation after close cannot resurrect a scene',async()=>{
  const env=sceneFixture({geometry:line()});env.host.unmount();assert.equal(env.loads[0].options.signal.aborted,true);assert.equal(env.loader.disposed,true);await env.ready();assert.equal(env.renderers.length,0);
});
