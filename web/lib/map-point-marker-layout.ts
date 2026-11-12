import type {MapPoint} from './custom-map-camera';
import type {MapLabelRect} from './custom-map-labels';

export type MapPointMarkerKind='trail'|'position'|'plan';
export const MAP_POINT_MARKER_SIZE=44;

/** Painted CSS-pixel bounds from custom-map.css, not the transparent hit target.
 * The circle's content box plus 3px border is centred 3px past the button
 * anchor. Include its shadow and a 2px guard. A focused button also reserves
 * its outline; the planner uses a solid 36px box with a 4px margin.
 * Keep this contract covered by the CSS-footprint test, without DOM reads on
 * camera frames. Projection and visibility belong to the engine's same frame. */
export function mapPointMarkerObstacle(point:MapPoint,kind:MapPointMarkerKind,active=false,focusVisible=false):MapLabelRect{
  if(focusVisible){const radius=MAP_POINT_MARKER_SIZE/2+2;return{left:point.x-radius,top:point.y-radius,right:point.x+radius,bottom:point.y+radius};}
  if(kind==='plan')return{left:point.x-20,top:point.y-20,right:point.x+20,bottom:point.y+20};
  // The combined state conservatively keeps the selected size and position halo.
  const radius=kind==='position'?(active?20:18):active?17:14,x=point.x+3,y=point.y+3;
  return{left:x-radius,top:y-radius,right:x+radius,bottom:y+radius};
}
