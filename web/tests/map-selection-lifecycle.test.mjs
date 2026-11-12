import test from 'node:test';
import {reliefContourIntervals} from '../lib/custom-map-relief.ts';
import {mapDistanceScale} from '../lib/custom-map-scale.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import {createTerrainModel,terrainRoute,drapeTerrainRoute} from '../public/terrain/terrain-renderer.js';
import {readRouteGeometry,routeGeometryPositions} from '../lib/route-geometry.ts';
import {cameraBounds} from '../lib/custom-map-camera.ts';
import {openingTerrainView,planTerrainNavigation} from '../lib/terrain-navigation.ts';
import {russiaCamera,russiaPadding} from '../public/maps/russia-viewport.js';

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
  const element=()=>({dataset:{},style:{},clientWidth:800,clientHeight:600,
    getBoundingClientRect:()=>({left:0,top:0,right:800,bottom:600,width:800,height:600}),
    closest:()=>({querySelector:()=>null,querySelectorAll:()=>[]}),querySelectorAll:()=>[],
    querySelector:()=>host.visibleCanvas||host.canvas});
  const effect=(queue,callback,deps)=>{const index=cursor++,previous=hooks[index],changed=!previous||deps===undefined||deps.some((value,i)=>!Object.is(value,previous.deps?.[i]));
    if(changed){hooks[index]={deps,cleanup:previous?.cleanup};queue.push(()=>{hooks[index].cleanup?.();hooks[index].cleanup=callback();});}};
  const react={memo:value=>value,
    useCallback:(callback,deps)=>{const index=cursor++,previous=hooks[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps?.[i])))hooks[index]={value:callback,deps};return hooks[index].value;},
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
  const host={canvas:null,visibleCanvas:null,environment,
    render(next=props){if(disposed)return tree;props=next;let count=0;do{assert.ok(count++<30,'Component left a synchronous render loop');dirty=false;cursor=0;tree=testModule.exports[name](props);
      for(const node of nodes())if(typeof node.type==='string'&&node.props.ref){const ref=node.props.ref,old=refs.get(ref);let record=old;if(!old||old.key!==node.key){record={key:node.key,element:element()};refs.set(ref,record);}if(typeof ref==='function')ref(record.element);else ref.current=record.element;if(node.type==='canvas')host.canvas=record.element;}
      while(layout.length)layout.shift()();while(effects.length)effects.shift()();
    }while(dirty);return tree;},
    async settle(){await turn();this.render();},
    nodes,find:predicate=>nodes().find(predicate),text:()=>{const visit=node=>typeof node==='string'?node:typeof node==='number'?String(node):Array.isArray(node)?node.map(visit).join(' '):node&&typeof node==='object'?visit(node.props?.children):'';return visit(tree);},
    click(label){const button=this.find(node=>node.type==='button'&&node.props['aria-label']===label);assert.ok(button,`Missing button ${label}`);button.props.onClick();this.render();},
    unmount(){disposed=true;for(const hook of hooks)hook?.cleanup?.();frames.clear();}};
  return host;
}

function atlasFixture({committedMode='detail',ready=true}={}){
  const requests=new Map(),maps=[],notes=[],chosen=[];
  class AtlasEngine{
    constructor(_element,options){this.options=options;this.route=undefined;this.routeId=undefined;this.fits=[];this.cameras=[];this.camera=options.camera;this.visibleBounds=grid.bounds;this.active=true;this.activations=[];this.modes=[];this.pitchChanges=[];this.layers={paths:true,boundaries:true,relief:true};this.layerChanges=[];this.routeChanges=[];this.state={ready,mode:'detail',committedMode,error:ready?'':'Границы карты не загрузились.',loading:false,reliefReady:ready,imageryLoading:false};maps.push(this);queueMicrotask(()=>ready?options.onReady():options.onState(this.getState()));}
    getState(){return{...this.state};}
    getCoverage(){return{area:{},territories:{features:[]}};}
    setRoute(geometry,id){this.route=geometry;this.routeId=id;this.routeChanges.push({geometry,id});}
    setMode(mode){this.modes.push(mode);this.state={...this.state,mode,committedMode:mode,imagerySource:mode==='satellite'?'eox-s2':undefined};this.options.onState(this.getState());}
    setLayers(value){this.layerChanges.push(value);Object.assign(this.layers,value);}
    retry(){this.retries=(this.retries||0)+1;this.state.loading=true;this.options.onState(this.getState());}
    setPosition(value){this.position=value;}
    setFloor(){}setPadding(){}setRegion(){}setActive(value){this.active=value;this.activations.push(value);}setMarkers(){}setPitch(value){this.pitchChanges.push(value);}setObstacles(){}setCamera(camera){this.camera=camera;this.cameras.push(camera);}destroy(){this.destroyed=true;}
    fit(bounds){this.fits.push(bounds);}getVisibleBounds(){return this.visibleBounds;}getCamera(){return this.camera;}getSize(){return{width:800,height:600};}
  }
  const host=componentHost('components/CustomAtlas.tsx','CustomAtlas',{
    './MapIcon':{MapIcon:'icon'},'./MapAttribution':{MapAttribution:'credit'},'./MapRouteContext':{MapRouteContext:'context'},
    '@/lib/custom-map-engine':{CustomMapEngine:AtlasEngine},'@/lib/custom-map-camera':{hitGeometry:()=>true,mercatorProject:()=>({x:.6,y:.4}),mercatorUnproject:()=>region.center},
    '@/lib/content':{regions:[],routeCountLabel:()=>''},'@/lib/map-catalog':{mapDirectionCounts:()=>new globalThis.Map()},'@/lib/territories':{territoryForMapPoint:()=>undefined},
    '@/lib/russia-map':{russiaView:()=>({camera:{center:region.center,zoom:1},padding:{}})},
    '@/lib/map-preload':{loadPublicJSON:url=>{const request=deferred();requests.set(url,request);return request.promise;}},
    '@/lib/map-trail-points':{mapTrailPointEntries:()=>[]},'@/lib/route-geometry':{readRouteGeometry,routeGeometryPositions},
    '@/public/maps/russia-viewport.js':{coveredRussiaBounds:positions=>positions.length?grid.bounds:null,inRussiaCoverage:()=>true},
    '@/lib/map-framing':{MapFrameRefit:class{select(){}cancel(){}dispose(){}resized(){}},bindMapFrameRefit:()=>()=>{}},
    '@/lib/map-direction-layout':{bindMapLabelReflow:()=>()=>{},constrainDirectionLabels(){},mapLabelObstacleRects:()=>[]},
    '@/lib/map-config':{MAP_CONFIG:{trailHitRadiusPx:12,routeMaxZoom:14,territoryMaxZoom:14},viewportRegionId:()=>region.id},
    '@/lib/map-route-presentation':{overviewContextCaption:()=>'',ROUTE_PRESENTATION:{closeZoom:12}},'@/lib/map-types':{EMPTY_MAP_TRAILS:[]},
    '@/lib/custom-map-scale':{mapDistanceScale},
    '@/lib/custom-map-relief':{reliefContourIntervals},
  });
  const select=(trail,visibleTrails=[])=>host.render({region,trail,visibleTrails,onRegion(){},onTrail:value=>chosen.push(value),onMapNote:value=>notes.push(value)});
  return{host,requests,maps,notes,chosen,select};
}

