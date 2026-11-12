/** Contour levels are derived from measured elevations at the display scale.
 * A smaller interval is a drawing choice, not a claim of finer DEM accuracy. */
export function reliefContourIntervals(zoom:number):{minorM:number;indexM:number}|null {
  if(!Number.isFinite(zoom)||zoom<10)return null;
  if(zoom>=14)return{minorM:25,indexM:100};
  if(zoom>=12)return{minorM:50,indexM:250};
  return{minorM:100,indexM:500};
}
