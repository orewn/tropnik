export type ExploreSelection = {regionId?: string; trailId?: string; view?: 'saved'; from?: 'saved'};

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
  if (selection.view === 'saved') url.searchParams.set('view', 'saved'); else url.searchParams.delete('view');
  if (selection.from === 'saved') url.searchParams.set('from', 'saved'); else url.searchParams.delete('from');
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

export type ExploreListContext = {regionId?: string; query: string; filters: ExploreFilters};
export type ExplorePage = {key: string; limit: number};
export type ExploreMapContext = ExploreListContext & {trailId?: string; sheetOpen: boolean; listOrigin?: ExploreListContext; page: ExplorePage};
export type ExploreUiContext = {
  query: string; filters: ExploreFilters; sheetOpen: boolean; listOrigin?: ExploreListContext;
  page?: ExplorePage; scroll?: {key: string; top: number}[]; mapContext?: ExploreMapContext;
};

/** Each visit owns its search and list context. Store only small UI values;
 * route geometry and saved packages never enter browser history. */
export function writeExploreContext(environment: ExploreHistoryEnvironment, context: ExploreUiContext): void {
  const state = environment.history.state;
  environment.history.replaceState({...state, tropnikExploreUi: context}, '', environment.location.href);
}

export function readExploreContext(state: unknown): ExploreUiContext | undefined {
  if (!state || typeof state !== 'object' || !('tropnikExploreUi' in state)) return;
  const value = state.tropnikExploreUi as ExploreUiContext | undefined;
  if (!value || typeof value.query !== 'string' || value.query.length > 160 || typeof value.sheetOpen !== 'boolean' || !validFilters(value.filters)) return;
  if (value.listOrigin && (typeof value.listOrigin.query !== 'string' || !validFilters(value.listOrigin.filters))) return;
  if (value.page && !validPage(value.page)) return;
  if (value.scroll && (!Array.isArray(value.scroll) || value.scroll.length > 40 || value.scroll.some(item => !item || typeof item.key !== 'string' || item.key.length > 512 || !Number.isFinite(item.top) || item.top < 0 || item.top > 10_000_000))) return;
  if (value.mapContext && (typeof value.mapContext.query !== 'string' || typeof value.mapContext.sheetOpen !== 'boolean' || !validFilters(value.mapContext.filters) || !validPage(value.mapContext.page))) return;
  return value;
}

function validPage(value: ExplorePage | undefined): boolean {
  return Boolean(value && typeof value.key === 'string' && value.key.length <= 512 && Number.isInteger(value.limit) && value.limit >= 12 && value.limit <= 10_000);
}

function validFilters(value: ExploreFilters | undefined): boolean {
  return Boolean(value && typeof value.expanded === 'boolean' && typeof value.onlySaved === 'boolean'
    && ['all', 'easy', 'moderate', 'hard', 'unknown'].includes(value.difficulty) && ['any', 'day'].includes(value.duration));
}

/** Region controls cannot silently constrain the overview, including the first
 * render before a navigation reset is committed. */
export function exploreFiltersForRegion(regionId: string | undefined, filters: ExploreFilters): ExploreFilters {
  return regionId ? filters : DEFAULT_EXPLORE_FILTERS;
}
