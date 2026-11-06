import type {SearchKind} from './search';

export type SearchViewState = {query: string; kind: 'all' | SearchKind; includeUnspecified: boolean; page: number};
const kinds = new Set(['all', 'route', 'region', 'story', 'page']);

export function readSearchState(params: URLSearchParams): SearchViewState {
  const kind = params.get('kind') || 'all', page = params.get('page') || '1';
  return {
    query: (params.get('q') || '').slice(0, 160),
    kind: kinds.has(kind) ? kind as SearchViewState['kind'] : 'all',
    includeUnspecified: params.get('unknown') !== '0',
    page: /^[1-9]\d{0,4}$/.test(page) ? Number(page) : 1,
  };
}

export function searchStateQuery(state: SearchViewState): string {
  const params = new URLSearchParams();
  const query = state.query.trim().slice(0, 160);
  if (query) params.set('q', query);
  if (state.kind !== 'all') params.set('kind', state.kind);
  if (!state.includeUnspecified) params.set('unknown', '0');
  if (state.page > 1) params.set('page', String(state.page));
  return params.size ? '?' + params.toString() : '';
}

export function searchResultPage<T>(results: readonly T[], requestedPage: number, size = 12) {
  if (!Number.isInteger(size) || size < 1) throw new Error('Invalid search page size');
  const pages = Math.max(1, Math.ceil(results.length / size));
  const page = Math.min(pages, Math.max(1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1));
  const start = (page - 1) * size, end = Math.min(start + size, results.length);
  return {page, pages, start, end, items: results.slice(start, end)};
}

export function searchPageNumbers(current: number, total: number): (number | 'gap')[] {
  const visible = new Set([1, total, current - 1, current, current + 1].filter(page => page >= 1 && page <= total));
  const pages = [...visible].sort((a, b) => a - b), output: (number | 'gap')[] = [];
  for (const page of pages) {
    const previous = output.at(-1);
    if (typeof previous === 'number' && page - previous > 1) output.push('gap');
    output.push(page);
  }
  return output;
}
