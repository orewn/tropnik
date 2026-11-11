import {directionGridFixture} from './direction-hitareas-fixture.mjs';
import {directionExternalPoint} from '../browser-direction-hitareas.mjs';
import {catalogueExpectations} from '../catalogue-expectations.mjs';

export const catalogueFixture=catalogueExpectations([{id:'altai',name:'Алтай'},{id:'baikal',name:'Байкал'}],Array.from({length:21},(_,index)=>({id:`fixture-${index}`,regionId:index<11?'altai':'baikal'})));

const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
const clone=value=>structuredClone(value);

export function nativeClickFixture(input,selector,point={x:160,y:200},label='Контроль'){
 const target={width:40,height:40,label,unobscured:true,selector,...point};
 return{input,selector,point:target,events:['pointerdown','pointerup','click'].map((type,index)=>({type,time:100+index,timestamp:100+(index?1:0),trusted:true,pointerType:input,pointerId:input==='touch'?73:1,x:target.x,y:target.y}))};
}

export function nativeScrollFixture(input='touch',selector='.explore-panel-content',options={}){
 const {sheet='open',box=rect(16,350,288,240),top=0,after=100,scrollHeight=900,clientHeight=240,direction=1,distance=100}=options;
 const start={x:box.left+box.width/2,y:direction>0?box.bottom-24:box.top+24},end={x:start.x,y:start.y-direction*distance};
 const state=scrollTop=>({rect:clone(box),scrollTop,scrollHeight,clientHeight,scrollY:0,sheet});
 const types=input==='touch'?['touchStart',...Array(8).fill('touchMove'),'touchEnd']:['mouseWheel'];
 const events=input==='touch'?[
  {type:'touchstart',time:100,trusted:true,...start},
  {type:'touchmove',time:120,trusted:true,x:start.x,y:(start.y+end.y)/2},
  {type:'touchend',time:240,trusted:true,...end},
 ]:[{type:'wheel',time:100,trusted:true,...start}];
 return{input,selector,direction,start,end,distance,before:state(top),after:state(after),commands:types.map(type=>({type,method:input==='touch'?'Input.dispatchTouchEvent':'Input.dispatchMouseEvent',status:'fulfilled'})),events};
}

export function layerMenusFixture(){
 const controls=[['BUTTON','Тропы и ландшафт'],['BUTTON','Спутник'],['BUTTON','Сохранённый обзор'],['INPUT','Тропы и грунтовые дороги'],['INPUT','Рельеф и линии высот'],['INPUT','Границы территорий'],['A','Подробная офлайн-карта'],['A','Источники карты']];
 const states=['closed','open'].map(sheet=>{
  const map=rect(0,72,320,568),usable=rect(0,72,320,sheet==='open'?288:488),menu=rect(16,152,288,sheet==='open'?180:300),button=rect(16,90,40,40),scrollHeight=controls.length*44+16;
  const frame=scrollTop=>({sheet,map:clone(map),usable:clone(usable),menu:clone(menu),button:clone(button),scrollTop,scrollHeight,clientHeight:menu.height,scrollY:0,controls:controls.map(([tag,label],index)=>{
   const box=rect(menu.left+8,menu.top+8+index*44-scrollTop,240,32),inside=box.top>=menu.top-1&&box.bottom<=menu.bottom+1;
   return{index,tag,label,rect:box,inside,unobscured:inside,point:{x:box.left+box.width/2,y:box.top+box.height/2}};
  })});
  const click=()=>nativeClickFixture('touch','.layer-button',{x:36,y:110},'Слои');
  const overflow=scrollHeight-menu.height,positions=sheet==='open'?[0,overflow/2,overflow]:[0,overflow];
  return{sheet,opened:click(),frames:positions.map(frame),scrolls:positions.slice(1).map((after,index)=>nativeScrollFixture('touch','.layer-menu',{sheet,box:menu,top:positions[index],after,scrollHeight,clientHeight:menu.height})),closed:click()};
 });
 return{schemaVersion:1,passed:true,input:'touch',states};
}

