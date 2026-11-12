import {RUSSIA_BOUNDS,russiaCamera,russiaPadding,displayGeoJSON,inRussiaCoverage,coveredRussiaBounds,russiaLongitude} from '/maps/russia-viewport.js';

const byId=id=>document.getElementById(id),status=text=>{byId('map-status').textContent=text;};
const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let saved=[],hasPilot=false,selected=null,driver,coverage=null,creditsStarted=false,creditsPinned=false,mapVisibility;
function setCredits(expanded){byId('map-credit-body').hidden=!expanded;byId('map-credit-toggle').setAttribute('aria-expanded',String(expanded));byId('map-credit-toggle').setAttribute('aria-label',expanded?'Свернуть сведения об источниках':'Данные карты и лицензии');}
byId('map-credit-toggle').onclick=()=>{creditsPinned=true;setCredits(byId('map-credit-body').hidden);};
function mapVisible(visible){
 if(mapVisibility===visible)return;mapVisibility=visible;
 byId('map').classList.toggle('map-is-loading',!visible);byId('map').setAttribute('aria-busy',String(!visible));
 for(const button of document.querySelectorAll('.map-tools button'))button.disabled=!visible;
 if(visible&&!creditsStarted){
  creditsStarted=true;byId('map-credits').hidden=false;
  setTimeout(()=>{const element=byId('map-credits');if(creditsPinned||element.matches(':hover')||element.contains(document.activeElement))return;setCredits(false);},8000);
 }
}
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
function observeMap(resize){
 let frame=0;const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(resize);});
 for(const element of [byId('map'),document.querySelector('aside'),byId('map-credits'),byId('map-status'),document.querySelector('.map-tools')])if(element)observer.observe(element);
 return()=>{observer.disconnect();cancelAnimationFrame(frame);};
}
async function createMap(){
 mapVisible(false);
 const {CustomMapEngine}=await import('/custom-map/map-runtime.js');
 const element=byId('map'),wrapper=element.parentElement,countryBounds=[...RUSSIA_BOUNDS[0],...RUSSIA_BOUNDS[1]];
 let floor=cameraView(256).camera,fullView=true,map,ready=false,disposed=false,pilotOutline;
 let stopObserver=()=>{},stopCoverage=()=>{};
 const sameCamera=(a,b)=>Math.abs(a.zoom-b.zoom)<1e-7&&Math.abs(a.center[0]-b.center[0])<1e-7&&Math.abs(a.center[1]-b.center[1])<1e-7&&Math.abs(a.bearingDegrees||0)<1e-7;
 const syncOutline=()=>{
  if(!pilotOutline)return;
  const points=[[40.29,43.64],[40.49,43.64],[40.49,43.82],[40.29,43.82]].map(coordinate=>map.project(coordinate));
  pilotOutline.firstElementChild.setAttribute('points',points.map(point=>`${point.x},${point.y}`).join(' '));
 };
 const syncObstacles=()=>{
  const viewport=element.getBoundingClientRect(),rectangles=[];
  for(const node of [document.querySelector('.map-tools'),byId('map-status'),byId('map-credits')]){
   if(!node||node.hidden)continue;const rect=node.getBoundingClientRect();
   if(rect.width>0&&rect.height>0)rectangles.push({left:rect.left-viewport.left,top:rect.top-viewport.top,right:rect.right-viewport.left,bottom:rect.bottom-viewport.top});
  }
  map.setObstacles(rectangles);
 };
 const overview=(animate=!reduced)=>{
  const view=cameraView(256);floor=view.camera;fullView=true;map.setFloor(floor);map.setPitch(0);map.setMode('detail');
  map.fit(countryBounds,view.padding,floor.zoom,animate);syncObstacles();
 };
 const draw=(geometry,fit=true)=>{
  const data=geometry?displayGeoJSON(geometry):undefined;
  map.setRoute(data,geometry?selected?.id:undefined);wrapper.dataset.mapRoute=geometry?'selected':'none';
  if(!geometry||!fit)return;
  coverage=map.getCoverage()?.area??coverage;
  const bounds=coveredBounds(data);
  if(!bounds){status('У этой линии нет точек внутри покрытия России. Карточка остаётся доступной.');return;}
  fullView=false;map.fit(bounds,cameraView(256).padding,14,!reduced);
 };
 const driver={
  draw,overview:()=>overview(),zoomIn:()=>map.zoomBy(.75),zoomOut:()=>map.zoomBy(-.75),
  locate:position=>{
   const {longitude,latitude}=position.coords;coverage=map.getCoverage()?.area??coverage;
   if(!inRussiaCoverage(longitude,latitude,coverage))return false;
   const coordinate=[russiaLongitude(longitude),latitude];
   map.setMarkers([{id:'offline-position',coordinate,label:'Моё местоположение',kind:'position'}]);
   fullView=false;map.setCamera({center:coordinate,zoom:13,bearingDegrees:0},!reduced);return true;
  },
  pilot:async()=>{
   map.setMode('detail');map.setLayers({paths:true,boundaries:true,relief:true});
   if(!pilotOutline){
    pilotOutline=document.createElementNS('http://www.w3.org/2000/svg','svg');pilotOutline.setAttribute('aria-hidden','true');
    Object.assign(pilotOutline.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none',overflow:'hidden'});
    const polygon=document.createElementNS('http://www.w3.org/2000/svg','polygon');
    polygon.setAttribute('fill','none');polygon.setAttribute('stroke','#a56736');polygon.setAttribute('stroke-width','2');polygon.setAttribute('stroke-dasharray','7 5');
    pilotOutline.appendChild(polygon);element.insertBefore(pilotOutline,map.canvas.nextSibling);
   }
   fullView=false;map.fit([40.29,43.64,40.49,43.82],cameraView(256).padding,14,!reduced);syncOutline();
   if(selected?.geometry)draw(selected.geometry);
  },
  destroy:()=>{if(disposed)return;disposed=true;stopObserver();stopCoverage();pilotOutline?.remove();map?.destroy();},
 };
 return new Promise((resolve,reject)=>{
  let startupSettled=false;
  const startupFailure=message=>{if(startupSettled||disposed)return;startupSettled=true;driver.destroy();reject(new Error(message));};
  try{
   map=new CustomMapEngine(element,{camera:floor,
    onReady:engine=>{
     if(disposed)return;map=engine;ready=true;coverage=engine.getCoverage()?.area;
     if(!coverage){startupFailure('География России недоступна.');return;}
     const session=engine.getCoverage(),warning='На этом масштабе сохранён только обзор. Подключитесь к сети для подробных контуров.';
     stopCoverage=session.subscribe(current=>{coverage=current.area;if(current.status.error)status(warning);else if(!current.status.pending&&byId('map-status').textContent===warning)status('Подробные контуры загружены.');});
     engine.setPadding(cameraView(256).padding);syncObstacles();
     stopObserver=observeMap(()=>{
      if(disposed)return;const view=cameraView(256),changed=!sameCamera(view.camera,floor),wasOverview=fullView;floor=view.camera;
      map.setFloor(floor);map.setPadding(view.padding);syncObstacles();
      if(wasOverview&&changed)overview(false);
     });
     startupSettled=true;resolve(driver);
    },
    onGesture:()=>{fullView=false;},
    onSettled:camera=>{fullView=sameCamera(camera,floor);wrapper.dataset.mapDetail=camera.zoom>=10?'close':'overview';},
    onFrame:()=>{if(!disposed&&ready){mapVisible(true);syncOutline();}},
    onState:state=>{if(disposed||!state.error)return;if(!ready)startupFailure(state.error);else status(state.error);},
   });
  }catch(error){startupFailure(error instanceof Error?error.message:'Не удалось создать карту.');}
 });
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
  const cache=await caches.open(name);if(await cache.match('/_offline/verified-map')){hasPilot=true;break;}
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
