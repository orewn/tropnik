'use client';
import {useMemo, useState} from 'react';
import {regions, routeCountLabel, type Trail} from '@/lib/content';
import {territories, trailBelongsToRegion, type MapRegion} from '@/lib/territories';
import {preloadTerrain} from '@/lib/map-preload';
import {ArrowUpRight, MagnifyingGlass, CheckCircle} from './TropnikIcons';
import {RegionArtwork} from './RegionArtwork';

const searchableRegions = [...regions, ...territories];

export function TerritoryBrowser({query, catalog, onSelect, onClear}: {
  query: string; catalog: Trail[]; onSelect: (region: MapRegion) => void; onClear: () => void;
}) {
  const [mode, setMode] = useState<'directions' | 'territories'>('directions');
  const [page, setPage] = useState({key: '', limit: 18});
  const normalized = useMemo(() => query.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е'), [query]);
  const all = mode === 'territories' || !!normalized;
  const choices = useMemo(() => (normalized ? searchableRegions : all ? territories : regions).filter(item =>
    `${item.name} ${item.terrain}`.toLocaleLowerCase('ru').replaceAll('ё', 'е').includes(normalized)), [all, normalized]);
  const routeCounts = useMemo(() => new Map(searchableRegions.map(item => [
    item.id,
    catalog.reduce((count, trail) => count + Number(trailBelongsToRegion(trail, item)), 0),
  ])), [catalog]);
  const pageKey = `${mode}:${normalized}`;
  const limit = page.key === pageKey ? page.limit : 18;
  return <>
    <div className="territory-switch" aria-label="Выбор места на карте">
      <button type="button" aria-pressed={!all} onClick={() => {setMode('directions'); onClear();}}>Направления <span>{regions.length}</span></button>
      <button type="button" aria-pressed={all} onClick={() => setMode('territories')}>Все территории <span>{territories.length}</span></button>
    </div>
    <div className="section-heading"><h2 className="title-3">{all ? normalized ? 'Найдено на карте' : 'Выберите территорию' : 'Выберите направление'}</h2><span aria-live="polite">{choices.length}</span></div>
    {all && !normalized && <p className="territory-browser-note">Ищите по названию или нажмите на область карты.</p>}
    <div className={`region-list${all ? ' territory-list' : ''}`}>
      {choices.slice(0, limit).map(item => {
        const count = routeCounts.get(item.id) ?? 0;
        const warm = () => {
          const connection = (navigator as Navigator & {connection?: {saveData?: boolean; effectiveType?: string}}).connection;
          if (item.id === 'krasnodar' && !connection?.saveData && !/(?:^|-)2g$/.test(connection?.effectiveType || '')) void preloadTerrain();
        };
        return <button type="button" className="region-option" key={item.id} onPointerEnter={warm} onFocus={warm} onClick={() => onSelect(item)}>
          <span className={`region-thumbnail region-thumbnail-${item.id}`} style={{backgroundColor: item.tint}}><RegionArtwork regionId={item.id}/></span>
          <span className="region-option-text"><strong className="title-3">{item.name}</strong><small className="caption-4">{normalized ? 'territory' in item && item.territory ? 'Территория · ' : 'Направление · ' : ''}{count ? `${routeCountLabel(count)} · каталог` : 'Карта доступна · маршрутов пока нет'}</small></span>
          <ArrowUpRight size={20}/>
        </button>;
      })}
    </div>
    {choices.length > limit && <button type="button" className="territory-more button secondary full" onClick={() => setPage({key: pageKey, limit: limit + 18})}>Ещё территории · {choices.length - limit}</button>}
    {!choices.length && <div className="small-empty"><MagnifyingGlass size={25}/><h3>Не нашли такую территорию</h3><p>Попробуйте другое название: например, «Дагестан» или «Тверская область».</p><button type="button" className="text-link" onClick={onClear}>Очистить поиск</button></div>}
    <div className="together-note"><div className="quorum-dots"><span/><span/><span/><span className="guide-dot"><CheckCircle size={13} weight="fill"/></span></div><div><strong>Вместе с гидом</strong><p>От четырёх человек, включая гида. Для сложных маршрутов условия строже.</p></div></div>
  </>;
}