const selection=(region,route,title)=>({region,route,title,sheet:'open',history:{length:8,level:route?2:region?1:0,pushed:true,explore:true},activeElement:{tag:'BUTTON',classes:'',label:null}});
const selectionURL=value=>{
 const url=new URL('https://example.test/tropnik/explore/?source=smoke');
 if(value.region)url.searchParams.set('region',value.region);
 if(value.route)url.searchParams.set('route',value.route);
 return url.href;
};
const browserBack=(from,after)=>({method:'Page.navigateToHistoryEntry',from:{id:9,url:selectionURL(from)},target:{id:8,url:selectionURL(after)},url:selectionURL(after),after:clone(after)});
const dialog=(open,title='',note='')=>({open,heading:open?'Какой поход планируете?':'',routeTitle:title,date:open?'':null,note:open?note:null,error:false,success:false,submitted:0});

export function requestMapLayoutFixture(){
 const frame={viewport:{width:1440,height:1000,dpr:1},rootClientWidth:1425,container:{x:384,y:72,width:1041,height:928},canvas:{x:384,y:72,width:1041,height:928},backing:{width:1041,height:928},connected:true,mutations:[]};
 return{schemaVersion:1,scope:'desktop-request-dialog',limit:32,active:false,overflow:false,observers:{resize:true,canvasAttributes:true},errors:[],samples:[{...clone(frame),time:100,reason:'baseline'},{...clone(frame),time:200,reason:'final'}]};
}

export function overviewCountsFixture(clustered=false){
 const catalog=[{id:'altai',name:'Алтай',count:11},{id:'baikal',name:'Байкал',count:10}];
 const markers=clustered?[{id:'altai',name:'2 направления',count:2,groupKey:'altai|baikal',cluster:true,ariaLabel:'Приблизить 2 направления: Алтай, Байкал'}]:catalog.map(item=>({...item,groupKey:item.id,cluster:false,ariaLabel:`Открыть ${item.name}, маршрутов в каталоге: ${item.count}`}));
 return{region:'',catalog,markers,total:21,mapTotal:21};
}

export function savedReentryFixture(mobile=true,clustered=false,engine='tropnik-canvas'){
 const input=mobile?'touch':'mouse';
 return(clustered?[true,false]:[false]).map((cluster,index)=>{
  const grid=directionGridFixture('altai',engine);grid.cluster=cluster;grid.groupKey=cluster?'altai|baikal':'altai';
  grid.ariaLabel=cluster?'Приблизить 2 направления: Алтай, Байкал':'Открыть Алтай, маршрутов в каталоге: 11';
  grid.surfaces.find(item=>item.kind==='label').text=cluster?'2 направления':'Алтай';grid.surfaces.find(item=>item.kind==='count').text=cluster?'2':'11';
  const point=directionExternalPoint(grid,'count'),click=nativeClickFixture(input,'canvas',point);
  for(const event of click.events)event.button={regionId:'altai',groupKey:grid.groupKey};
  return{kind:'count',input,grid,point,events:click.events,before:{region:'',route:'',zoom:2+index},after:{region:cluster?'':'altai',route:'',zoom:cluster?3:7}};
 });
}

export function exploreExperienceFixture(mobile=true,routeId='route',engine='tropnik-canvas'){
 const input=mobile?'touch':'mouse',click=(selector,label)=>nativeClickFixture(input,selector,undefined,label),scroll=()=>nativeScrollFixture(input);
 const overview=overviewCountsFixture();
 const baseline={pressed:'false',count:11,expanded:'false',empty:false};
 const filterReset={baseline:clone(baseline),enabled:click('.filter-row button[aria-pressed]','Сохранённые'),filtered:{pressed:'true',count:0,expanded:'false',empty:true},parent:click('.explore-panel .back-link','Все направления'),overviewBefore:clone(overview),overviewAfter:clone(overview),reentryActions:savedReentryFixture(mobile,false,engine),restored:clone(baseline)};
 const route={id:routeId,title:'Маршрут А'},note='Проверка принадлежности запроса маршруту',action='.route-actions button.primary',close='[role="dialog"] button[aria-label="Закрыть"]';
 const requestOwnership={route,scrolls:[scroll()],opened:click(action),first:dialog(true,route.title),edit:{method:'Input.insertText',note,events:[{trusted:true,tag:'TEXTAREA',value:note}]},edited:dialog(true,route.title,note),closedSame:click(close),reopened:click(action),same:dialog(true,route.title,note),back:browserBack(selection('altai',routeId,route.title),selection('altai','','Алтай')),afterBack:dialog(false),next:{selection:selection('altai','route-b','Маршрут Б'),scrolls:[scroll()],selected:click('.trail-list .trail-card:nth-child(2) .trail-card-main'),before:dialog(false),actionScrolls:[scroll()],opened:click(action),dialog:dialog(true,'Маршрут Б'),closed:click(close)},returnScrolls:[scroll()]};
 if(!mobile)requestOwnership.mapLayout=requestMapLayoutFixture();
 const sibling=selection('buryatia','','Бурятия'),overviewSelection=selection('','','Все направления'),polygon=click('canvas');
 const siblingParent={previous:selection('baikal','','Байкал'),sibling,selected:{input,point:{x:polygon.point.x,y:polygon.point.y,id:sibling.region,title:sibling.title},events:polygon.events},parent:click('.explore-panel .back-link','Все направления'),overview:overviewSelection,back:browserBack(overviewSelection,sibling)};
 return{schemaVersion:1,passed:true,input,filterReset,requestOwnership,siblingParent};
}