test('selecting a loading or failed route clears the previous line across Relief and Satellite changes',async t=>{
  const env=atlasFixture();t.after(()=>env.host.unmount());
  const a={id:'a',title:'Первый',geometry:line()},b={id:'b',title:'Второй',geometryUrl:'/b.geojson'};
  env.select(a);await env.host.settle();await env.host.settle();assert.equal(env.maps[0].route,a.geometry);
  env.select(b);assert.equal(env.maps[0].route,undefined);assert.equal(env.maps[0].routeId,undefined);
  env.host.click('Спутник');assert.equal(env.maps[0].route,undefined);assert.equal(env.maps[0].state.mode,'satellite');
  env.requests.get('/b.geojson').reject(new Error('Unavailable'));await env.host.settle();
  env.host.click('Рельеф');assert.equal(env.maps[0].route,undefined);assert.equal(env.maps[0].routeId,undefined);assert.match(env.notes.at(-1),/Линия маршрута не загрузилась/);
  env.maps[0].options.onClick({x:100,y:100},[40.05,43.05]);assert.deepEqual(env.chosen,[],'The old line is no longer a selectable hit target');
});

test('late responses, including a changed source for the same id, cannot take ownership from the current card',async t=>{
  const env=atlasFixture();t.after(()=>env.host.unmount());
  const old={id:'same',title:'Старая ревизия',geometryUrl:'/old.geojson'},current={id:'same',title:'Новая ревизия',geometryUrl:'/new.geojson'};
  env.select(old);await env.host.settle();env.select(current);env.host.click('Спутник');
  const actual=line(40.03,40.07);env.requests.get('/new.geojson').resolve(actual);await env.host.settle();
  assert.equal(env.maps[0].route,actual);assert.equal(env.maps[0].routeId,current.id);env.host.click('Рельеф');
  env.requests.get('/old.geojson').resolve(line());await env.host.settle();
  assert.equal(env.maps[0].route,actual);assert.equal(env.host.find(node=>node.type==='context').props.title,current.title);
  env.maps[0].options.onClick({x:100,y:100},[40.05,43.05]);assert.equal(env.chosen.at(-1),current);
  const count=env.notes.length;env.select({id:'none',title:'Без линии'});assert.equal(env.maps[0].route,undefined);assert.equal(env.maps[0].routeId,undefined);assert.equal(env.notes.length,count);
});

test('an unmounted selection cannot apply a late geometry or notification',async()=>{
  const env=atlasFixture();env.select({id:'late',title:'Поздний',geometryUrl:'/late.geojson'});await env.host.settle();
  env.host.unmount();env.requests.get('/late.geojson').resolve(line());await turn();assert.equal(env.maps[0].route,undefined);assert.deepEqual(env.notes,[]);
});

test('a failed map startup exposes retry without a dismiss path back to an endless skeleton',async t=>{
  const env=atlasFixture({ready:false});t.after(()=>env.host.unmount());env.select();await env.host.settle();
  const map=env.maps[0];assert.match(env.host.text(),/Границы карты не загрузились/);
  assert.equal(env.host.find(node=>node.props.className==='map-skeleton'),undefined);
  assert.equal(env.host.nodes().some(node=>node.type==='button'&&['Закрыть','Понятно'].includes(node.props.children)),false);
  env.host.click('Повторить загрузку карты');assert.equal(map.retries,1);
  assert.equal(env.host.find(node=>node.props['aria-label']==='Повторить загрузку карты').props.disabled,true);
  assert.match(env.host.text(),/Загружаем…/);
  map.state={...map.state,ready:true,loading:false,error:''};map.options.onState(map.getState());env.host.render();
  assert.equal(env.host.find(node=>node.props['aria-label']==='Повторить загрузку карты'),undefined);
  assert.equal(env.host.find(node=>node.props['aria-label']==='Рельеф').props.disabled,false);
  assert.equal(env.maps.length,1,'Recovery reuses the map and its controls');
});

