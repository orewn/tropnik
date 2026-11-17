import type {Trail} from './content';
import type {MapRegion} from './territories';

export const EMPTY_MAP_TRAILS: readonly Trail[] = Object.freeze([]);

/** Geographic coordinates are always [longitude, latitude]. Screen pixels
 * and native SDK LatLng values are converted only at their adapter boundary. */
export type MapCoordinate = [longitude: number, latitude: number];
export type MapBounds = [west: number, south: number, east: number, north: number];
export type PlannerMapPoint = {
  id: string;
  point: MapCoordinate;
  label: string;
  kind: 'start' | 'finish' | 'via' | 'join' | 'choice';
  onSelect?: () => void;
};
export type AtlasProps = {
  /** Independent mobile destinations retain their manually chosen camera. */
  workspace?: 'map' | 'saved';
  region?: MapRegion;
  trail?: Trail;
  visibleTrails?: readonly Trail[];
  /** Complete reference and published catalogue for stable direction totals.
   * Visible trails remain the filtered selection used for lines and points. */
  catalogTrails?: readonly Trail[];
  onTrail?: (trail: Trail) => void;
  onRegion: (region: MapRegion) => void;
  onMapNote?: (text: string) => void;
  onViewportRegion?: (regionId: string | undefined) => void;
  planning?: boolean;
  planPoints?: PlannerMapPoint[];
};
