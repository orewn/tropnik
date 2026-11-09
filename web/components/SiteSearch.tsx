'use client';
import Link from 'next/link';

import {useDeferredValue, useEffect, useMemo, useRef, useState} from 'react';
import {ArrowLeft, ArrowRight, Clock, MagnifyingGlass, MapPin, NotePencil, Path, Stack, X} from '@/components/TropnikIcons';
import {EventCategoryIcon} from '@/components/EventCategoryIcon';
import {deriveRouteCategories, eventCategoryById} from '@/lib/event-categories';
import {searchSite, type SearchHit} from '@/lib/site-search';
import {readSearchState, searchPageNumbers, searchResultPage, searchStateQuery, type SearchViewState} from '@/lib/search-state';
import styles from './SiteSearch.module.css';

const kindLabels = {all: 'Все материалы', route: 'Маршруты', region: 'Направления', story: 'Истории мест', page: 'Страницы сайта'};
const singularKind = {route: 'Маршрут', region: 'Направление', story: 'История места', page: 'На сайте'};
const suggestions = ['Байкал до 15 км', 'На один день', 'Водопад', 'Скачать карту'];
const number = (value: number) => value.toLocaleString('ru');

function Result({hit}: {hit: SearchHit}) {
  const category = hit.kind === 'route' ? deriveRouteCategories(hit)[0] : undefined;
  const definition = category ? eventCategoryById[category] : undefined;
  const OtherIcon = hit.kind === 'region' ? MapPin : hit.kind === 'story' ? NotePencil : Stack;
  return <li><a href={hit.href} className={styles.result}>
    <span className={`${styles.symbol}${definition ? ` event-category-tone-${definition.tone}` : ''}`} aria-hidden="true">{category ? <EventCategoryIcon category={category} size={32}/> : <OtherIcon size={28}/>}</span>
    <div>
      <div className={`${styles.type} caption-4`}><span>{singularKind[hit.kind]}</span>{definition && <><span aria-hidden="true">·</span><span>{definition.shortLabel}</span></>}{hit.regionName && <><span aria-hidden="true">·</span><span>{hit.regionName}</span></>}</div>
      <h3 className="heading-6">{hit.title}</h3>
      <p className={`${styles.description} body-6`}>{hit.description}</p>
      {(hit.kind === 'route' || hit.accessStatus) && <div className={`${styles.metadata} caption-4`}>
        {hit.distanceKm != null && <span><Path size={17}/>{number(hit.distanceKm)} км</span>}
        {hit.duration && <span><Clock size={17}/>{hit.duration}</span>}
        {hit.accessStatus === 'closed' && <span className={`${styles.access} ${styles.closed}`}>Посещение закрыто</span>}
        {hit.accessStatus === 'restricted' && <span className={styles.access}>Есть ограничения</span>}
        {hit.missingGeometry && <span>Трек не добавлен</span>}
        {hit.unspecifiedParameters && <span className={styles.access}>Не все параметры указаны</span>}
      </div>}
    </div>
    <ArrowRight className={styles.arrow} size={21}/>
  </a></li>;
}