test('tile retry preserves a selected route and camera and remains reachable in the planner',async t=>{
  const env=atlasFixture();t.after(()=>env.host.unmount());
  const trail={id:'retry-route',title:'Тропа',geometry:line()};env.select(trail);await env.host.settle();await env.host.settle();
  const map=env.maps[0],camera=map.camera,geometry=map.route,moves=map.cameras.length,fits=map.fits.length;
  map.state={...map.state,error:'Не все спутниковые снимки загрузились.'};map.options.onState(map.getState());env.host.render();
  env.host.click('Повторить загрузку карты');assert.equal(map.retries,1);assert.equal(map.camera,camera);assert.equal(map.route,geometry);
  assert.equal(map.cameras.length,moves);assert.equal(map.fits.length,fits);
  map.state={...map.state,loading:false};map.options.onState(map.getState());
  env.host.render({planning:true,region,trail,onRegion(){}});
  assert.ok(env.host.find(node=>node.props['aria-label']==='Повторить загрузку карты'),'Planner failures offer the same recovery action');
});

test('satellite mode styling spans pending and retained imagery while source attribution follows committed ground',async t=>{
  const env=atlasFixture();t.after(()=>env.host.unmount());env.select();await env.host.settle();const map=env.maps[0];
  const apply=value=>{map.state={...map.state,...value};map.options.onState(map.getState());env.host.render();};
  const credit=()=>env.host.find(node=>node.type==='credit').props;
  const atlas=()=>env.host.find(node=>node.props['data-map-renderer']==='tropnik').props;
  apply({mode:'satellite',committedMode:'detail',loading:true,imageryLoading:true,imageryTarget:'eox-bluemarble'});
  assert.equal(credit().satellite,false,'An imagery request does not replace the visible relief attribution');
  assert.equal(atlas()['data-map-base-state'],'loading');assert.equal(atlas()['data-map-base-committed'],'detail');
  assert.equal(atlas()['data-map-base-target'],'satellite');assert.equal(atlas()['data-map-imagery'],'satellite','The selected mode marker must already exist while real imagery is pending');
  assert.equal(atlas()['data-map-imagery-target'],'eox-bluemarble');assert.equal(atlas()['data-map-imagery-state'],'loading');
  assert.equal(atlas()['data-map-imagery-source'],undefined,'A pending target must not claim a committed imagery source');
  apply({committedMode:'satellite',loading:false,imageryLoading:false,imagerySource:'eox-bluemarble',reliefReady:false});
  assert.equal(credit().satellite,true);assert.equal(credit().satelliteSource,'eox-bluemarble');
  apply({mode:'detail',loading:true,imageryTarget:undefined});
  assert.equal(atlas()['data-map-base-target'],'detail');assert.equal(atlas()['data-map-base-committed'],'satellite');
  assert.equal(atlas()['data-map-base-state'],'loading');assert.equal(atlas()['data-map-imagery-source'],'eox-bluemarble');
  assert.equal(atlas()['data-map-imagery'],'satellite','Satellite styling stays until retained imagery is replaced');
  assert.equal(atlas()['data-map-imagery-target'],undefined);assert.equal(atlas()['data-map-imagery-state'],'ready');
  assert.equal(credit().satellite,true);assert.equal(credit().satelliteLoading,false,'Returning to relief is not a new imagery request');
  apply({loading:false,error:'Подробности этого участка не загрузились.'});
  assert.equal(credit().satellite,true,'A failed return keeps the notice for the image still on screen');
  assert.equal(atlas()['data-map-imagery'],'satellite');assert.equal(atlas()['data-map-imagery-source'],'eox-bluemarble');
  apply({committedMode:'detail',imagerySource:undefined,reliefReady:true,error:''});
  assert.equal(credit().satellite,false);assert.equal(credit().terrain,true);assert.equal(atlas()['data-map-imagery'],undefined);
});

test('manual navigation cancels the locating status and ignores both late geolocation callbacks',async t=>{
  for(const action of ['gesture','fit','selection']){
    const env=atlasFixture();t.after(()=>env.host.unmount());env.select();await env.host.settle();
    const requests=[];env.host.environment.navigator.geolocation={getCurrentPosition:(success,failure)=>requests.push({success,failure})};
    env.host.click('Моё местоположение');assert.match(env.host.text(),/Определяем местоположение/);
    const map=env.maps[0];
    if(action==='gesture'){map.options.onGesture();env.host.render();}
    else if(action==='fit')env.host.click('Показать Россию целиком');
    else env.select({id:'new',title:'Другая тропа'});
    assert.doesNotMatch(env.host.text(),/Определяем местоположение/);assert.equal(env.notes.at(-1),'');
    const moves=map.cameras.length,notes=env.notes.length;
    requests[0].success({coords:{longitude:40.05,latitude:43.05,accuracy:12}});requests[0].failure();env.host.render();
    assert.equal(map.cameras.length,moves);assert.equal(map.position,undefined);assert.equal(env.notes.length,notes);
    env.host.click('Моё местоположение');requests[1].success({coords:{longitude:40.05,latitude:43.05,accuracy:12}});env.host.render();
    assert.deepEqual(Array.from(map.position),[40.05,43.05]);assert.match(env.host.text(),/Точность около 12 м/);
  }
});

