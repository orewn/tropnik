import {mkdirSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {RUSSIA_AREA_URL,RUSSIA_CANONICAL_MASK_URL,MAP_OUTSIDE_COLOR} from '../public/maps/russia-viewport.js';
import {priorityCityNames} from '../public/maps/map-city-labels.js';
const require=createRequire(import.meta.url);
const target=join(process.cwd(),'public/maps');mkdirSync(target,{recursive:true});
const font=['Noto Sans Regular'];
const name=['coalesce',['get','name:ru'],['get','name'],['get','name:latin'],''];
const source='openmaptiles';
const is=(key,value)=>['==',['get',key],value];
const oneOf=(key,values)=>['in',['get',key],['literal',values]];
/* Russia-only label re-layer: keep outside labels masked, but redraw key Russian
 * cities above the geographic mask so their names aren't cut at the coastline. */
const priorityCity=['in',name,['literal',priorityCityNames]];

const layer=(id,type,sourceLayer,paint,options={})=>({id,type,source,'source-layer':sourceLayer,paint,...options});
const text=(id,sourceLayer,minzoom,size,filter,paint={})=>layer(id,'symbol',sourceLayer,{'text-color':'#3F5144','text-halo-color':'#FFFEFA','text-halo-width':1.75,'text-halo-blur':.3,...paint},{minzoom,filter,layout:{'text-field':name,'text-font':font,'text-size':size,'text-max-width':9,'text-padding':10,'text-variable-anchor':['top','bottom','left','right'],'text-justify':'auto','text-radial-offset':.55,'symbol-avoid-edges':true,'text-allow-overlap':false,'text-ignore-placement':false}});
const style={version:8,name:'Тропник · ландшафт',metadata:{author:'Tropa project',description:'Original outdoor style. OSM paths are not field-verified hiking permissions.'},glyphs:'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',sprite:'/maps/tropnik-sprite',sky:{'sky-color':'#BFD8D8','horizon-color':'#E8ECE1','fog-color':'#DDE6DE','sky-horizon-blend':.34,'horizon-fog-blend':.38,'fog-ground-blend':.14,'atmosphere-blend':['interpolate',['linear'],['zoom'],0,.12,8,.06,12,0]},sources:{'overview-land':{type:'geojson',data:'/data/world.geojson'},'terrain-dem':{type:'raster-dem',url:'https://tiles.mapterhorn.com/tilejson.json'},'hillshade-dem':{type:'raster-dem',url:'https://tiles.mapterhorn.com/tilejson.json'},openmaptiles:{type:'vector',url:'https://tiles.openfreemap.org/planet/latest',attribution:'<a href="https://openfreemap.org">OpenFreeMap</a> · <a href="https://openmaptiles.org">OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>'}},layers:[
 {id:'background',type:'background',paint:{'background-color':'#D7E5E9'}},
 // A local geographic base remains visible while live provider tiles load.
 {id:'overview-land',type:'fill',source:'overview-land',paint:{'fill-color':'#DDE6D5','fill-outline-color':'#A7B69D'}},
 {id:'overview-relief',type:'raster',source:'russia-relief',maxzoom:6,paint:{'raster-opacity':['interpolate',['linear'],['zoom'],0,.92,4,.88,6,0],'raster-contrast':.28,'raster-saturation':-.18,'raster-brightness-min':.08,'raster-brightness-max':.92,'raster-fade-duration':0}},
 layer('natural-grass','fill','landcover',{'fill-color':'#E3E9D8','fill-opacity':.78},{filter:oneOf('class',['grass','farmland'])}),
 layer('forest','fill','landcover',{'fill-color':'#BACEAF','fill-opacity':.82},{filter:oneOf('class',['wood','forest'])}),
 layer('scrub','fill','landcover',{'fill-color':'#D2DFC5','fill-opacity':.72},{filter:oneOf('class',['scrub','heath'])}),
 layer('ice','fill','landcover',{'fill-color':'#ECF2F1'},{filter:is('class','ice')}),
 layer('residential','fill','landuse',{'fill-color':'#E9E7DE'},{filter:oneOf('class',['residential','commercial','industrial']),minzoom:9}),
 layer('parks','fill','park',{'fill-color':'#C1D5B2','fill-opacity':.22},{minzoom:7}),
 layer('park-border','line','park',{'line-color':'#789B65','line-width':.9,'line-dasharray':[3,3],'line-opacity':.65},{minzoom:9}),
 {id:'terrain-shading',type:'hillshade',source:'hillshade-dem',minzoom:2,paint:{'hillshade-method':'multidirectional','hillshade-illumination-anchor':'map','hillshade-illumination-direction':[315,270,355],'hillshade-illumination-altitude':[42,52,36],'hillshade-exaggeration':['interpolate',['linear'],['zoom'],2,.34,5,.52,9,.66,13,.72],'hillshade-shadow-color':'#29423A','hillshade-highlight-color':'#FFF2DC','hillshade-accent-color':'#3D6253'}},
 layer('water','fill','water',{'fill-color':'#C5DEE5'}),
 layer('waterway','line','waterway',{'line-color':'#82ADB9','line-width':['interpolate',['linear'],['zoom'],8,.4,14,1.5,18,3.5]},{layout:{'line-cap':'round'}}),
 layer('boundaries','line','boundary',{'line-color':'#7F9080','line-width':['interpolate',['linear'],['zoom'],2,.6,8,1.1],'line-opacity':['interpolate',['linear'],['zoom'],7,.48,12,.18],'line-dasharray':[4,3]},{filter:['<=',['get','admin_level'],4]}),
 layer('road-outline','line','transportation',{'line-color':'#CBC9B5','line-width':['interpolate',['linear'],['zoom'],6,.2,12,2.8,16,9]},{filter:oneOf('class',['motorway','trunk','primary','secondary','tertiary','minor','service']),minzoom:6,layout:{'line-cap':'round','line-join':'round'}}),
 layer('roads','line','transportation',{'line-color':'#FEFDF6','line-width':['interpolate',['linear'],['zoom'],6,.15,12,1.4,16,6.8]},{filter:oneOf('class',['motorway','trunk','primary','secondary','tertiary','minor','service']),minzoom:6,layout:{'line-cap':'round','line-join':'round'}}),
 layer('tracks','line','transportation',{'line-color':'#A88A61','line-width':['interpolate',['linear'],['zoom'],10,.65,14,1.6,18,2.8],'line-dasharray':[4,2]},{filter:is('class','track'),minzoom:10,layout:{'line-cap':'round','line-join':'round'}}),
 layer('paths','line','transportation',{'line-color':'#9C7950','line-width':['interpolate',['linear'],['zoom'],11,.8,14,1.7,18,3.2],'line-dasharray':[2,2]},{filter:is('class','path'),minzoom:11,layout:{'line-cap':'round','line-join':'round'}}),
 layer('rail','line','transportation',{'line-color':'#AAA79B','line-width':1,'line-dasharray':[5,3]},{filter:is('class','rail'),minzoom:10}),
 layer('buildings','fill','building',{'fill-color':'#CFCBB9','fill-outline-color':'#B9B49F'},{minzoom:14}),
 text('water-label','water_name',7,13,undefined,{'text-color':'#547C8D','text-halo-color':'#D5E7E9'}),
 {...text('country-label','place',1,['interpolate',['linear'],['zoom'],1,12,5,18],is('class','country'),{'text-color':'#7C8978','text-halo-width':1.2}),maxzoom:6},
 {...text('state-label','place',4,12,is('class','state'),{'text-color':'#74866E'}),maxzoom:9},
 {...text('city-label','place',3,['interpolate',['linear'],['zoom'],3,12,9,16],['all',is('class','city'),['!',priorityCity]],{'text-color':'#314F3D'}),maxzoom:16},
 {...text('town-label','place',7,['interpolate',['linear'],['zoom'],7,12,12,14],is('class','town')),maxzoom:18},
 text('village-label','place',10,12,oneOf('class',['village','hamlet','suburb'])),
 text('peak-label','mountain_peak',10,12,undefined,{'text-color':'#78664E'}),
 layer('outdoor-poi-symbol','symbol','poi',{}, {minzoom:12,filter:['any',oneOf('class',['camp_site','campsite','alpine_hut','shelter','drinking_water','viewpoint','information']),oneOf('subclass',['camp_site','campsite','alpine_hut','shelter','drinking_water','viewpoint','information'])],layout:{'icon-image':['match',['case',oneOf('subclass',['camp_site','campsite','alpine_hut','shelter','drinking_water','viewpoint','information']),['get','subclass'],['get','class']],['camp_site','campsite'],'camp',['alpine_hut','shelter'],'shelter','drinking_water','water','viewpoint','viewpoint','info'],'icon-size':.8,'icon-padding':8,'icon-allow-overlap':false}}),
 {...text('outdoor-poi-label','poi',13,12,['any',oneOf('class',['camp_site','campsite','alpine_hut','shelter','drinking_water','viewpoint','information']),oneOf('subclass',['camp_site','campsite','alpine_hut','shelter','drinking_water','viewpoint','information'])]),layout:{'text-field':name,'text-font':font,'text-size':12,'text-offset':[0,1.4],'text-anchor':'top','text-max-width':10,'text-padding':10,'symbol-avoid-edges':true}},
 layer('summit-symbol','symbol','mountain_peak',{}, {minzoom:11,filter:oneOf('class',['peak','volcano','saddle']),layout:{'icon-image':['case',is('class','saddle'),'pass','peak'],'icon-size':.7,'icon-padding':10,'icon-offset':[0,-18]}}),
 {...text('path-label','transportation_name',14,12,oneOf('class',['path','track'])),layout:{'symbol-placement':'line','text-field':name,'text-font':font,'text-size':12,'text-padding':24,'symbol-avoid-edges':true}},
]};
style.sources['overview-land'].data=RUSSIA_AREA_URL;
style.sources['russia-relief']={type:'raster',tiles:['/maps/russia-relief/{z}/{x}/{y}.png'],tileSize:256,minzoom:0,maxzoom:4};
style.sources['russia-mask']={type:'geojson',data:RUSSIA_CANONICAL_MASK_URL};
style.layers.push({id:'russia-outside-mask',type:'fill',source:'russia-mask',paint:{'fill-color':MAP_OUTSIDE_COLOR,'fill-antialias':false}});
style.layers.push(text('russia-priority-city-label','place',3,
 ['interpolate',['linear'],['zoom'],3,13,6,17,10,20],
 ['all',is('class','city'),priorityCity],
 {'text-color':'#263F32','text-halo-color':'#FFFEFA','text-halo-width':2.4,'text-halo-blur':.5}));

for(const l of style.layers)if(l.filter===undefined)delete l.filter;
writeFileSync(join(target,'tropa-style.json'),JSON.stringify(style,null,2));
const base=dirname(require.resolve('maplibre-gl/package.json'));
const worker=join(base,'dist/maplibre-gl-worker.mjs');
if(!existsSync(worker))throw new Error('MapLibre worker asset is missing');
copyFileSync(worker,join(target,'maplibre-worker.js'));
const license=join(base,'LICENSE.txt');if(existsSync(license))copyFileSync(license,join(target,'MAPLIBRE-LICENSE.txt'));
console.log('Original Tropa map style and local worker prepared.');
