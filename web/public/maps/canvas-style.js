/* Original OpenMapTiles style for the Canvas 2D compatibility renderer. */
import {outdoorPaths,markerStyle} from './tropnik-pictograms.js';
import {isPriorityCity,priorityCityFontSize} from './map-city-labels.js';

// Classify only features supplied by the vector tile. A generic hotel, ridge,
// cliff or water polygon must not become an invented shelter, peak or spring.
export function outdoorPoiKey(props,layer='poi'){
 const values=[props?.subclass,props?.class];
 const has=items=>values.some(value=>items.includes(value));
 if(layer==='mountain_peak'){
  if(has(['saddle','mountain_pass']))return 'pass';
  if(has(['peak','volcano']))return 'peak';
  return undefined;
 }
 if(has(['camp_site','caravan_site','campsite']))return 'camp';
 if(has(['alpine_hut','wilderness_hut','shelter']))return 'shelter';
 if(has(['drinking_water','water_point','spring']))return 'water';
 if(has(['viewpoint']))return 'viewpoint';
 if(has(['saddle','mountain_pass']))return 'pass';
 if(has(['information','information_board','information_office','guidepost','visitor_centre','board']))return 'info';
 return undefined;
}

const compiledOutdoorPaths=new Map();
class OutdoorPOISymbolizer{
 constructor(p,layer){
  this.layer=layer;
  this.text=new p.CenteredTextSymbolizer({labelProps:['name:ru','name','name:latin'],font:'500 12px Manrope, sans-serif',fill:'#486148',stroke:'#faf6e9',width:2,maxLineChars:20});
 }
 place(layout,geom,feature){
  const key=outdoorPoiKey(feature.props,this.layer),anchor=geom?.[0]?.[0];
  if(!key||feature.geomType!==1||!anchor||typeof Path2D!=='function')return undefined;
  if(!compiledOutdoorPaths.has(key))compiledOutdoorPaths.set(key,outdoorPaths[key].map(path=>new Path2D(path)));
  const paths=compiledOutdoorPaths.get(key);
  const text=this.text.place(layout,geom,feature)?.[0];
  const textOffset=23;
  const bboxes=[{minX:anchor.x-16,minY:anchor.y-16,maxX:anchor.x+16,maxY:anchor.y+16}];
  if(text)for(const box of text.bboxes)bboxes.push({...box,minY:box.minY+textOffset,maxY:box.maxY+textOffset});
  const draw=ctx=>{
   ctx.save();ctx.globalAlpha=1;ctx.fillStyle=markerStyle.fill;ctx.strokeStyle=markerStyle.stroke;ctx.lineWidth=markerStyle.lineWidth;ctx.lineCap='round';ctx.lineJoin='round';
   ctx.beginPath();ctx.moveTo(-7,-15);ctx.lineTo(7,-15);ctx.arcTo(15,-15,15,-7,8);ctx.lineTo(15,7);ctx.arcTo(15,15,7,15,8);ctx.lineTo(-7,15);ctx.arcTo(-15,15,-15,7,8);ctx.lineTo(-15,-7);ctx.arcTo(-15,-15,-7,-15,8);ctx.closePath();ctx.fill();ctx.stroke();
   ctx.save();ctx.translate(-12,-12);ctx.scale(24/28,24/28);ctx.lineWidth=markerStyle.lineWidth*28/24;for(const path of paths)ctx.stroke(path);ctx.restore();
   if(text){ctx.translate(0,textOffset);text.draw(ctx);}ctx.restore();
  };
  return [{anchor,bboxes,draw}];
 }
}

