import {customMapFixture} from './custom-map-fixture.mjs';
import {nativeClickFixture} from './experience-fixture.mjs';

export function mapModeFixture({camera={longitude:40,latitude:43,zoom:14},mode='detail',routeId='kavkaz-8a',drawRevision=2}={}){
 const map=customMapFixture({camera,mode,routeId,imagerySource:mode==='satellite'?'eox-s2':undefined});
 return{engine:map.engine,camera:map.camera,pitch:map.pitch,routeId:map.routeId,drawnRoute:map.drawnRoute,drawRevision,state:map.state,
  tiles:Object.fromEntries(['overview','detail','relief','imagery'].map(kind=>[kind,map.tiles[kind].length])),canvasCount:1,terrainScenes:0,
  controls:[['Рельеф','detail'],['Спутник','satellite']].map(([label,value])=>({label,pressed:String(value===mode),disabled:false}))};
}

export function mapModeSwitchesFixture(input='touch',routeId='kavkaz-8a'){
 return[['Спутник','detail','satellite',18],['Рельеф','satellite','detail',2]].map(([label,beforeMode,afterMode,zoom])=>{
  const selector=`.map-style-switch button[aria-label="${label}"]`,click=nativeClickFixture(input,selector,undefined,label),camera={longitude:40,latitude:43,zoom};
  return{label,selector,input,point:click.point,events:click.events,canvasRetained:true,
   before:mapModeFixture({camera,routeId,mode:beforeMode,drawRevision:2}),after:mapModeFixture({camera,routeId,mode:afterMode,drawRevision:3})};
 });
}