test('the distance ruler updates from the settled camera without adding DOM work to movement frames',async t=>{
 const env=atlasFixture();t.after(()=>env.host.unmount());env.select();await env.host.settle();
 const map=env.maps[0],line=env.host.find(node=>node.props.className==='map-scale-line').props.ref.current;
 const value=env.host.find(node=>node.props.className==='map-scale').props.children[0].props.ref.current;
 const changes=[];let width;
 Object.defineProperty(line.style,'width',{get:()=>width,set:next=>{width=next;changes.push(next);}});
 const settled={center:[142.7878226365234,46.94792542123872],zoom:14};
 map.options.onSettled(settled);assert.equal(value.textContent,'500 м');
 assert.equal(width,`${mapDistanceScale(settled.center[1],settled.zoom).pixels.toFixed(2)}px`);
 for(let frame=0;frame<60;frame++)map.options.onFrame?.({...settled,center:[settled.center[0],settled.center[1]+frame/100]});
 assert.equal(changes.length,1,'Movement frames keep the settled ruler without layout writes');
 const next={...settled,zoom:13};map.options.onSettled(next);assert.equal(value.textContent,'1 км');
 assert.equal(width,`${mapDistanceScale(next.center[1],next.zoom).pixels.toFixed(2)}px`);
 const before=changes.length;env.host.unmount();map.options.onSettled({...next,zoom:12});
 assert.equal(changes.length,before,'An unmounted map cannot write into a detached ruler');
});

test('the contour legend follows the committed ceil zoom and disappears while replacement tiles are loading',async t=>{
 const env=atlasFixture();t.after(()=>env.host.unmount());env.select();await env.host.settle();
 const map=env.maps[0];
 for(const [zoom,interval] of [[9.2,100],[11.2,50],[13.2,25]]){
  map.options.onSettled({...map.camera,zoom});env.host.render();assert.match(env.host.text(),new RegExp(`Горизонтали ·\\s*${interval}\\s*м`));
 }
 map.options.onState({...map.state,loading:true});env.host.render();assert.doesNotMatch(env.host.text(),/Горизонтали/);
 map.options.onState({...map.state,loading:false});env.host.render();assert.match(env.host.text(),/Горизонтали/);
 env.host.click('Спутник');assert.doesNotMatch(env.host.text(),/Горизонтали/);
});

test('the main map offers only Relief and Satellite and keeps one active canvas throughout switching',async t=>{
  const env=atlasFixture({committedMode:'overview'});t.after(()=>env.host.unmount());env.select();await env.host.settle();
  const map=env.maps[0],surface=env.host.find(node=>node.props['aria-label']==='Интерактивная карта России').props.ref.current;
  const modes=()=>env.host.find(node=>node.props.className==='map-style-switch').props.children;
  assert.deepEqual(Array.from(modes(),node=>node.props['aria-label']),['Рельеф','Спутник']);
  assert.equal(modes()[0].props['aria-pressed'],true,'The country overview belongs to the Relief mode');
  assert.equal(modes()[1].props['aria-pressed'],false);
  for(const label of ['Спутник','Рельеф','Спутник','Рельеф']){
    env.host.click(label);
    assert.equal(env.host.find(node=>node.props['aria-label']==='Интерактивная карта России').props.ref.current,surface);
    assert.equal(modes().find(node=>node.props['aria-label']===label).props['aria-pressed'],true);
    assert.equal(map.active,true);assert.equal(map.destroyed,undefined);assert.equal(env.maps.length,1);
    assert.equal(env.host.find(node=>node.props.className?.includes('terrain-scene')),undefined);
  }
  assert.deepEqual(map.modes,['satellite','detail','satellite','detail']);assert.deepEqual(map.activations,[]);
  assert.ok(map.pitchChanges.every(pitch=>pitch===0));
});

test('portrait and wide country cameras retain their complete view when changing between Relief and Satellite',async t=>{
  const env=atlasFixture();t.after(()=>env.host.unmount());env.select();await env.host.settle();
  const map=env.maps[0],fits=map.fits.length;
  for(const [width,height,covered] of [[390,844,350],[393,851,0],[360,800,300],[1600,500,0]]){
    const padding=russiaPadding(width,height,covered),camera=russiaCamera(width,height,padding,256);
    const visible=cameraBounds(camera,{width,height},padding);map.setCamera(camera);map.options.onGesture();
    const moves=map.cameras.length;
    for(const label of ['Спутник','Рельеф']){
      env.host.click(label);
      assert.equal(map.getCamera(),camera);assert.deepEqual(cameraBounds(map.getCamera(),{width,height},padding),visible);
      assert.equal(map.cameras.length,moves);assert.equal(map.fits.length,fits);
    }
  }
});

test('base changes keep a manually browsed camera and selected line even when route geometry arrives later',async t=>{
  const env=atlasFixture();t.after(()=>env.host.unmount());const selected={id:'kept',title:'Маршрут',geometryUrl:'/kept.geojson'};
  env.select(selected);await env.host.settle();const map=env.maps[0],camera={center:[40.25,43.05],zoom:13.25,bearingDegrees:-35};
  map.setCamera(camera);map.options.onGesture();const moves=map.cameras.length,fitCount=map.fits.length;
  env.host.click('Спутник');const geometry=line();env.requests.get('/kept.geojson').resolve(geometry);await env.host.settle();
  assert.equal(map.route,geometry);assert.equal(map.routeId,selected.id);assert.equal(map.getCamera(),camera);assert.equal(map.fits.length,fitCount);
  const routeChanges=map.routeChanges.length;env.host.click('Рельеф');env.host.click('Спутник');
  assert.equal(map.route,geometry);assert.equal(map.routeId,selected.id);assert.equal(map.routeChanges.length,routeChanges);
  assert.equal(map.getCamera(),camera);assert.equal(map.cameras.length,moves);assert.equal(map.fits.length,fitCount);
  assert.equal(env.maps.length,1);assert.equal(map.active,true);
});

