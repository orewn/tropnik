export type ExploreSelection = {regionId?: string; trailId?: string};

type ExploreHistoryEnvironment = {
  location: {href: string};
  history: Pick<History, 'state' | 'pushState' | 'replaceState'>;
};

/** An in-page parent link selects its named destination. It is a new visit,
 * so browser Back/Forward can still replay sibling routes and directions. */
export function exploreParentSelection(selection: ExploreSelection): ExploreSelection {
  return selection.trailId && selection.regionId ? {regionId: selection.regionId} : {};
}

/** A place story can choose a route in another direction. Its explicit region
 * wins over the catalogue that was selected before the click. */
export function exploreTrailSelection(
  trail: {id: string; regionId: string}, currentRegionId?: string, chosenRegionId?: string,
): ExploreSelection {
  return {regionId: chosenRegionId || currentRegionId || trail.regionId, trailId: trail.id};
}

/** Keep the current deployment path, unrelated query parameters, framework
 * history metadata and scroll-restoration policy. Repeated selection is a no-op. */
export function writeExploreHistory(
  environment: ExploreHistoryEnvironment, selection: ExploreSelection, mode: 'push' | 'replace' = 'push',
): boolean {
  const url = new URL(environment.location.href);
  if (selection.regionId) url.searchParams.set('region', selection.regionId); else url.searchParams.delete('region');
  if (selection.trailId) url.searchParams.set('route', selection.trailId); else url.searchParams.delete('route');
  if (mode === 'push' && url.href === environment.location.href) return false;
  const previous = environment.history.state;
  const current = previous && typeof previous === 'object' ? previous : {};
  const state = {
    ...current, tropnikExplore: true, tropnikExploreLevel: selection.trailId ? 2 : selection.regionId ? 1 : 0,
    tropnikExplorePushed: mode === 'push' || ('tropnikExplorePushed' in current && current.tropnikExplorePushed === true),
  };
  environment.history[mode === 'push' ? 'pushState' : 'replaceState'](state, '', url);
  return true;
}

export type ExploreFilters = {expanded: boolean; difficulty: string; duration: string; onlySaved: boolean};
export const DEFAULT_EXPLORE_FILTERS: ExploreFilters = {expanded: false, difficulty: 'all', duration: 'any', onlySaved: false};

/** Region controls cannot silently constrain the overview, including the first
 * render before a navigation reset is committed. */
export function exploreFiltersForRegion(regionId: string | undefined, filters: ExploreFilters): ExploreFilters {
  return regionId ? filters : DEFAULT_EXPLORE_FILTERS;
}
