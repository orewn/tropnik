/** Original Tropnik artwork, shared with MapIcon.tsx; no sprite or map SDK. */
export const MAP_SYMBOL_PATHS = Object.freeze({
  camp:['m4 23 10-18 10 18H4Z','m10 23 4-8 4 8M11 2l3 3 3-3','M2 25h24'],
  water:['M14 3c-2 4-7 9-7 14a7 7 0 0 0 14 0c0-5-5-10-7-14Z','M10 18c0 2 1 3 3 3','M4 25h20'],
  shelter:['m3 13 11-10 11 10M6 11v13h16V11','M11 24v-8h6v8','M3 26h22'],
  pass:['m2 22 6-13 6 8 6-8 6 13','M8 5v4m12-4v4','m11 24 3-7 3 7'],
  peak:['m3 24 11-20 11 20H3Z','m10 11 4 3 4-3','M14 4V1m7 4 2-2M7 5 5 3'],
  viewpoint:['M3 15s4-7 11-7 11 7 11 7-4 7-11 7S3 15 3 15Z','m9 17 5-8 5 8H9Z','M14 3V1m-9 5L3 4m20 2 2-2'],
  info:['M24 14A10 10 0 1 1 4 14a10 10 0 0 1 20 0Z','M13 12h2v8m-2 0h4','M14 8v.01'],
  waterfall:['M3 6h8v13m5-13v16m5-16v10','M8 4h15M3 24c3-3 5 3 8 0s5 3 8 0 4 0 6 0'],
  landmark:['M5 24h18M7 24V10h14v14M10 24v-6h8v6','M5 10V5h4v3h3V3h4v5h3V5h4v5','M11 12v2m6-2v2'],
});
export type MapSymbol = keyof typeof MAP_SYMBOL_PATHS;

/** A missing name never hides an explicitly classified outdoor source point.
 * Classification uses source tags, never a name or inferred nearby geometry. */
export function sourceMapSymbol(properties:Record<string,unknown>,layerKind:string):MapSymbol|undefined{
  const category=typeof properties.class==='string'?properties.class:'';
  const subtype=typeof properties.subclass==='string'?properties.subclass:'';
  const tags=new Set([category,subtype]);
  const has=(values:string[])=>values.some(value=>tags.has(value));
  if(has(['saddle','mountain_pass']))return 'pass';
  if(layerKind==='peak'&&!has(['ridge','cliff']))return 'peak';
  if(has(['camp_site','campsite','caravan_site']))return 'camp';
  if(has(['drinking_water','spring','water_point']))return 'water';
  if(has(['shelter','alpine_hut','wilderness_hut']))return 'shelter';
  if(has(['viewpoint']))return 'viewpoint';
  if(has(['waterfall']))return 'waterfall';
  if(has(['castle','ruins','monument','memorial','archaeological_site']))return 'landmark';
  if(has(['information','guidepost','information_board']))return 'info';
  return undefined;
}

const paths=new Map<MapSymbol,Path2D[]>();
/** Native vector paths stay crisp at the actual output scale and are compiled once. */
export function drawMapSymbol(context:CanvasRenderingContext2D,symbol:MapSymbol,x:number,y:number){
  let compiled=paths.get(symbol);
  if(!compiled){compiled=MAP_SYMBOL_PATHS[symbol].map(value=>new Path2D(value));paths.set(symbol,compiled);}
  const water=symbol==='water'||symbol==='waterfall';
  // Rounded square badges distinguish source landmarks from round route pins.
  // The real anchor stays at the badge centre; no decorative location offset.
  context.save();context.translate(x,y);context.beginPath();context.roundRect(-12,-12,24,24,8);
  context.fillStyle=water?'rgba(243,250,250,.97)':'rgba(255,254,247,.97)';context.fill();
  context.lineWidth=1;context.strokeStyle=water?'rgba(66,124,136,.32)':'rgba(49,83,66,.28)';context.stroke();
  context.scale(18/28,18/28);context.translate(-14,-14);
  context.lineWidth=1.8;context.strokeStyle=water?'#376e7a':symbol==='landmark'?'#886942':'#315342';context.lineCap='round';context.lineJoin='round';
  for(const path of compiled)context.stroke(path);
  context.restore();
}