test('Relief restores measured hillshade without resetting independent path and boundary overlays',async t=>{
  const env=atlasFixture();t.after(()=>env.host.unmount());env.select();await env.host.settle();
  const map=env.maps[0],camera=map.getCamera(),moves=map.cameras.length,fits=map.fits.length;
  env.host.find(node=>node.type==='button'&&node.props.className==='layer-button').props.onClick();env.host.render();
  const inputFor=label=>env.host.find(node=>node.type==='label'&&node.props.children?.includes(label)).props.children.find(node=>node?.type==='input');
  for(const label of ['Тропы и грунтовые дороги','Границы территорий','Рельеф и линии высот']){inputFor(label).props.onChange({target:{checked:false}});env.host.render();}
  assert.deepEqual(map.layers,{paths:false,boundaries:false,relief:false});
  env.host.click('Спутник');env.host.click('Рельеф');
  assert.deepEqual(map.layers,{paths:false,boundaries:false,relief:true});assert.equal(inputFor('Рельеф и линии высот').props.checked,true);
  assert.equal(map.state.mode,'detail');assert.equal(map.getCamera(),camera);assert.equal(map.cameras.length,moves);assert.equal(map.fits.length,fits);
  const menu=env.host.find(node=>node.props.className==='layer-menu');assert.equal(menu.props.children.some(node=>node?.type==='button'),false,'The layer menu does not introduce a third base mode');
});

test('a main-map route marker replaces the selected line while preserving the Satellite mode',async t=>{
  const env=atlasFixture();t.after(()=>env.host.unmount());
  const a={id:'a',title:'Первая тропа',center:[40.04,43.05],geometry:line()},b={id:'b',title:'Соседняя тропа',center:[40.06,43.05],geometryUrl:'/neighbour.geojson'},trails=[a,b];
  env.select(a,trails);await env.host.settle();await env.host.settle();env.host.click('Спутник');const map=env.maps[0];
  map.options.onMarker(b.id);assert.equal(env.chosen.at(-1),b);env.select(b,trails);assert.equal(map.route,undefined);assert.equal(map.routeId,undefined);
  const geometry=line(40.04,40.09);env.requests.get('/neighbour.geojson').resolve(geometry);await env.host.settle();
  assert.equal(map.route,geometry);assert.equal(map.routeId,b.id);assert.equal(map.state.mode,'satellite');assert.equal(map.active,true);assert.equal(env.maps.length,1);
});

