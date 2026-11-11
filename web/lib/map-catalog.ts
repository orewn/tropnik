import type {Trail} from './content';

type MapTrailFilters = {
  query: string;
  difficulty: string;
  duration: string;
  onlySaved: boolean;
  savedIds: ReadonlySet<string>;
};

/** One result set drives both the route cards and their map points. */
export function filterMapTrails<T extends Pick<Trail, 'id' | 'title' | 'subtitle' | 'difficulty' | 'duration'>>(
  trails: readonly T[], filters: MapTrailFilters,
): T[] {
  const query = filters.query.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
  return trails.filter(trail =>
    (!query || `${trail.title} ${trail.subtitle}`.toLocaleLowerCase('ru').replaceAll('ё', 'е').includes(query))
    && (filters.difficulty === 'all' || trail.difficulty === filters.difficulty)
    && (!filters.onlySaved || filters.savedIds.has(trail.id))
    && (filters.duration === 'any' || trail.duration !== null && (trail.duration.includes('ч') || trail.duration.includes('мин'))));
}

/** Group the country view on its existing destination markers, without
 * creating hundreds of DOM points before a place has been chosen. */
export function mapDirectionCounts(trails: readonly Pick<Trail, 'id' | 'regionId' | 'regionIds'>[]) {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const trail of trails) {
    if (seen.has(trail.id)) continue;
    seen.add(trail.id);
    for (const id of new Set([trail.regionId, ...(trail.regionIds || [])])) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
}
