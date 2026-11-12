export type MapDistanceScale={metres:number;pixels:number;label:string};

/** Web Mercator is conformal: this ruler measures ground distance at the
 * camera centre. Its fixed CSS container never changes the map layout. */
export function mapDistanceScale(latitude:number,zoom:number,maxPixels=96):MapDistanceScale|null{
  if(!Number.isFinite(latitude)||Math.abs(latitude)>85.051129||!Number.isFinite(zoom)||zoom<0||zoom>22||!Number.isFinite(maxPixels)||maxPixels<16)return null;
  const metresPerPixel=40075016.68557849*Math.cos(latitude*Math.PI/180)/(256*2**zoom);
  const maximum=metresPerPixel*maxPixels,power=10**Math.floor(Math.log10(maximum));
  const metres=([5,2,1].find(step=>step*power<=maximum)??1)*power;
  const distance=metres>=1000?metres/1000:metres;
  return{metres,pixels:metres/metresPerPixel,label:`${Number(distance.toPrecision(6))} ${metres>=1000?'км':'м'}`};
}