function sceneFixture(initial,{holdMask=false,holdSurface=false,viewport={width:800,height:600,insets:{top:0,right:0,bottom:0,left:0}}}={}){
  const renderers=[],loads=[],maskLoads=[],surfaceLoads=[],source=deferred(),mask=deferred();let host;
  let currentViewport=viewport,viewportObserver;
  const displayMask={width:2,height:2,pixels:new Uint8Array(4).fill(255),source:{allowedPixels:4,bounds:[...grid.bounds]}};
  class Renderer{
    constructor(canvas,data,options){this.canvas=canvas;this.options=options;this.grid=data;this.model=options.preparedModel;this.segments=[];this.yaw=options.initialView?.yaw??.25;this.view={...openingTerrainView(data.bounds,{width:800,height:600}),...options.initialView};this.terrainChanges=[];this.cartographyChanges=[];renderers.push(this);}
    setGeometry(geometry){const result=terrainRoute(this.model,geometry);this.segments=result.segments;this.canvas.dataset.routeSegments=String(result.segments.length);this.canvas.dataset.routeClipped=String(result.clipped);return{segments:result.segments.length,clipped:result.clipped};}
    getView(){return{...this.view,yaw:this.yaw,zoom:1,bounds:[...this.grid.bounds]};}
    setView(view){this.view={...this.view,...view};this.yaw=view.yaw;}
    setViewportInsets(insets){this.viewportInsets=insets;}
    setTerrain(data,options){this.terrainChanges.push({data,options});this.grid=data;this.model=options.preparedModel;this.segments=[];this.cartography=null;}
    setCartography(value){this.cartography=value;this.cartographyChanges.push(value);}
    navigate(change){this.setView({...this.getView(),...change});this.options.onViewChange(this.getView());host.render();}
    project(){return null;}warmup(){this.warmups=(this.warmups||0)+1;}zoomBy(){}rotate(){}reset(){}destroy(){this.destroyed=true;}
    frame({routeFails=false,replacedCanvas=false}={}){if(replacedCanvas){this.canvas={dataset:{}};host.visibleCanvas=this.canvas;}
      const route=routeFails?[]:drapeTerrainRoute(this.model,this.segments,1);this.canvas.dataset.routeRenderSegments=String(route.length);
      if(routeFails)this.options.onError('Геометрия не помещается в предпросмотр. Откройте маршрут на основной карте.');
      this.options.onRender({renderer:'canvas2d',ms:1,triangles:128,meshStride:1,quality:'full',view:{yaw:this.yaw},geographicView:this.getView(),viewport:currentViewport});host.render();}
  }
  const loader={load:(bounds,options)=>{const job=loads.length?deferred():source;loads.push({bounds:[...bounds],options,...job});return job.promise;},dispose(){this.disposed=true;}};
  host=componentHost('components/MapLandscapeScene.tsx','MapLandscapeScene',{
    './MapIcon':{MapIcon:'icon'},'./MapAttribution':{MapAttribution:'credit'},'@/lib/custom-map-landscape':{createCustomLandscapeLoader:()=>loader},
    '@/lib/custom-map-surface':{createLandscapeSurface:(data,options)=>{const job=deferred();surfaceLoads.push({data,options,...job});if(!holdSurface)job.resolve({width:2,height:2,source:{complete:false,loadedTiles:0}});return job.promise;}},
    '@/lib/terrain-viewport':{readTerrainViewport:()=>currentViewport,observeTerrainViewport:(_element,target,onChange)=>{
      const observer={target,onChange};viewportObserver=observer;target.setViewportInsets(currentViewport.insets);onChange?.(currentViewport);
      return()=>{if(viewportObserver===observer)viewportObserver=null;};
    }},'@/lib/terrain-navigation':{openingTerrainView,planTerrainNavigation},
    '@/lib/custom-map-mask':{prepareLandscapeDisplayMask:(bounds,options)=>{const job=maskLoads.length?deferred():mask;maskLoads.push({bounds:[...bounds],options,...job});if(!holdMask)job.resolve(JSON.stringify(bounds)===JSON.stringify(grid.bounds)?displayMask:{...displayMask,source:{...displayMask.source,bounds:[...bounds]}});return job.promise;}},
  });
  let props={bounds:grid.bounds,title:'Ландшафт',onClose(){},...initial};host.render(props);
  const resolveWindow=async(index,data={...grid,bounds:loads[index].bounds})=>{const model=createTerrainModel(data);loads[index].resolve({prepared:[{TerrainRenderer:Renderer},data,model],provenance:{}});await host.settle();return renderers.at(-1);};
  return{host,loads,renderers,loader,source,mask,maskLoads,surfaceLoads,displayMask,resolveWindow,
    resize(next){currentViewport=next;viewportObserver?.target.setViewportInsets(next.insets);viewportObserver?.onChange?.(next);viewportObserver?.target.warmup();host.render();},
    update(change){props={...props,...change};host.render(props);},
    async ready(data=grid){return resolveWindow(0,data);},
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
  assert.equal(env.inspection().route.state,'partial');assert.match(env.host.text(),/Часть маршрута за пределами текущего участка/);
  renderer.options.onError('Восстанавливаем графический контекст');env.host.render();assert.match(env.host.text(),/Восстанавливаем графический контекст/);
  renderer.frame({replacedCanvas:true});assert.match(env.host.text(),/Часть маршрута за пределами текущего участка/);assert.doesNotMatch(env.host.text(),/Восстанавливаем графический контекст/);
  env.update({geometry:line()});renderer.frame({routeFails:true});assert.equal(env.inspection().state,'ready');assert.equal(env.inspection().route.state,'render-failed');assert.match(env.host.text(),/Не удалось отрисовать линию маршрута/);
  renderer.frame({routeFails:true});assert.match(env.host.text(),/Не удалось отрисовать линию маршрута/);
  env.update({geometry:line(41,41.1)});renderer.frame();assert.equal(env.inspection().route.state,'unavailable');assert.match(env.host.text(),/Маршрут за пределами текущего ракурса/);
});

test('a nonfatal route notice cannot be mistaken for a renderer error during cartography loading',async t=>{
  const env=sceneFixture({geometry:line(41,41.1),routeStatus:'ready'});t.after(()=>env.host.unmount());const renderer=await env.ready();renderer.frame();
  const notice=()=>env.host.find(node=>node.props?.className==='terrain-progress');
  assert.equal(notice().props['data-terrain-status'],'route-warning');assert.equal(env.inspection().state,'ready');
  renderer.options.onError('Восстанавливаем графический контекст');env.host.render();
  assert.equal(notice().props['data-terrain-status'],'renderer-error');assert.equal(env.inspection().state,'recovering');
  renderer.frame();assert.equal(notice().props['data-terrain-status'],'route-warning');assert.equal(env.inspection().state,'ready');
});

test('late terrain preparation after close cannot resurrect a scene',async()=>{
  const env=sceneFixture({geometry:line()});env.host.unmount();assert.equal(env.loads[0].options.signal.aborted,true);assert.equal(env.loader.disposed,true);await env.ready();assert.equal(env.renderers.length,0);
});

test('the real scene never creates an unmasked renderer while country coverage is pending or unavailable',async t=>{
  const env=sceneFixture({geometry:line()},{holdMask:true});t.after(()=>env.host.unmount());await env.ready();
  assert.equal(env.renderers.length,0);assert.equal(env.inspection().state,'loading');assert.equal(env.inspection().displayMask.state,'loading');
  env.mask.resolve(env.displayMask);await env.host.settle();assert.equal(env.renderers.length,1);assert.equal(env.renderers[0].options.displayMask,env.displayMask);
  assert.equal(env.inspection().state,'loading','mask readiness alone cannot claim a painted terrain frame');env.renderers[0].frame();assert.equal(env.inspection().state,'ready');assert.equal(env.inspection().displayMask.state,'ready');
  const unavailable=sceneFixture({},{holdMask:true});t.after(()=>unavailable.host.unmount());await unavailable.ready();unavailable.mask.reject(new Error('coverage unavailable'));await unavailable.host.settle();
  assert.equal(unavailable.renderers.length,0);assert.equal(unavailable.inspection().state,'failed');assert.equal(unavailable.inspection().displayMask.state,'failed');assert.match(unavailable.host.text(),/Не удалось подготовить границы/);assert.equal(unavailable.loads[0].options.signal.aborted,true);
});

