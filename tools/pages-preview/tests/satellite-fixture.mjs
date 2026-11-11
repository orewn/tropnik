import {customMapFixture} from './custom-map-fixture.mjs';
import {coastFixture} from './coast-fixture.mjs';
import {unprojectMapPoint} from '../map-projection.mjs';
import {SATELLITE_REGION} from '../browser-satellite-audit.mjs';

export function satelliteFixture(profile,engine){
 const mobile=profile!=='desktop-webgl',input=mobile?'touch':'mouse',zoomStep=1;
 const rect={left:mobile?0:384,top:mobile?68:72,width:mobile?412:1041,height:mobile?847:928};rect.right=rect.left+rect.width;rect.bottom=rect.top+rect.height;
 const viewport={width:mobile?412:1440,height:mobile?915:1000,dpr:mobile?2:1};
 const initialZoom=engine==='tropnik-canvas'&&!mobile?5:4;
 const click=()=>({input,point:{x:100,y:100,unobscured:true},events:['pointerdown','pointerup','click'].map((type,index)=>({type,time:100+index,trusted:true,pointerType:input,pointerId:1}))});
 const frame=(longitude=180,zoom=initialZoom,source='eox-bluemarble')=>({engine,...(engine==='tropnik-canvas'?{customMap:customMapFixture({camera:{longitude,latitude:67.5,zoom},mode:source?'satellite':'detail',routeId:'',imagerySource:source})}:{}),region:SATELLITE_REGION,imagery:source?'satellite':'',source,target:source,state:source?'ready':'',
  base:{committed:source?'satellite':zoom<5?'overview':'detail',target:source?'satellite':'detail',state:'ready'},
  credit:{visible:!!source,text:source==='eox-bluemarble'?'NASA Blue Marble · EOX · Обзорный снимок · детализация ниже'+(zoom>8?' · Увеличен обзорный снимок':''):source?'EOxCloudless by EOX':''},
  viewport:{...viewport},rect:{...rect},camera:{longitude,latitude:67.5,zoom,tileSize:256},scrollY:0,
  ...(source?{resolution:source==='eox-bluemarble'?'overview':'detail',successfulRequestIds:source==='eox-bluemarble'?[source,'eox-bluemarble-west']:[source],pendingRequestIds:[],failedRequestIds:[],resourceSequence:9,resourcePhase:'enable-satellite'}:{}),
 });
 const native8=initialZoom+Math.ceil((8-initialZoom)/zoomStep)*zoomStep,upwardCount=Math.ceil((8-initialZoom)/zoomStep)+2;
 const steps=[['dateline-overview',180,initialZoom,'eox-bluemarble'],['dateline-native8',180,native8,'eox-bluemarble'],['dateline-overzoom',180,native8+2*zoomStep,'eox-bluemarble'],['west-eox',140,initialZoom,'eox-s2'],['dateline-return',180,initialZoom,'eox-bluemarble'],['detail-restored',180,initialZoom,'']].map(([stage,longitude,zoom,source])=>({stage,...frame(longitude,zoom,source),...(source?{coordinate:[longitude,67.5],centerErrorPx:0,resourcePhase:stage}:{})}));
 const pan=(stage,coordinate)=>{
  const result=structuredClone(coastFixture(profile,engine).pans[0]),after=frame(coordinate[0]).camera;
  const beforeCenter=unprojectMapPoint({x:rect.left+rect.width/2+result.delta.dx,y:rect.top+rect.height/2+result.delta.dy},after,rect);
  const selection={pathname:'/tropnik/explore/',region:SATELLITE_REGION,route:'',routeId:'',drawnRoute:'',mode:'satellite',committedMode:'satellite'};
  result.stage=stage;result.coordinate=coordinate;result.before={camera:{...after,longitude:beforeCenter[0],latitude:beforeCenter[1]},rect:{...rect},selection:{...selection}};result.after={camera:after,rect:{...rect},selection:{...selection}};
  result.start.x+=rect.left;result.end.x+=rect.left;for(const event of result.events)event.x+=rect.left;for(const command of result.commands)command.x+=rect.left;return result;
 };
 const zooms=[];let z=initialZoom;for(const direction of [...Array(upwardCount).fill(1),...Array(upwardCount).fill(-1)]){const before=frame(180,z);z+=direction*zoomStep;zooms.push({direction,click:click(),before,after:frame(180,z)});}
 const resources={limit:512,sequence:9,observedRequests:3,discardedRequests:0,requests:[
  {requestId:'eox-bluemarble',source:'eox-bluemarble',url:'https://tiles.maps.eox.at/wmts/1.0.0/bluemarble_3857/default/g/8/62/0.jpg',tile:{z:8,x:0,y:62},status:200,mimeType:'image/png',finished:true,bytes:9000},
  {requestId:'eox-bluemarble-west',source:'eox-bluemarble',url:'https://tiles.maps.eox.at/wmts/1.0.0/bluemarble_3857/default/g/8/62/255.jpg',tile:{z:8,x:255,y:62},status:200,mimeType:'image/png',finished:true,bytes:9000},
  {requestId:'eox-s2',source:'eox-s2',url:'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/4/3/14.jpg',tile:{z:4,x:14,y:3},status:200,mimeType:'image/jpeg',finished:true,bytes:10000},
 ]};
 resources.requests.forEach((item,index)=>Object.assign(item,{firstSequence:index*3+1,requestedSequence:index*3+1,responseSequence:index*3+2,finishedSequence:index*3+3,phase:index===2?'west-eox':'enable-satellite',responsePhase:index===2?'west-eox':'enable-satellite'}));
 const result={schemaVersion:3,profile,engine,input,region:SATELLITE_REGION,passed:true,visualReviewRequired:true,steps,
  setupZooms:initialZoom>4?[{direction:1,click:click(),before:frame(180,4,''),after:frame(180,initialZoom,'')}]:[],
  pans:[pan('dateline-overview',[180,67.5]),pan('west-eox',[140,67.5]),pan('dateline-return',[180,67.5])],zooms,
  toggles:[{label:'Спутник',open:click(),select:click(),close:null,before:frame(180,initialZoom,''),after:frame()},{label:'Тропы и ландшафт',open:click(),select:click(),close:null,before:frame(),after:frame(180,initialZoom,'')}],
  screenshots:steps.map(({stage})=>({stage,file:`${profile}-satellite-${stage}.png`,bytes:10000,sha256:'b'.repeat(64)})),resources,performance:{layoutShift:0,longestTaskMs:100}};
 const pending={...frame(180,initialZoom,''),imagery:'satellite',target:'eox-bluemarble',state:'loading',base:{committed:initialZoom<5?'overview':'detail',target:'satellite',state:'loading'},resourceSequence:1};
 if(engine==='tropnik-canvas'){pending.customMap.state.imageryLoading=true;pending.customMap.state.loading=true;pending.customMap.state.mode='satellite';}
 const held={schemaVersion:1,limit:64,timeoutMs:8000,observed:1,records:[{requestId:'fetch-image',networkId:'eox-bluemarble',url:resources.requests[0].url,source:'eox-bluemarble',pausedAt:100,resumedAt:null}],pending:1,reason:null,closed:false,errors:[]};
 const released={...structuredClone(held),pending:0,reason:'capture',closed:true};released.records[0].resumedAt=200;
 result.preload={kind:'held-real-imagery-requests',before:structuredClone(result.toggles[0].before),pending,after:structuredClone(result.toggles[0].after),held,released,
  screenshots:['preload-before','preload-pending','preload-committed'].map(stage=>({stage,file:`${profile}-satellite-${stage}.png`,bytes:10000,sha256:'c'.repeat(64)}))};
 return result;
}