export function styleCameraRoundtripFixture(routeId='route',{edgeCount=0,engine='tropnik-canvas'}={}){
 const frame=(longitude,latitude,zoom)=>({engine,route:routeId,moving:false,visible:true,...(engine==='tropnik-canvas'?{rendering:{painted:true,drawnRoute:routeId,coverageReady:true,tilesState:'ready'}}:{}),camera:{longitude,latitude,zoom,tileSize:256},rect:rect(400,72,1040,928),width:1440,height:1000,scrollWidth:1440});
 const before=frame(87.5,49.8,8),zoomed=frame(87.5,49.8,9),manual=frame(87.499,49.8003,9),current=selection('altai',routeId,'Маршрут А');
 const start={x:900,y:400},end={x:948,y:412},delta={dx:48,dy:12};
 const types=['mouseMoved','mousePressed',...Array(12).fill('mouseMoved'),'mouseReleased'];
 const commands=types.map((type,index)=>{
  const progress=Math.max(0,Math.min(1,(index-1)/12)),sentOffsetMs=index*30+(index===types.length-1?200:0);
  return{type,method:'Input.dispatchMouseEvent',x:start.x+delta.dx*progress,y:start.y+delta.dy*progress,status:'fulfilled',sentOffsetMs,ackOffsetMs:sentOffsetMs+1};
 });
 const pan={input:'mouse',start,end,delta,holdBeforeReleaseMs:200,commands,durationMs:commands.at(-1).ackOffsetMs,events:[{type:'pointerdown',time:100,trusted:true,pointerType:'mouse',pointerId:1,...start},{type:'pointerup',time:800,trusted:true,pointerType:'mouse',pointerId:1,...end}],before:clone(zoomed),after:clone(manual)};
 const click=(selector,label)=>nativeClickFixture('mouse',selector,undefined,label);
 const transitions=['Сохранённый обзор','Тропы и ландшафт'].map((label,index)=>{
  const lineClick=nativeClickFixture('mouse','canvas',{x:800,y:350});
  return{label,opened:click('.layer-button','Слои'),scrolls:[],selected:click(`.layer-menu>button:nth-of-type(${index?1:3})`,label),closed:click('.layer-button','Слои'),frame:clone(manual),line:{point:{x:lineClick.point.x,y:lineClick.point.y},route:routeId,clicked:true,selectionRetained:true,reopened:false,events:lineClick.events},lineFrame:clone(manual),selection:clone(current),restored:{route:routeId,selected:true,mutations:[{old:routeId,current:routeId}],...(engine==='tropnik-canvas'?{drawnRoute:routeId,tilesState:'ready',drawRevision:2,beforeDrawRevision:1,mode:index?'detail':'overview'}:{}),edges:{before:edgeCount,after:edgeCount,replaced:0}}};
 });
 return{schemaVersion:2,passed:true,input:'mouse',routeId,selection:current,before,zoomed,zoom:click('.map-controls button[aria-label="Увеличить масштаб"]','Увеличить масштаб'),pan,manual,transitions};
}
