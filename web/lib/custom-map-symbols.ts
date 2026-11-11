/** Original Tropnik artwork, shared with MapIcon.tsx; no sprite or map SDK. */
export const MAP_SYMBOL_PATHS = Object.freeze({
  camp:['m4 23 10-18 10 18H4Z','m10 23 4-8 4 8M11 2l3 3 3-3','M2 25h24'],
  water:['M14 3c-2 4-7 9-7 14a7 7 0 0 0 14 0c0-5-5-10-7-14Z','M10 18c0 2 1 3 3 3','M4 25h20'],
  shelter:['m3 13 11-10 11 10M6 11v13h16V11','M11 24v-8h6v8','M3 26h22'],
  pass:['m2 22 6-13 6 8 6-8 6 13','M8 5v4m12-4v4','m11 24 3-7 3 7'],
  peak:['m3 24 11-20 11 20H3Z','m10 11 4 3 4-3','M14 4V1m7 4 2-2M7 5 5 3'],
  viewpoint:['M3 15s4-7 11-7 11 7 11 7-4 7-11 7S3 15 3 15Z','m9 17 5-8 5 8H9Z','M14 3V1m-9 5L3 4m20 2 2-2'],
  info:['M24 14A10 10 0 1 1 4 14a10 10 0 0 1 20 0Z','M13 12h2v8m-2 0h4','M14 8v.01'],
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
  if(has(['information','guidepost','information_board']))return 'info';
  return undefined;
}

const paths=new Map<MapSymbol,Path2D[]>();
/** Native vector paths stay crisp at the actual output scale and are compiled once. */
export function drawMapSymbol(context:CanvasRenderingContext2D,symbol:MapSymbol,x:number,y:number){
  let compiled=paths.get(symbol);
  if(!compiled){compiled=MAP_SYMBOL_PATHS[symbol].map(value=>new Path2D(value));paths.set(symbol,compiled);}
  context.save();context.translate(x,y);context.beginPath();context.arc(0,0,12,0,Math.PI*2);
  context.fillStyle='rgba(255,254,245,.96)';context.fill();context.scale(20/28,20/28);context.translate(-14,-14);
  context.lineWidth=1.8;context.strokeStyle=symbol==='water'?'#427c88':'#315342';context.lineCap='round';context.lineJoin='round';
  for(const path of compiled)context.stroke(path);
  context.restore();
}
