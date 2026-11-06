import {canvasStyle} from '/maps/canvas-style.js';
import {RUSSIA_AREA_URL,RUSSIA_MASK_URL,RUSSIA_CANONICAL_MASK_URL,MAP_OUTSIDE_COLOR,russiaCamera,russiaPadding,constrainRussiaCamera,displayGeoJSON,inRussiaCoverage,coveredRussiaBounds,leafletRussiaMask,russiaLongitude} from '/maps/russia-viewport.js';

const byId=id=>document.getElementById(id),status=text=>{byId('map-status').textContent=text;};
const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MASK='russia-outside-mask';
let saved=[],hasPilot=false,selected=null,driver,coverage=null,creditsStarted=false,creditsPinned=false;
function setCredits(expanded){byId('map-credit-body').hidden=!expanded;byId('map-credit-toggle').setAttribute('aria-expanded',String(expanded));byId('map-credit-toggle').setAttribute('aria-label',expanded?'Свернуть сведения об источниках':'Данные карты и лицензии');}
byId('map-credit-toggle').onclick=()=>{creditsPinned=true;setCredits(byId('map-credit-body').hidden);};
function mapVisible(visible){
 byId('map').classList.toggle('map-is-loading',!visible);byId('map').setAttribute('aria-busy',String(!visible));
 for(const button of document.querySelectorAll('.map-tools button'))button.disabled=!visible;
 if(visible&&!creditsStarted){
  creditsStarted=true;byId('map-credits').hidden=false;
  setTimeout(()=>{const element=byId('map-credits');if(creditsPinned||element.matches(':hover')||element.contains(document.activeElement))return;setCredits(false);},8000);
 }
}
async function json(url){const response=await fetch(url);if(!response.ok)throw new Error('Local map resource unavailable');return response.json();}
function coordinates(data){
 const result=[];
 const walk=value=>{
  if(Array.isArray(value)){if(typeof value[0]==='number'&&typeof value[1]==='number'&&Number.isFinite(value[0])&&Number.isFinite(value[1]))result.push(value);else value.forEach(walk);}
  else if(value&&typeof value==='object')walk(value.features??value.geometry??value.geometries??value.coordinates);
 };
 walk(data);return result;
}
function cameraView(tileSize){
 const element=byId('map'),rect=element.getBoundingClientRect(),panel=document.querySelector('aside').getBoundingClientRect();
 const overlaps=panel.right>rect.left&&panel.left<rect.right&&panel.top<rect.bottom&&panel.bottom>rect.top;
 const credits=byId('map-credits'),creditRect=credits.getBoundingClientRect();
 const coveredPanel=overlaps?Math.max(0,rect.bottom-Math.max(rect.top,panel.top)):0;
 const coveredCredit=!credits.hidden&&creditRect.height?Math.max(0,rect.bottom-creditRect.top):0;
 const covered=Math.max(coveredPanel,coveredCredit),padding=russiaPadding(rect.width,rect.height,covered);
 element.parentElement.style.setProperty('--map-bottom-inset',`${covered}px`);
 return {camera:russiaCamera(rect.width,rect.height,padding,tileSize),padding};
}
function coveredBounds(data){return coveredRussiaBounds(coordinates(data),coverage);}
function coverageStyle(style,mask){
 const next=structuredClone(style);
 next.sources['russia-land']={type:'geojson',data:coverage};next.sources['russia-mask']={type:'geojson',data:mask};
 if(next.sources['overview-land'])next.sources['overview-land']={type:'geojson',data:coverage};
 if(!next.layers.some(layer=>layer.id==='russia-land')){
  let at=0;next.layers.forEach((layer,index)=>{if(layer.type==='background')at=index+1;});
  next.layers.splice(at,0,{id:'russia-land',type:'fill',source:'russia-land',paint:{'fill-color':'#dbe4cd','fill-outline-color':'#aebda2'}});
 }
 next.layers=next.layers.filter(layer=>layer.id!==MASK);
 next.layers.push({id:MASK,type:'fill',source:'russia-mask',paint:{'fill-color':MAP_OUTSIDE_COLOR,'fill-antialias':false}});
 return next;
}
function overviewStyle(admin,mask){
 return coverageStyle({version:8,sources:{regions:{type:'geojson',data:displayGeoJSON(admin)},'russia-relief':{type:'raster',tiles:['/maps/russia-relief/{z}/{x}/{y}.png'],tileSize:256,minzoom:0,maxzoom:4}},layers:[
  {id:'background',type:'background',paint:{'background-color':MAP_OUTSIDE_COLOR}},
  {id:'overview-relief',type:'raster',source:'russia-relief',maxzoom:6,paint:{'raster-opacity':['interpolate',['linear'],['zoom'],0,1,4,1,6,0]}},
  {id:'boundaries',type:'line',source:'regions',paint:{'line-color':'#9eaf8c','line-width':.7}},
 ]},mask);
}
function observeMap(resize){
 let frame=0;const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(resize);});observer.observe(byId('map'));observer.observe(document.querySelector('aside'));observer.observe(byId('map-credits'));
 return()=>{observer.disconnect();cancelAnimationFrame(frame);};
}
async function createGL(ml,admin,mask){
 ml.setWorkerUrl('/maps/maplibre-worker.js');let floor=cameraView(512).camera,fullView=true,styleReady=false,routeGeometry=null,fitPending=false,positionMarker=null,disposed=false;
 const map=new ml.Map({container:'map',style:overviewStyle(admin,mask),...floor,minZoom:Math.max(-2,floor.zoom),maxZoom:18,attributionControl:false,renderWorldCopies:true,maxPitch:70,pixelRatio:Math.min(devicePixelRatio,2),
  transformConstrain:(point,zoom)=>{const next=constrainRussiaCamera(point.lng,point.lat,zoom,floor);return {center:new ml.LngLat(...next.center),zoom:next.zoom};},
 });
 const fitRussia=()=>{floor=cameraView(512).camera;fullView=true;map.setMinZoom(Math.max(-2,floor.zoom));map.setTerrain(null);map.easeTo({...floor,padding:{top:0,right:0,bottom:0,left:0},duration:reduced?0:500});};
 const draw=(geometry,fit=true)=>{
  routeGeometry=geometry;fitPending=fit;
  if(!styleReady)return;
  const data=displayGeoJSON(geometry||{type:'FeatureCollection',features:[]});
  if(map.getSource('saved-route'))map.getSource('saved-route').setData(data);
  else{
   map.addSource('saved-route',{type:'geojson',data});
   map.addLayer({id:'route-halo',type:'line',source:'saved-route',paint:{'line-color':'#fffefa','line-width':8}},MASK);
   map.addLayer({id:'route',type:'line',source:'saved-route',paint:{'line-color':'#244d3c','line-width':4,'line-dasharray':[3,1]}},MASK);
  }
  fitPending=false;if(!geometry||!fit)return;
  const covered=coveredBounds(data);
  if(!covered){status('У этой линии нет точек внутри покрытия России. Карточка остаётся доступной.');return;}
  const bounds=new ml.LngLatBounds([covered[0],covered[1]],[covered[2],covered[3]]);
  fullView=false;map.fitBounds(bounds,{padding:cameraView(512).padding,maxZoom:14,duration:reduced?0:600});
 };
 map.on('style.load',()=>{
  if(disposed)return;styleReady=true;
  if(map.getSource('openmaptiles')){
   map.addSource('pilot-coverage',{type:'geojson',data:{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[40.29,43.64],[40.49,43.64],[40.49,43.82],[40.29,43.82],[40.29,43.64]]]}}});
   map.addLayer({id:'pilot-coverage-outline',type:'line',source:'pilot-coverage',paint:{'line-color':'#a56736','line-width':2,'line-dasharray':[3,2]}},MASK);
  }
  draw(routeGeometry,fitPending);
 });
 map.on('render',()=>{if(styleReady&&map.getSource('russia-land')&&map.isSourceLoaded('russia-land')&&map.getSource('russia-mask')&&map.isSourceLoaded('russia-mask'))mapVisible(true);});
 map.on('error',()=>status('Часть данных недоступна. Проверьте сохранённое покрытие.'));
 map.on('moveend',()=>{const center=map.getCenter();fullView=Math.abs(map.getZoom()-floor.zoom)<1e-5&&Math.abs(center.lng-floor.center[0])<1e-4&&Math.abs(center.lat-floor.center[1])<1e-4;});
 const stopObserver=observeMap(()=>{if(disposed)return;const wasOverview=fullView;floor=cameraView(512).camera;map.setMinZoom(Math.max(-2,floor.zoom));map.resize();if(wasOverview)fitRussia();});
 return {
  draw,overview:fitRussia,zoomIn:()=>map.zoomIn(),zoomOut:()=>map.zoomOut(),
  locate:position=>{const {longitude,latitude}=position.coords;if(!inRussiaCoverage(longitude,latitude,coverage))return false;positionMarker?.remove();positionMarker=new ml.Marker({color:'#367a9d'}).setLngLat([russiaLongitude(longitude),latitude]).addTo(map);fullView=false;map.flyTo({center:[russiaLongitude(longitude),latitude],zoom:13,duration:reduced?0:600});return true;},
  pilot:async()=>{const style=coverageStyle(await json('/maps/pilot-style.json'),mask);styleReady=false;mapVisible(false);fullView=false;map.setStyle(style);map.setPitch(45);map.fitBounds([[40.29,43.64],[40.49,43.82]],{padding:cameraView(512).padding,duration:reduced?0:600});},
  destroy:()=>{disposed=true;stopObserver();positionMarker?.remove();map.remove();},
 };
}
async function createLeaflet(admin,mask){
 const L=window.L,p=window.protomapsL;if(!L||!p)throw new Error('Движок плоской карты не загружен.');
 let floor=cameraView(256).camera,fullView=true,clamping=false,selectedLayer,base,positionMarker,outline;
 const map=L.map('map',{center:[floor.center[1],floor.center[0]],zoom:floor.zoom,zoomControl:false,attributionControl:false,minZoom:floor.zoom,maxZoom:18,zoomSnap:0,zoomDelta:.75,preferCanvas:true,worldCopyJump:false});
 map.createPane('russia-land');map.getPane('russia-land').style.zIndex='150';map.createPane('russia-mask');Object.assign(map.getPane('russia-mask').style,{zIndex:'450',pointerEvents:'none'});
 L.geoJSON(coverage,{pane:'russia-land',renderer:L.canvas({pane:'russia-land',padding:.15}),style:{fillColor:'#dbe4cd',color:'#aebda2',fillOpacity:1,weight:.7},interactive:false}).addTo(map);
 map.createPane('russia-overview-relief');Object.assign(map.getPane('russia-overview-relief').style,{zIndex:'160',pointerEvents:'none'});
 L.tileLayer('/maps/russia-relief/{z}/{x}/{y}.png',{pane:'russia-overview-relief',minZoom:0,maxNativeZoom:4,maxZoom:6,tileSize:256,keepBuffer:1,updateWhenIdle:true}).addTo(map);
 L.geoJSON(displayGeoJSON(admin),{style:{color:'#91a67e',weight:.6,fillOpacity:0},interactive:false}).addTo(map);
 L.geoJSON(leafletRussiaMask(mask),{pane:'russia-mask',renderer:L.canvas({pane:'russia-mask',padding:.15}),interactive:false,style:{stroke:false,fillColor:MAP_OUTSIDE_COLOR,fillOpacity:1,fillRule:'evenodd'}}).addTo(map);
 const clampCamera=()=>{
  if(clamping)return;const center=map.getCenter(),next=constrainRussiaCamera(center.lng,center.lat,map.getZoom(),floor);
  if(Math.abs(center.lng-next.center[0])>1e-7||Math.abs(center.lat-next.center[1])>1e-7||Math.abs(map.getZoom()-next.zoom)>1e-7){clamping=true;map.setView([next.center[1],next.center[0]],next.zoom,{animate:false});clamping=false;}
  const after=map.getCenter();fullView=Math.abs(map.getZoom()-floor.zoom)<1e-5&&Math.abs(after.lng-floor.center[0])<1e-4&&Math.abs(after.lat-floor.center[1])<1e-4;
 };
 map.on('moveend',clampCamera);
 const fitRussia=()=>{floor=cameraView(256).camera;fullView=true;map.setMinZoom(floor.zoom);map.setView([floor.center[1],floor.center[0]],floor.zoom,{animate:!reduced});};
 const fit=(bounds,maxZoom)=>{const {padding}=cameraView(256);fullView=false;map.fitBounds(bounds,{paddingTopLeft:[padding.left,padding.top],paddingBottomRight:[padding.right,padding.bottom],maxZoom,animate:!reduced});};
 const draw=geometry=>{
  if(selectedLayer){map.removeLayer(selectedLayer);selectedLayer=null;}if(!geometry)return;
  const data=displayGeoJSON(geometry);selectedLayer=L.geoJSON(data,{style:{color:'#244d3c',weight:4,dashArray:'8 4'},interactive:false}).addTo(map);
  const covered=coveredBounds(data);if(!covered){status('У этой линии нет точек внутри покрытия России. Карточка остаётся доступной.');return;}
  fit(L.latLngBounds([[covered[1],covered[0]],[covered[3],covered[2]]]),14);
 };
 const stopObserver=observeMap(()=>{const wasOverview=fullView;map.invalidateSize({pan:false});floor=cameraView(256).camera;map.setMinZoom(floor.zoom);if(wasOverview)fitRussia();else clampCamera();});
 requestAnimationFrame(()=>mapVisible(true));
 return {
  draw,overview:fitRussia,zoomIn:()=>map.zoomIn(),zoomOut:()=>map.zoomOut(),
  locate:position=>{const {longitude,latitude}=position.coords;if(!inRussiaCoverage(longitude,latitude,coverage))return false;if(positionMarker)map.removeLayer(positionMarker);positionMarker=L.circleMarker([latitude,russiaLongitude(longitude)],{radius:7,weight:2,color:'#fff',fillColor:'#367a9d',fillOpacity:1}).addTo(map);fullView=false;map.setView([latitude,russiaLongitude(longitude)],13);return true;},
  pilot:async()=>{
   if(base)map.removeLayer(base);
   base=p.leafletLayer({url:location.origin+'/offline-map/localtiles/{z}/{x}/{y}.pbf',...canvasStyle(p),minZoom:7,bounds:[[43.64,40.29],[43.82,40.49]],noWrap:true,devicePixelRatio:Math.min(devicePixelRatio,2)}).addTo(map);
   if(!outline)outline=L.rectangle([[43.64,40.29],[43.82,40.49]],{color:'#a56736',fillOpacity:0,weight:2,dashArray:'7 5',interactive:false}).addTo(map);
   fit([[43.64,40.29],[43.82,40.49]],14);if(selected?.geometry)draw(selected.geometry);
  },
  destroy:()=>{stopObserver();map.remove();},
 };
}
async function createMap(){
 mapVisible(false);
 const [area,admin]=await Promise.all([json(RUSSIA_AREA_URL),json('/data/regions.geojson')]);
 if(!area?.features?.length)throw new Error('Coverage geometry missing');coverage=area;
 const probe=document.createElement('canvas'),gl=probe.getContext('webgl2');
 if(gl){gl.getExtension('WEBGL_lose_context')?.loseContext();const [ml,mask]=await Promise.all([import('/maps/maplibre-gl.mjs'),json(RUSSIA_CANONICAL_MASK_URL)]);if(!mask?.features?.length)throw new Error('Coverage mask missing');return createGL(ml,admin,mask);}
 const mask=await json(RUSSIA_MASK_URL);if(!mask?.features?.length)throw new Error('Coverage mask missing');return createLeaflet(admin,mask);
}
function connect(){byId('connection').textContent=navigator.onLine?'Подключение есть':'Без сети · на устройстве';}
connect();window.addEventListener('online',connect);window.addEventListener('offline',connect);
async function loadSaved(){return new Promise((resolve,reject)=>{const req=indexedDB.open('tropa-local-v1',1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('packs'))req.result.createObjectStore('packs',{keyPath:'id'});};req.onsuccess=()=>{const db=req.result,tx=db.transaction('packs'),get=tx.objectStore('packs').getAll();get.onsuccess=()=>resolve(get.result);get.onerror=()=>reject(get.error);tx.oncomplete=()=>db.close();};req.onerror=()=>reject(req.error);});}
function show(pack){
 selected=pack;const card=byId('card');card.replaceChildren();
 if(!pack){driver?.draw(null);const title=document.createElement('h2');title.textContent='Сохранённые карточки';card.append(title);return;}
 const title=document.createElement('h2');title.textContent=pack.title;const description=document.createElement('p');description.textContent=pack.trail.description;card.append(title,description);
 if(pack.trail.operatingNotice){const notice=document.createElement('p');notice.className='restriction';notice.textContent=pack.trail.operatingNotice.body;card.append(notice);}
 const meta=document.createElement('p');meta.textContent=`Источник: ${pack.trail.sourceName}. Загружен ${pack.sourceCheckedAt}. Геометрия справочная, навигационная готовность не подтверждена.`;card.append(meta);
 try{const url=new URL(pack.trail.sourceUrl);if(url.protocol==='https:'||url.protocol==='http:'){
  const link=document.createElement('a');link.href=url.href;link.target='_blank';link.rel='noreferrer';link.textContent='Открыть первоисточник';
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 28 28');svg.setAttribute('aria-hidden','true');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.5');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M16 4h8v8m0-8L12 16M11 5H5v18h18v-6');svg.append(path);link.append(svg);card.append(link);
 }}catch{}
 driver?.draw(pack.geometry);
}
byId('zoom-in').onclick=()=>driver?.zoomIn();byId('zoom-out').onclick=()=>driver?.zoomOut();
byId('overview').onclick=()=>{driver?.overview();status('Россия · полный охват');};
byId('location').onclick=()=>{
 if(!navigator.geolocation){status('Геолокация не поддерживается.');return;}
 status('Определяем местоположение…');navigator.geolocation.getCurrentPosition(position=>{
  if(!coverage||!inRussiaCoverage(position.coords.longitude,position.coords.latitude,coverage)){status('Местоположение находится за пределами доступной карты России. Переход к нему отключён.');return;}
  if(driver?.locate(position))status(`Точность около ${Math.round(position.coords.accuracy)} м. Позиция никому не передаётся.`);
 },()=>status('Позиция недоступна: проверьте разрешение и сигнал.'),{enableHighAccuracy:true,timeout:15000});
};
async function pilot(){if(!hasPilot||!driver)return;try{await driver.pilot();status('Пакет Бзерпина · граница отмечена охрой');}catch{status('Подробный пакет не удалось открыть. Доступен обзор России.');}}
byId('pilot').onclick=pilot;byId('saved').onchange=event=>show(saved.find(pack=>pack.id===event.target.value));
async function findPilot(){
 if(!('caches'in window))return;
 for(const name of(await caches.keys()).filter(value=>value.startsWith('tropnik-map-')).sort().reverse()){
  const cache=await caches.open(name);if(await cache.match('/_offline/verified-map')){hasPilot=true;if(await cache.match('/offline-map/terrain/landscape.html'))byId('landscape').href='/offline-map/terrain/landscape.html';break;}
 }
}
const results=await Promise.allSettled([createMap(),loadSaved(),findPilot()]);
if(results[0].status==='fulfilled'){driver=results[0].value;status('Россия · полный охват');}
else{byId('map').setAttribute('aria-busy','false');status('Не удалось открыть географию России. Сохранённые карточки доступны ниже.');console.error('Offline Russia map',results[0].reason);}
if(results[1].status==='fulfilled')saved=results[1].value;
for(const pack of saved){const option=document.createElement('option');option.value=pack.id;option.textContent=pack.title;byId('saved').append(option);}
byId('pilot').hidden=!hasPilot;byId('pilot').disabled=!driver;
byId('summary').textContent=results[1].status==='fulfilled'?`На устройстве ${saved.length} карточек.${hasPilot?' Подробная карта Бзерпинского района сохранена.':' Доступен обзор. Подробный пакет ещё не скачан.'}`:'Список карточек недоступен. Откройте управление картами при подключении.';
const params=new URLSearchParams(location.search);
if(params.get('map')==='pilot'&&hasPilot)await pilot();
if(params.has('route')){byId('saved').value=params.get('route');show(saved.find(pack=>pack.id===params.get('route')));}
window.addEventListener('pagehide',event=>{if(!event.persisted)driver?.destroy();});
