'use client';
import {useEffect, useState} from 'react';
import {regions, routeCountLabel, type Trail} from '@/lib/content';
import {territories, trailBelongsToRegion, type MapRegion} from '@/lib/territories';
import {preloadTerrain} from '@/lib/map-preload';
import {ArrowUpRight, MagnifyingGlass, CheckCircle} from './TropnikIcons';
import {RegionArtwork} from './RegionArtwork';

export function TerritoryBrowser({query, catalog, onSelect, onClear}: {
  query: string; catalog: Trail[]; onSelect: (region: MapRegion) => void; onClear: () => void;
}) {
  const [mode, setMode] = useState<'directions' | 'territories'>('directions');
  const [limit, setLimit] = useState(18);
  const normalized = query.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
  const all = mode === 'territories' || !!normalized;
  const choices = (normalized ? [...regions, ...territories] : all ? territories : regions).filter(item =>
    `${item.name} ${item.terrain}`.toLocaleLowerCase('ru').replaceAll('ё', 'е').includes(normalized));
  useEffect(() => setLimit(18), [mode, query]);
  return <>
    <div className="territory-switch" aria-label="Выбор места на карте">
      <button aria-pressed={!all} onClick={() => {setMode('directions'); onClear();}}>Направления <span>{regions.length}</span></button>
      <button aria-pressed={all} onClick={() => setMode('territories')}>Все территории <span>{territories.length}</span></button>
    </div>
    <div className="section-heading"><h2 className="title-3">{all ? normalized ? 'Найдено на карте' : 'Выберите территорию' : 'Выберите направление'}</h2><span aria-live="polite">{choices.length}</span></div>
    {all && !normalized && <p className="territory-browser-note">Ищите по названию или нажмите на область карты.</p>}
    <div className={`region-list${all ? ' territory-list' : ''}`}>
      {choices.slice(0, limit).map(item => {
        const count = catalog.filter(trail => trailBelongsToRegion(trail, item)).length;
        const warm = () => {if (item.id === 'krasnodar') void preloadTerrain();};
        return <button className="region-option" key={item.id} onPointerEnter={warm} onFocus={warm} onTouchStart={warm} onClick={() => onSelect(item)}>
          <span className={`region-thumbnail region-thumbnail-${item.id}`} style={{backgroundColor: item.tint}}><RegionArtwork regionId={item.id}/></span>
          <span className="region-option-text"><strong className="title-3">{item.name}</strong><small className="caption-4">{normalized ? 'territory' in item && item.territory ? 'Территория · ' : 'Направление · ' : ''}{count ? `${routeCountLabel(count)} · каталог` : 'Карта доступна · маршрутов пока нет'}</small></span>
          <ArrowUpRight size={20}/>
        </button>;
      })}
    </div>
    {choices.length > limit && <button className="territory-more button secondary full" onClick={() => setLimit(value => value + 18)}>Ещё территории · {choices.length - limit}</button>}
    {!choices.length && <div className="small-empty"><MagnifyingGlass size={25}/><h3>Не нашли такую территорию</h3><p>Попробуйте другое название: например, «Дагестан» или «Тверская область».</p><button className="text-link" onClick={onClear}>Очистить поиск</button></div>}
    <div className="together-note"><div className="quorum-dots"><span/><span/><span/><span className="guide-dot"><CheckCircle size={13} weight="fill"/></span></div><div><strong>Вместе с гидом</strong><p>От четырёх человек, включая гида. Для сложных маршрутов условия строже.</p></div></div>
  </>;
}
