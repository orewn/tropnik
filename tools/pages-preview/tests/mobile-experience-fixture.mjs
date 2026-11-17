import {MOBILE_EXPERIENCE_SOURCES,mobileTargetSelectors} from '../browser-mobile-experience.mjs';
import {nativeClickFixture,nativeScrollFixture} from './experience-fixture.mjs';
import {smoothnessFixture} from './smoothness-fixture.mjs';

const copy=value=>structuredClone(value);
const rect=(left,top,width,height)=>({left,top,right:left+width,bottom:top+height,width,height});
const click=selector=>nativeClickFixture('touch',selector,{x:180,y:450,width:48,height:48});
const nav=active=>[['map','Карта'],['saved','Сохранено'],['more','Ещё']].map(([id,text])=>({id,text,active:id===active,expanded:id==='more'?'false':null}));
const focus=extra=>({tag:'BUTTON',search:false,field:null,destination:null,inMenu:false,inHeader:false,inDialog:false,visible:true,unobscured:true,...extra});
const camera=route=>({longitude:route==='route-b'?90:87,latitude:route==='route-b'?53:50,zoom:route?9:7,tileSize:256});
const routeSelector=id=>`.trail-card[data-route-id="${id}"] .trail-card-main`;
const savedSelector=(id,action)=>`.saved-card[data-saved-route-id="${id}"] [data-saved-action="${action}"]`;
function frame({route='',view='map',origin='catalog',sheet='open',saved=false,...extra}={}){
 const url=new URL('https://example.test/tropnik/?region=altai');if(route)url.searchParams.set('route',route);if(view==='saved')url.searchParams.set('view','saved');if(origin==='saved')url.searchParams.set('from','saved');
 const list=!route&&view==='map',title=view==='saved'?'Сохранено':route==='route-b'?'Маршрут Б':route?'Маршрут А':'Алтай';
 return{url:url.href,region:'altai',route,view,origin,sheet,title,query:list?'Алтай':null,busy:'false',filters:list?{expanded:'false',saved:'false',summary:'Фильтры 1'}:{expanded:null,saved:null,summary:null},values:{difficulty:null,duration:null},count:list?11:0,
  scroll:{top:list?100:0,height:list?1500:1000,clientHeight:500,page:0},cards:list?[{id:'route-a',title:'Маршрут А'},{id:'route-b',title:'Маршрут Б'}]:[],savedIds:saved?['route-b']:[],save:{pressed:route==='route-b'?(saved?'true':'false'):route?'false':null,busy:route?'false':null},navigation:nav(view==='saved'||origin==='saved'?'saved':'map'),focus:focus(),mainInert:false,canvasCount:1,canvasBackendNodeId:777,historyLength:8,
  map:{engine:'tropnik-canvas',camera:camera(route),rect:rect(0,72,412,787),route,moving:false,visible:true,rendering:{painted:true,drawnRoute:route,tilesState:'ready',coverageReady:true}},...extra};
}
const key=(value,before=focus(),after=focus(),extra=[])=>({key:value,commands:['keyDown','keyUp'].map(type=>({method:'Input.dispatchKeyEvent',type,key:value,status:'fulfilled'})),events:[{type:'keydown',key:value,trusted:true,time:100},...extra,{type:'keyup',key:value,trusted:true,time:102}],before,after});
const back=(before,after)=>({method:'Page.navigateToHistoryEntry',from:{id:9,url:before.url},target:{id:8,url:after.url},url:after.url,after:{region:after.region,route:after.route,view:after.view,title:after.title}});