test('closing a scene cancels mask preparation and a late mask cannot resurrect its renderer',async()=>{
  const env=sceneFixture({geometry:line()},{holdMask:true});await env.ready();env.host.unmount();assert.equal(env.maskLoads[0].options.signal.aborted,true);
  env.mask.resolve(env.displayMask);await env.host.settle();assert.equal(env.renderers.length,0);
});

const materialFor=(bounds,name='Measured material')=>({width:2,height:2,pixels:new Uint8ClampedArray([81,112,75,255,81,112,75,255,83,133,145,255,81,112,75,255]),
  source:{name,kind:'landcover',bounds:[...bounds],loadedTiles:1,requestedTiles:1,complete:true}});
const nearbyView={longitude:40.25,latitude:43.05,yaw:.6,pitch:.85,distanceM:1000};

test('the first source window covers the oblique frustum while retaining the chosen 2D context as camera target',async t=>{
  const env=sceneFixture({});t.after(()=>env.host.unmount());const opening=openingTerrainView(grid.bounds,{width:800,height:600});
  const planned=planTerrainNavigation(opening,grid.bounds,{width:800,height:600});assert.ok(planned,'This oblique initial camera needs real terrain beyond the original flat rectangle');
  assert.deepEqual(env.loads[0].bounds,planned.bounds);
  const renderer=await env.ready();assert.equal(renderer.options.initialView.longitude,opening.longitude);assert.equal(renderer.options.initialView.latitude,opening.latitude);
  assert.equal(renderer.options.initialView.distanceM,opening.distanceM);
});

test('an initial viewport change cancels obsolete coverage before any renderer can publish the first frame',async t=>{
  const viewport={width:390,height:844,insets:{top:192,right:64,bottom:64,left:16}};
  const env=sceneFixture({}, {viewport});t.after(()=>env.host.unmount());const initial=openingTerrainView(grid.bounds,viewport);
  const next={...viewport,insets:{top:192,right:16,bottom:400,left:16}};
  env.resize(next);assert.equal(env.loads.length,2);assert.equal(env.loads[0].options.signal.aborted,true);
  assert.deepEqual(env.loads[1].bounds,planTerrainNavigation(initial,grid.bounds,next).bounds);
  await env.resolveWindow(0);assert.equal(env.renderers.length,0,'an old source cannot appear while its replacement is loading');
  const renderer=await env.resolveWindow(1);renderer.frame();
  assert.equal(renderer.options.initialView.distanceM,initial.distanceM,'resizing during the initial load preserves the chosen physical camera');
  assert.deepEqual(renderer.options.viewportInsets,next.insets);
  assert.deepEqual(env.inspection().frame.viewport,next);
  assert.deepEqual(env.inspection().view,env.inspection().frame.geographicView);
});

test('sheet settling replans complete canvas coverage and preserves the rendered scene until the replacement is ready',async t=>{
  const viewport={width:390,height:844,insets:{top:192,right:64,bottom:64,left:16}},env=sceneFixture({}, {viewport});t.after(()=>env.host.unmount());
  const renderer=await env.resolveWindow(0);renderer.frame();const view=renderer.getView(),oldGrid=renderer.grid;
  const next={...viewport,insets:{top:192,right:16,bottom:400,left:16}};env.resize(next);
  assert.equal(env.loads.length,2);assert.equal(renderer.grid,oldGrid);assert.equal(renderer.terrainChanges.length,0);
  assert.deepEqual(env.loads[1].bounds,planTerrainNavigation(view,oldGrid.bounds,next,30).bounds);
  assert.equal(renderer.getView().distanceM,view.distanceM);assert.equal(env.inspection().loadingWindow,true);
  await env.resolveWindow(1);renderer.frame();
  assert.equal(env.renderers.length,1);assert.equal(renderer.terrainChanges.length,1);assert.equal(renderer.getView().distanceM,view.distanceM);
  assert.deepEqual(env.inspection().frame.viewport,next);assert.deepEqual(env.inspection().requestedViewport,next);assert.equal(env.inspection().loadingWindow,false);
});

test('a native regional DEM prepares its mask and material from its actual wider bounds',async t=>{
  const env=sceneFixture({geometry:line()});t.after(()=>env.host.unmount());
  const actual={...grid,bounds:[39.9,42.9,40.2,43.2]},renderer=await env.ready(actual);
  assert.deepEqual(env.maskLoads[0].bounds,actual.bounds);assert.deepEqual(env.surfaceLoads[0].data.bounds,actual.bounds);
  assert.deepEqual(Array.from(renderer.options.displayMask.source.bounds),actual.bounds);
  assert.deepEqual(Array.from(env.inspection().grid.bounds),actual.bounds);
  assert.equal(renderer.options.navigation,'map');assert.equal(env.loads[0].options.preferRegional,true);
  assert.ok(renderer.segments.length>0,'The selected real line is projected on the returned native grid');
});