export function SiteSearch({initialState}: {initialState: SearchViewState}) {
  const [query, setQuery] = useState(initialState.query), [kind, setKind] = useState(initialState.kind);
  const [includeUnspecified, setIncludeUnspecified] = useState(initialState.includeUnspecified), [requestedPage, setPage] = useState(initialState.page);
  const deferredQuery = useDeferredValue(query);
  const response = useMemo(() => searchSite(deferredQuery, {kind, includeUnspecified}), [deferredQuery, kind, includeUnspecified]);
  const page = useMemo(() => searchResultPage(response.results, requestedPage), [response.results, requestedPage]);
  const input = useRef<HTMLInputElement>(null), heading = useRef<HTMLHeadingElement>(null), mounted = useRef(false);
  const pending = query !== deferredQuery;
  const state: SearchViewState = {query, kind, includeUnspecified, page: page.page};

  useEffect(() => {
    mounted.current = true;
    if (location.hash === '#search-query') input.current?.focus({preventScroll: true});
    const navigate = () => {
      const next = readSearchState(new URLSearchParams(location.search));
      setQuery(next.query); setKind(next.kind); setIncludeUnspecified(next.includeUnspecified); setPage(next.page);
    };
    window.addEventListener('popstate', navigate);
    return () => { mounted.current = false; window.removeEventListener('popstate', navigate); };
  }, []);

  useEffect(() => {
    if (!mounted.current || pending) return;
    history.replaceState(history.state, '', location.pathname + searchStateQuery({query: deferredQuery, kind, includeUnspecified, page: page.page}));
  }, [deferredQuery, kind, includeUnspecified, page.page, pending]);

  function changeQuery(value: string) { setQuery(value.slice(0, 160)); setPage(1); }
  function chooseSuggestion(value: string) { changeQuery(value); setKind('all'); setIncludeUnspecified(true); input.current?.focus({preventScroll: true}); }
  function submit(event: React.FormEvent) {
    event.preventDefault(); setPage(1);
    history.pushState(history.state, '', location.pathname + searchStateQuery({...state, page: 1}));
    heading.current?.focus({preventScroll: true});
  }
  function navigatePage(event: React.MouseEvent<HTMLAnchorElement>, value: number) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); setPage(value);
    history.pushState(history.state, '', location.pathname + searchStateQuery({...state, page: value}));
    heading.current?.focus({preventScroll: true});
    heading.current?.scrollIntoView({block: 'start'});
  }
  const pageHref = (value: number) => searchStateQuery({...state, page: value}) || '?';

  return <main id="main" className={styles.page}>
    <div className={styles.intro}><div className={styles.introMark} aria-hidden="true"><MagnifyingGlass size={32}/></div><div><h1 className="heading-3">Поиск по Тропнику</h1><p className="body-3">Маршруты, места и полезные страницы. Начните с названия или опишите, куда хочется отправиться.</p></div></div>
    <form className={styles.form} onSubmit={submit} role="search" aria-label="Поиск по сайту">
      <label className="sr-only" htmlFor="search-query">Маршрут, место или вопрос</label>
      <div className={styles.field}><MagnifyingGlass size={22} aria-hidden="true"/><input id="search-query" ref={input} data-site-search-input type="search" name="q" maxLength={160} autoComplete="off" enterKeyHint="search" placeholder="Например, Байкал до 15 км" value={query} onChange={event => changeQuery(event.target.value)} aria-controls="site-search-results"/>{query && <button className={styles.clear} type="button" aria-label="Очистить поиск" onClick={() => {changeQuery(''); input.current?.focus();}}><X size={20}/></button>}</div>
      <button className={`button primary ${styles.submit}`} type="submit">Найти <ArrowRight size={20}/></button>
    </form>
    <div className={`${styles.suggestions} caption-4`}><span>Попробуйте</span>{suggestions.map(value => <button type="button" key={value} onClick={() => chooseSuggestion(value)}>{value}</button>)}</div>
    <div className={styles.controls}>
      <h2 className="heading-6" ref={heading} tabIndex={-1} aria-live="polite" aria-atomic="true">{pending ? 'Ищем…' : query.trim() ? `Найдено: ${number(response.total)}` : `${kindLabels[kind]}: ${number(response.total)}`}</h2>
      <label className={`${styles.kind} body-6`} htmlFor="search-kind">Показать<select id="search-kind" value={kind} onChange={event => {setKind(event.target.value as SearchViewState['kind']); setPage(1);}}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    {response.appliedFilters.length > 0 && <div className={`${styles.refinement} body-6`}>
      <div className={styles.filterTags}><span>Условия поиска</span>{response.appliedFilters.map((value, index) => <span className={styles.filterTag} key={`${index}:${value}`}>{value}</span>)}</div>
      <label className={styles.include}><input type="checkbox" checked={includeUnspecified} onChange={event => {setIncludeUnspecified(event.target.checked); setPage(1);}}/><span>Показывать также маршруты, где часть параметров не указана{response.unspecifiedCount > 0 ? ` (${number(response.unspecifiedCount)})` : ''}. Их соответствие этим условиям нужно уточнить.</span></label>
    </div>}
    {response.correctedQuery && <p className={`${styles.correction} body-6`}>Показаны совпадения для <button type="button" onClick={() => changeQuery(response.correctedQuery!)}>«{response.correctedQuery}»</button></p>}
    <section id="site-search-results" aria-label="Результаты поиска" aria-busy={pending}>
      {page.items.length ? <ul className={styles.results}>{page.items.map(hit => <Result key={`${hit.kind}:${hit.id}`} hit={hit}/>)}</ul> : <div className={styles.empty}><h3 className="heading-5">Пока ничего не нашлось</h3><p className="body-3">Попробуйте другое название, более короткий запрос или выберите все материалы. Можно также посмотреть направления на карте.</p><div className="button-row"><button className="button secondary" type="button" onClick={() => {setKind('all'); setIncludeUnspecified(true); changeQuery('');}}>Показать всё</button><Link prefetch={false} className="text-link" href="/">Открыть карту <ArrowRight size={18}/></Link></div></div>}
      {response.total > 0 && <div className={styles.pagination}><p className="caption-4">{number(page.start + 1)}–{number(page.end)} из {number(response.total)}</p>{page.pages > 1 && <nav className={`${styles.pages} body-5`} aria-label="Страницы результатов">
        {page.page > 1 && <a href={pageHref(page.page - 1)} aria-label="Предыдущая страница" onClick={event => navigatePage(event, page.page - 1)}><ArrowLeft size={19}/></a>}
        {searchPageNumbers(page.page, page.pages).map((value, index) => value === 'gap' ? <span className={styles.gap} aria-hidden="true" key={`gap:${index}`}>…</span> : <a key={value} className={value !== 1 && value !== page.pages && value !== page.page ? styles.neighbor : undefined} href={pageHref(value)} aria-current={value === page.page ? 'page' : undefined} aria-label={`Страница ${value}`} onClick={event => navigatePage(event, value)}>{value}</a>)}
        {page.page < page.pages && <a href={pageHref(page.page + 1)} aria-label="Следующая страница" onClick={event => navigatePage(event, page.page + 1)}><ArrowRight size={19}/></a>}
      </nav>}</div>}
    </section>
  </main>;
}