export function mobileTargetsFixture(stage='initial',routeId='route-b',width=412,height=915){
 return{schemaVersion:1,stage,viewport:{width,height},navigation:nav(stage==='saved'?'saved':stage==='more'?'more':'map'),storyExpanded:false,targets:mobileTargetSelectors(stage,routeId).map(([id,selector],index)=>{
  const r=rect(8+index%4*72,80+Math.floor(index/4)*64,48,48);
  return{id,selector,label:id,rect:r,visible:true,disabled:false,samples:[[.5,.5],[.25,.25],[.75,.25],[.25,.75],[.75,.75]].map(([fx,fy])=>({x:r.left+r.width*fx,y:r.top+r.height*fy,owned:true,hit:'BUTTON'}))};
 })};
}
export function mobileBuildFixture(sourceCommit='a'.repeat(40)){
 return{sourceCommit,buildId:'d'.repeat(16),inputs:MOBILE_EXPERIENCE_SOURCES.map(path=>({path,sha256:'c'.repeat(64)}))};
}
export function mobileExperienceFixture(sourceCommit='a'.repeat(40)){
 const build=mobileBuildFixture(sourceCommit),before=frame(),detail=frame({route:'route-b'}),saved=frame({route:'route-b',saved:true}),onMap=frame({route:'route-b',saved:true,sheet:'closed'}),restored=frame({saved:true});
 const search={name:'search-route-return',launch:click('.mobile-search-launch'),focused:{focus:focus({tag:'INPUT',search:true})},typing:{method:'Input.dispatchKeyEvent',text:'Алтай',events:[...'Алтай'].flatMap((character,index)=>[
  {type:'keydown',key:character,trusted:true,search:true,time:100+index*3},{type:'input',value:'Алтай'.slice(0,index+1),trusted:true,search:true,time:101+index*3},{type:'keyup',key:character,trusted:true,search:true,time:102+index*3},
 ])},submit:key('Enter',focus({search:true}),focus(),[{type:'submit',trusted:true,time:101}]),
 filter:{opened:click('[data-filter-action="expand"]'),tabs:[key('Tab',focus({inDialog:true}),focus({inDialog:true})),key('Tab',focus({inDialog:true}),focus({tag:'SELECT',field:'difficulty',inDialog:true}))],end:key('End',focus({field:'difficulty'}),focus({field:'difficulty'}),[{type:'change',field:'difficulty',value:'unknown',trusted:true,time:101}]),leave:key('Tab',focus({field:'difficulty'}),focus({field:'duration'})),selected:{values:{difficulty:'unknown',duration:'any'}},applied:click('[data-filter-action="apply"]')},
 scroll:nativeScrollFixture('touch'),route:{id:'route-b',title:'Маршрут Б',selector:routeSelector('route-b'),scrolls:[]},before,selected:click(routeSelector('route-b')),detail,save:click('[data-route-action="save"]'),saved,showMap:click('[data-route-action="map"]'),onMap,framing:{policy:'automatic-sheet-refit',cameraDelta:{longitude:0,latitude:0,zoom:0}},back:back(onMap,restored),restored};
 const panBefore=frame({route:'route-a',saved:true,sheet:'closed'}),panAfter=copy(panBefore);panAfter.map.camera.longitude-=.04;
 const manualMap=copy(panAfter.map);
 const mapBefore=frame({route:'route-a',saved:true,map:copy(manualMap)}),savedBefore=frame({route:'route-a',saved:true,view:'saved',map:copy(manualMap)}),savedDetail=frame({route:'route-b',saved:true,origin:'saved'});
 const moreClosed=frame({route:'route-a',saved:true,focus:focus({destination:'more',inHeader:true}),map:copy(manualMap)});
 const workspace={name:'saved-map-context',route:{id:'route-a',title:'Маршрут А',selector:routeSelector('route-a'),scrolls:[]},before:copy(restored),selected:click(routeSelector('route-a')),pan:{showMap:click('[data-route-action="map"]'),before:panBefore,input:smoothnessFixture('android-portrait','tropnik-canvas').pan,after:panAfter,reopened:click('.sheet-handle')},mapBefore,
  saved:{opened:click('[data-mobile-destination="saved"]'),scrolls:[],before:savedBefore,repeat:click('[data-mobile-destination="saved"]'),repeated:copy(savedBefore),selected:click(savedSelector('route-b','open')),detail:savedDetail,back:back(savedDetail,savedBefore),restored:copy(savedBefore)},
  map:click('[data-mobile-destination="map"]'),mapRestored:copy(mapBefore),repeatMap:click('[data-mobile-destination="map"]'),mapRepeated:copy(mapBefore),
  more:{opened:click('[data-mobile-destination="more"]'),open:{mainInert:true,focus:focus({inMenu:true})},tab:key('Tab',focus({inMenu:true}),focus({inMenu:true})),tabbed:{focus:focus({inMenu:true})},escape:key('Escape',focus({inMenu:true}),focus({destination:'more',inHeader:true})),closed:moreClosed},
  parentScrolls:[],parent:click('.explore-panel .back-link'),restored:copy(restored),filterScrolls:[],filter:{opened:click('[data-filter-action="expand"]'),restored:{values:{difficulty:'unknown',duration:'any'}},closed:click('[data-filter-action="apply"]')},
 };
 return{schemaVersion:1,passed:true,profile:'android-portrait',engine:'tropnik-canvas',input:'touch',physicalDevice:false,sourceCommit,buildId:build.buildId,sources:Object.fromEntries(build.inputs.map(input=>[input.path,input.sha256])),scenarios:[search,workspace],targets:['search','filters','route','route-map','saved','more'].map(stage=>mobileTargetsFixture(stage)),
  cleanup:{opened:click('[data-mobile-destination="saved"]'),scrolls:[],remove:click(savedSelector('route-b','remove')),confirm:click('[data-saved-action="confirm-remove"]'),after:{savedIds:[]},returned:click('[data-mobile-destination="map"]')},performance:{layoutShift:0,longestTaskMs:100}};
}