test('continuous navigation retains the renderer and its completed material until the whole replacement window is prepared',async t=>{
  const env=sceneFixture({geometry:line(),routeStatus:'ready'},{holdSurface:true});t.after(()=>env.host.unmount());
  const renderer=await env.ready(),oldMaterial=materialFor(grid.bounds,'old');env.surfaceLoads[0].resolve(oldMaterial);await env.host.settle();renderer.frame();
  const oldGrid=renderer.grid;renderer.navigate(nearbyView);assert.equal(env.loads.length,2);assert.equal(env.renderers.length,1);assert.equal(renderer.destroyed,undefined);
  assert.match(env.host.text(),/Подгружаем соседний участок/);assert.equal(renderer.cartography,oldMaterial);
  await env.resolveWindow(1);assert.equal(env.surfaceLoads.length,2);assert.equal(renderer.terrainChanges.length,0);assert.equal(renderer.grid,oldGrid);
  const next=materialFor(env.loads[1].bounds,'new');env.surfaceLoads[1].resolve(next);await env.host.settle();
  assert.equal(env.renderers.length,1);assert.equal(renderer.terrainChanges.length,1);assert.equal(renderer.cartography,next);
  assert.equal(renderer.getView().longitude,nearbyView.longitude);assert.equal(renderer.getView().latitude,nearbyView.latitude);assert.ok(Math.abs(renderer.getView().yaw-nearbyView.yaw)<1e-9);assert.equal(renderer.getView().distanceM,nearbyView.distanceM);
  assert.deepEqual(Array.from(renderer.grid.bounds),env.loads[1].bounds);assert.doesNotMatch(env.host.text(),/Подгружаем соседний участок/);
});

test('a superseded neighbouring source cannot replace a newer requested camera or its route',async t=>{
  const env=sceneFixture({geometry:line(),routeStatus:'ready'});t.after(()=>env.host.unmount());const renderer=await env.ready();renderer.frame();
  renderer.navigate(nearbyView);renderer.navigate({...nearbyView,longitude:40.5,yaw:1.1});assert.equal(env.loads.length,3);assert.equal(env.loads[1].options.signal.aborted,true);
  await env.resolveWindow(1);assert.equal(renderer.terrainChanges.length,0);assert.equal(env.maskLoads.length,1,'Aborted source results do not start a new mask');
  await env.resolveWindow(2);assert.equal(renderer.terrainChanges.length,1);assert.equal(renderer.getView().longitude,40.5);assert.ok(Math.abs(renderer.getView().yaw-1.1)<1e-9);
  assert.deepEqual(Array.from(renderer.grid.bounds),env.loads[2].bounds);assert.equal(env.renderers.length,1);
});

test('returning to the already loaded window cancels an obsolete neighbouring load instead of snapping back on arrival',async t=>{
  const env=sceneFixture({geometry:line()});t.after(()=>env.host.unmount());const renderer=await env.ready();renderer.frame();
  const returned={...nearbyView,longitude:40.05,yaw:.2};assert.equal(planTerrainNavigation(returned,grid.bounds,{width:800,height:600},30),null);
  renderer.navigate(nearbyView);assert.equal(env.loads.length,2);renderer.navigate(returned);
  assert.equal(env.loads[1].options.signal.aborted,true,'A new gesture supersedes a pending window even when no replacement request is required');
  await env.resolveWindow(1);assert.equal(renderer.terrainChanges.length,0);assert.equal(renderer.getView().longitude,returned.longitude);assert.equal(renderer.getView().yaw,returned.yaw);
  const inspection=env.inspection();assert.equal(inspection.loadingWindow,false);assert.equal(inspection.requestedWindowRevision,inspection.windowRevision);
  assert.deepEqual(inspection.requestedBounds,inspection.loadedRequestBounds);assert.deepEqual(inspection.requestedViewport,inspection.loadedViewport);
  assert.doesNotMatch(env.host.text(),/Подгружаем соседний участок/);
});

test('a late material from an obsolete geographic window never paints the current DEM',async t=>{
  const env=sceneFixture({geometry:line()},{holdSurface:true});t.after(()=>env.host.unmount());const renderer=await env.ready();renderer.frame();
  renderer.navigate(nearbyView);await env.resolveWindow(1);
  const current=materialFor(env.loads[1].bounds,'current');env.surfaceLoads[1].resolve(current);await env.host.settle();
  env.surfaceLoads[0].resolve(materialFor(grid.bounds,'obsolete'));await env.host.settle();
  assert.deepEqual(renderer.cartographyChanges,[current]);assert.equal(renderer.cartography,current);assert.equal(env.inspection().cartography.source.name,'current');
});

test('a failed neighbouring load keeps the real current model and its source warning through later frames',async t=>{
  const env=sceneFixture({geometry:line()},{holdSurface:true});t.after(()=>env.host.unmount());const renderer=await env.ready();
  const current=materialFor(grid.bounds);env.surfaceLoads[0].resolve(current);await env.host.settle();renderer.frame();
  renderer.navigate(nearbyView);env.loads[1].reject(new Error('Upstream unavailable'));await env.host.settle();
  assert.equal(renderer.terrainChanges.length,0);assert.equal(renderer.cartography,current);assert.match(env.host.text(),/Предыдущий ландшафт сохранён/);
  renderer.frame();assert.match(env.host.text(),/Предыдущий ландшафт сохранён/,'A successful old frame is not proof that the failed neighbouring source recovered');
  assert.equal(env.inspection().state,'ready');assert.equal(env.renderers.length,1);
  assert.equal(env.inspection().requestedWindowRevision,env.inspection().windowRevision);assert.deepEqual(env.inspection().requestedViewport,env.inspection().loadedViewport);
});

test('closing during a replacement window cancels its terrain and cannot revive the disposed renderer',async()=>{
  const env=sceneFixture({});const renderer=await env.ready();renderer.frame();renderer.navigate(nearbyView);env.host.unmount();
  assert.equal(env.loads[1].options.signal.aborted,true);assert.equal(renderer.destroyed,true);await env.resolveWindow(1);
  assert.equal(renderer.terrainChanges.length,0);assert.equal(env.renderers.length,1);assert.equal(env.maskLoads.length,1);
});