export function canvasStyle(p,showPaths=true,satellite=false){
 const is=(key,values)=>(_z,f)=>values.includes(f.props[key]);
 const poly=(dataLayer,fill,filter,extras={})=>({dataLayer,symbolizer:new p.PolygonSymbolizer({fill}),...(filter?{filter}:{}),...extras});
 const line=(dataLayer,color,width,filter,extras={})=>({dataLayer,symbolizer:new p.LineSymbolizer({color,width,...(extras.dash?{dash:extras.dash}:{}),opacity:extras.opacity??1,lineCap:'round'}),...(filter?{filter}:{}),...(extras.minzoom!==undefined?{minzoom:extras.minzoom}:{}),...(extras.maxzoom!==undefined?{maxzoom:extras.maxzoom}:{})});
 const label=(dataLayer,size,color,filter,extras={})=>({dataLayer,symbolizer:new p.CenteredTextSymbolizer({labelProps:['name:ru','name','name:latin'],font:typeof size==='function'?z=>`500 ${size(z)}px Manrope, sans-serif`:`500 ${size}px Manrope, sans-serif`,fill:color,stroke:'#f6f4e8',width:2,maxLineChars:20,...(extras.upper?{textTransform:'uppercase'}:{})}),...(filter?{filter}:{}),...(extras.minzoom!==undefined?{minzoom:extras.minzoom}:{}),...(extras.maxzoom!==undefined?{maxzoom:extras.maxzoom}:{})});
 const paintRules=[
 poly('landcover','#E3E9D8',is('class',['grass','farmland'])),poly('landcover','#BACEAF',is('class',['wood','forest'])),poly('landcover','#D2DFC5',is('class',['scrub','heath'])),poly('landcover','#f6f5ee',is('class',['ice'])),poly('landuse','#e7e8db',is('class',['residential','commercial','industrial']),{minzoom:9}),poly('park','#d4e1c1'),
 poly('water','#C5DEE5'),line('waterway','#82ADB9',z=>Math.max(.6,Math.min(3,(z-8)*.3)),null,{minzoom:7}),line('boundary','#8F9E87',.65,(_z,f)=>Number(f.props.admin_level)<=4,{dash:[4,3],opacity:z=>Math.max(.18,.58-Math.max(0,z-7)*.08)}),
 line('transportation','#CBC9B5',z=>Math.max(.5,Math.min(7,(z-6)*.65)),is('class',['motorway','trunk','primary','secondary']),{minzoom:5}),line('transportation','#FFFEF7',z=>Math.max(.5,Math.min(5,(z-7)*.45)),is('class',['motorway','trunk','primary','secondary']),{minzoom:8}),line('transportation','#FFFEF7',z=>Math.max(.6,Math.min(3.5,(z-10)*.5)),is('class',['tertiary','minor','service']),{minzoom:11}),
 ...(showPaths?[line('transportation',satellite?'#F2DCB4':'#9C7950',z=>Math.max(.8,Math.min(2.4,(z-9)*.3)),is('class',['track','path']),{dash:[3,3],minzoom:11})]:[]),poly('building','#CFCBB9',null,{minzoom:14}),line('transportation','#acb2a3',1,is('class',['rail']),{dash:[2,4],minzoom:11})
 ];
 const labelRules=[
 {dataLayer:'place',minzoom:3,filter:(_z,f)=>isPriorityCity(f.props),symbolizer:new p.CenteredTextSymbolizer({labelProps:['name:ru','name','name:latin'],font:z=>`600 ${priorityCityFontSize(z)}px Manrope, sans-serif`,fill:'#263F32',stroke:'#FFFEFA',width:2.4,maxLineChars:20})},
 label('place',12,'#687d66',is('class',['country']),{upper:true,maxzoom:5}),label('place',12,'#849477',is('class',['state']),{minzoom:4,maxzoom:8}),label('place',z=>z<9?12:16,'#314F3D',(_z,f)=>f.props.class==='city'&&!isPriorityCity(f.props),{minzoom:4,maxzoom:15}),label('place',z=>z<11?12:14,'#405E47',is('class',['town']),{minzoom:8,maxzoom:17}),
 {dataLayer:'mountain_peak',symbolizer:new OutdoorPOISymbolizer(p,'mountain_peak'),filter:(_z,f)=>!!outdoorPoiKey(f.props,'mountain_peak'),minzoom:11},
 label('mountain_peak',12,'#736348',(_z,f)=>!outdoorPoiKey(f.props,'mountain_peak'),{minzoom:11}),
 label('place',12,'#4F654B',is('class',['village','hamlet']),{minzoom:11}),label('water_name',12,'#477B8C',null,{minzoom:7}),
 {dataLayer:'poi',symbolizer:new OutdoorPOISymbolizer(p,'poi'),filter:(_z,f)=>!!outdoorPoiKey(f.props,'poi'),minzoom:13}];
 return{paintRules:satellite?paintRules.filter(rule=>!['landcover','landuse','park','water','building'].includes(rule.dataLayer)):paintRules,labelRules,backgroundColor:satellite?'rgba(0,0,0,0)':'#e9ecdf',maxDataZoom:14};
}
