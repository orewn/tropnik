'use client';

import {lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {Header} from './Header';
import {Footer} from './Footer';
import {ArrowRight, BookmarkSimple, DownloadSimple, Flag, MapPin, Path, Plus, Trash, X} from './TropnikIcons';
import type {PlannerMapPoint} from '@/lib/map-types';
import {regions, trails, trailById, regionById, type Trail} from '@/lib/content';
import {loadPublicJSON} from '@/lib/map-preload';
import connectionData from '@/lib/trail-connections.generated.json';
import {getTrailConnections, getTrailEndpoints, normalizeTrailGeometry, planTrailSequence, preparePlanGeometry, resolvePreparedPlanGeometry, type CompositePlanOptions, type TrailConnection, type TrailConnectionIndex, type TrailEndpoint} from '@/lib/trail-connections';
import {createHikeDraft, validateHikeDraft, serializeHikeDraft, exportHikeGpx, getHikeGpxExportState, hikeDraftPathKey, safeHikeFilename, type HikeDraft} from '@/lib/hike-draft';
import styles from './HikePlanner.module.css';

const PlannerAtlas = lazy(() => import('./Atlas2D').then(module => ({default: module.Atlas2D})));
const index = connectionData as unknown as TrailConnectionIndex;
const catalogue = trails.filter(trail => index.routes[trail.id]);
const storageKey = 'tropnik-hike-plans-v1';
const storageEvent = 'tropnik-hike-plans-change';
const colors = ['#244d3c', '#b16c38', '#486c97', '#785781'];
const kindLabels = {terminal: 'Окончание', junction: 'Развилка', loop: 'Точка на линии'};
const noRegionChange = () => {};
const emptyGeometry: Record<string, unknown> = {};
const km = (meters: number) => (meters / 1000).toLocaleString('ru-RU', {minimumFractionDigits: 1, maximumFractionDigits: 2});
const coords = (point: readonly number[]) => `${point[1].toFixed(5)}, ${point[0].toFixed(5)}`;
const pointLabel = (point: TrailEndpoint) => `${kindLabels[point.kind]} · ${coords(point.point)}${index.routes[point.id.split('@')[0]]?.componentCount > 1 ? ` · часть ${point.component + 1}` : ''}`;
const plural = (number: number, forms: [string, string, string]) => forms[number % 100 >= 11 && number % 100 <= 14 ? 2 : number % 10 === 1 ? 0 : number % 10 >= 2 && number % 10 <= 4 ? 1 : 2];
function endpointById(id: string): TrailEndpoint | undefined {
  const [trailId, suffix] = id.split('@'), node = Number(suffix), value = index.routes[trailId]?.nodes[node];
  return value ? {id, node, point: [value[0], value[1]], component: value[2], degree: value[3], kind: value[3] === 1 ? 'terminal' : value[3] > 2 ? 'junction' : 'loop'} : undefined;
}
function endpointOptions(trailId: string | undefined, selected: string | undefined): TrailEndpoint[] {
  if (!trailId) return []; const points = getTrailEndpoints(index, trailId);
  const current = selected && endpointById(selected);
  if (current && !points.some(point => point.id === current.id)) points.push(current);
  return points;
}
const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить действие. Попробуйте ещё раз.';
function connectionLabel(connection: TrailConnection) {
  if (connection.kind === 'nearby') return `Рядом · ${Math.max(1, Math.round(connection.gapM))} м по прямой`;
  if (connection.kind === 'shared') return `Общий участок · ${Math.round(connection.sharedLengthM ?? 0)} м`;
  return connection.sourceVertex ? 'Есть общая точка' : 'Линии пересекаются';
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {if (event.key === storageKey) listener();};
  window.addEventListener('storage', storage); window.addEventListener(storageEvent, listener);
  return () => {window.removeEventListener('storage', storage); window.removeEventListener(storageEvent, listener);};
}
function savedSnapshot() {try {return localStorage.getItem(storageKey) || '[]';} catch {return '[]';}}
function download(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], {type})), link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
type Picker = {stage: number; role: 'start' | 'finish' | 'via'};

export function HikePlanner({initialTrailId}: {initialTrailId?: string}) {
  const [draft, setDraft] = useState<HikeDraft>(() => createHikeDraft(index, initialTrailId && Object.hasOwn(index.routes, initialTrailId) ? initialTrailId : undefined));
  const [query, setQuery] = useState(''), [regionFilter, setRegionFilter] = useState('');
  const [relatedQuery, setRelatedQuery] = useState(''), [showNearby, setShowNearby] = useState(true);
  const [connectionChoice, setConnectionChoice] = useState<Record<string, string>>({});
  const [geometryResult, setGeometryResult] = useState<{key: string; values: Record<string, unknown>; error: string}>({key: '', values: emptyGeometry, error: ''});
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState(''), [picker, setPicker] = useState<Picker | null>(null);
  const [mapNote, setMapNote] = useState('');
  const [removedPlan, setRemovedPlan] = useState<HikeDraft | null>(null);
  const fileInput = useRef<HTMLInputElement>(null), mapSection = useRef<HTMLElement>(null);
  const savedRaw = useSyncExternalStore(subscribe, savedSnapshot, () => '[]');
  const saved = useMemo(() => {
    try {const items: unknown = JSON.parse(savedRaw); return Array.isArray(items) ? items.filter(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string') as HikeDraft[] : [];} catch {return [];}
  }, [savedRaw]);
  const trailIds = draft.stages.map(stage => stage.trailId), geometryKey = [...new Set(trailIds)].sort().join('|');
  const loadKey = `${geometryKey}:${retry}`;
  const loading = !!geometryKey && geometryResult.key !== loadKey;
  const loadedGeometry = geometryResult.key === loadKey ? geometryResult.values : emptyGeometry;
  const geometryError = geometryResult.key === loadKey ? geometryResult.error : '';
  useEffect(() => {
    let cancelled = false;
    const ids = geometryKey ? geometryKey.split('|') : [];
    if (!ids.length) return;
    Promise.all(ids.map(async id => {const route = index.routes[id]; return [id, await loadPublicJSON(`${route.geometryUrl}?sha256=${route.sha256}${retry ? `&attempt=${retry}` : ''}`)] as const;}))
      .then(entries => {if (!cancelled) setGeometryResult({key: loadKey, values: Object.fromEntries(entries), error: ''});})
      .catch(error => {if (!cancelled) setGeometryResult({key: loadKey, values: emptyGeometry, error: `Не удалось загрузить линии этапов. ${message(error)}`});});
    return () => {cancelled = true;};
  }, [geometryKey, loadKey, retry]);

  const pathKey = hikeDraftPathKey(draft);
  const pathOptions = useMemo<CompositePlanOptions>(() => JSON.parse(pathKey), [pathKey]);
  const plan = useMemo(() => planTrailSequence(index, pathOptions), [pathOptions]);
  const preparedGeometry = useMemo(() => preparePlanGeometry(index, loadedGeometry), [loadedGeometry]);
  const resolved = useMemo(() => resolvePreparedPlanGeometry(index, plan, preparedGeometry), [plan, preparedGeometry]);
  const gpxExport = useMemo(() => getHikeGpxExportState(draft, plan, resolved), [draft, plan, resolved]);
  const first = draft.stages[0], last = draft.stages[draft.stages.length - 1];
  const firstId = first?.trailId, lastId = last?.trailId;
  const startPoints = useMemo(() => endpointOptions(firstId, draft.start), [firstId, draft.start]);
  const finishPoints = useMemo(() => endpointOptions(lastId, draft.finish), [lastId, draft.finish]);
  const suggestions = useMemo(() => {
    const search = query.trim().toLocaleLowerCase('ru');
    return catalogue.filter(trail => (!regionFilter || trail.regionId === regionFilter || trail.regionIds?.includes(regionFilter)) && (!search || `${trail.title} ${trail.subtitle} ${trail.id}`.toLocaleLowerCase('ru').includes(search))).slice(0, 12);
  }, [query, regionFilter]);
  const related = useMemo(() => {
    if (!lastId) return [];
    const groups = new Map<string, ReturnType<typeof getTrailConnections>>();
    for (const candidate of getTrailConnections(index, lastId)) {
      if (!showNearby && !candidate.connection.sourceVertex) continue;
      const trail = trailById(candidate.otherTrailId); if (!trail) continue;
      if (relatedQuery && !`${trail.title} ${trail.subtitle}`.toLocaleLowerCase('ru').includes(relatedQuery.toLocaleLowerCase('ru'))) continue;
      const list = groups.get(trail.id) || []; list.push(candidate); groups.set(trail.id, list);
    }
    return [...groups.entries()].map(([id, choices]) => ({trail: trailById(id)!, choices}));
  }, [lastId, relatedQuery, showNearby]);

  const update = useCallback((change: Partial<HikeDraft>) => {setDraft(current => ({...current, ...change, updatedAt: new Date().toISOString()})); setNotice('');}, []);
  function startWith(trailId: string) {setDraft(createHikeDraft(index, trailId)); setPicker(null); setNotice('Выберите начало и конец пути. Затем можно добавить связанную тропу.');}
  function addTrail(trailId: string, entryConnectionId: string) {
    if (draft.stages.length >= 20) {setNotice('В одном плане можно собрать до 20 этапов.'); return;}
    update({stages: [...draft.stages, {trailId, day: last?.day ?? 1, entryConnectionId, via: []}], finish: undefined});
    setPicker(null); setRelatedQuery('');
  }
  function removeFrom(position: number) {
    update({stages: draft.stages.slice(0, position), finish: undefined, ...(position === 0 ? {start: undefined} : {})}); setPicker(null);
  }
  const choosePoint = useCallback((id: string, target: Picker) => {
    setDraft(current => {
      const stage = current.stages[target.stage];
      if (!stage || !id.startsWith(`${stage.trailId}@`) || target.role === 'via' && (stage.via?.length ?? 0) >= 10) return current;
      const change = target.role === 'via'
        ? {stages: current.stages.map((item, i) => i === target.stage ? {...item, via: [...(item.via || []), id]} : item)}
        : {[target.role]: id};
      return {...current, ...change, updatedAt: new Date().toISOString()};
    });
    setNotice(''); setPicker(null);
  }, []);
  function openPicker(target: Picker) {
    setPicker(target); mapSection.current?.scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center'});
  }
  function useExample() {
    const a = 'osm-relation-4509476', b = 'osm-relation-4509477';
    const connection = getTrailConnections(index, a).find(candidate => candidate.otherTrailId === b && candidate.connection.sourceVertex);
    const start = getTrailEndpoints(index, a).find(point => Math.abs(point.point[0] - 29.6918809) < 1e-7 && Math.abs(point.point[1] - 61.1824994) < 1e-7);
    const finish = getTrailEndpoints(index, b).find(point => Math.abs(point.point[0] - 29.7082878) < 1e-7 && Math.abs(point.point[1] - 61.1767617) < 1e-7);
    if (!connection || !start || !finish) {setNotice('Пример недоступен для текущих исходных данных. Выберите тропу из каталога.'); return;}
    setDraft({...createHikeDraft(index, a), name: 'Поля-Ястребиное → Жёлтый', stages: [{trailId: a, day: 1, via: []}, {trailId: b, day: 1, entryConnectionId: connection.connection.id, via: []}], start: start.id, finish: finish.id});
    setPicker(null); setNotice('Пример собран по частям двух троп. Проверьте выбранные участки на карте.');
  }
  function save() {
    try {
      const validated = validateHikeDraft(draft, index);
      if (saved.length >= 20 && !saved.some(item => item.id === validated.id)) throw new Error('На устройстве уже 20 планов. Этот поход можно сохранить в JSON. Существующие планы сохранены.');
      const next = [validated, ...saved.filter(item => item.id !== validated.id)];
      localStorage.setItem(storageKey, JSON.stringify(next)); window.dispatchEvent(new Event(storageEvent));
      setNotice('План сохранён в этом браузере. Для переноса на другое устройство скачайте JSON.');
    } catch (error) {setNotice(message(error));}
  }
  function removeSaved(item: HikeDraft) {
    try {localStorage.setItem(storageKey, JSON.stringify(saved.filter(plan => plan.id !== item.id))); window.dispatchEvent(new Event(storageEvent)); setRemovedPlan(item); setNotice('План убран из сохранённых. Его можно вернуть.');}
    catch (error) {setNotice(message(error));}
  }
  function restoreSaved() {
    if (!removedPlan) return;
    try {
      if (saved.length >= 20) throw new Error('Для восстановления освободите место среди сохранённых планов.');
      localStorage.setItem(storageKey, JSON.stringify([removedPlan, ...saved.filter(item => item.id !== removedPlan.id)])); window.dispatchEvent(new Event(storageEvent)); setRemovedPlan(null); setNotice('План восстановлен.');
    } catch (error) {setNotice(message(error));}
  }
  async function importPlan(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Файл плана должен быть меньше 2 МБ.');
      setDraft(validateHikeDraft(JSON.parse(await file.text()), index)); setPicker(null);
      setNotice('План открыт из файла. Сохраните его, чтобы оставить в этом браузере.');
    } catch (error) {setNotice(message(error));}
    if (fileInput.current) fileInput.current.value = '';
  }
  function exportFile(format: 'gpx' | 'json') {
    try {
      const content = format === 'gpx' ? exportHikeGpx(draft, plan, resolved) : serializeHikeDraft(draft);
      download(content, `${safeHikeFilename(draft.name)}.${format}`, format === 'gpx' ? 'application/gpx+xml;charset=utf-8' : 'application/json;charset=utf-8');
      setNotice(format === 'gpx' ? 'GPX содержит выбранные участки. Отсутствующие переходы остаются разрывами между сегментами.' : 'Файл плана подготовлен. Его можно открыть в конструкторе на другом устройстве.');
    } catch (error) {setNotice(message(error));}
  }

  const mapPoints = useMemo<PlannerMapPoint[]>(() => {
    const result: PlannerMapPoint[] = [];
    const add = (id: string | undefined, kind: PlannerMapPoint['kind'], label: string) => {
      if (!id) return; const [trailId, number] = id.split('@'), node = index.routes[trailId]?.nodes[Number(number)];
      if (node) result.push({id: `${kind}-${id}-${result.length}`, point: [node[0], node[1]], kind, label: `${label}: ${coords(node)}`});
    };
    pathOptions.connectionIds.forEach((connectionId, i) => {
      const connection = index.connections.find(item => item.id === connectionId); if (!connection) return;
      result.push({id: `join-${i}`, point: connection.a.point, kind: 'join', label: `Стык этапов ${i + 1} и ${i + 2}: ${connectionLabel(connection)}`});
      if (connection.gapM > 0) result.push({id: `join-end-${i}`, point: connection.b.point, kind: 'join', label: `Другой конец перехода: ${Math.round(connection.gapM)} м по прямой`});
    });
    pathOptions.trailIds.forEach((_id, i) => (pathOptions.via?.[i] || []).forEach(id => add(id, 'via', `Через, этап ${i + 1}`)));
    add(pathOptions.start, 'start', 'Старт'); add(pathOptions.finish, 'finish', 'Финиш');
    if (picker && pathOptions.trailIds[picker.stage]) for (const endpoint of getTrailEndpoints(index, pathOptions.trailIds[picker.stage])) {
      result.push({id: `choice-${endpoint.id}`, point: endpoint.point, kind: 'choice', label: `Выбрать: ${pointLabel(endpoint)}`, onSelect: () => choosePoint(endpoint.id, picker)});
    }
    return result;
  }, [pathOptions, picker, choosePoint]);
  const mapTrail = useMemo<Trail | undefined>(() => {
    const source = firstId && trailById(firstId); if (!source || !loadedGeometry[source.id]) return;
    const sourceIds = picker ? [plan.trailIds[picker.stage]] : resolved.features.length ? [] : plan.trailIds;
    const sourceFeatures = sourceIds.flatMap(trailId => normalizeTrailGeometry(loadedGeometry[trailId]).parts.map(coordinates => ({type: 'Feature', properties: {stage: plan.trailIds.indexOf(trailId), preview: !!picker}, geometry: {type: 'LineString', coordinates}})));
    const geometry = {type: 'FeatureCollection', features: [...sourceFeatures, ...resolved.features]};
    return {...source, id: 'composite-plan', title: 'План похода', geometryUrl: geometry ? undefined : source.geometryUrl, geometry, distanceKm: plan.knownDistanceM / 1000};
  }, [firstId, resolved, loadedGeometry, plan, picker]);
  const days = [...new Set(draft.stages.map(stage => stage.day))];
  const canExportGpx = !loading && !geometryError && gpxExport.canExport;
  const issues = [...plan.issues, ...(loading ? [] : resolved.issues)].filter((item, position, items) => items.findIndex(other => other.code === item.code && other.trailId === item.trailId && other.connectionId === item.connectionId) === position);
  const ready = canExportGpx && plan.complete && plan.geometryContinuous;

  return <>
    <Header active="planner"/>
    <main id="main" className={styles.page}>
      <header className={styles.heading}>
        <div><span className={styles.eyebrow}>Подготовка маршрута</span><h1>Конструктор похода</h1><p>Соединяйте участки троп, выбирайте переходы и собирайте свой путь по дням.</p></div>
        <button type="button" className="button secondary" onClick={useExample}><Path size={20}/>Открыть пример</button>
      </header>
      <div className={styles.toolbar}>
        <label className={styles.name}>Название похода<input value={draft.name} maxLength={120} onChange={event => update({name: event.target.value})} placeholder="Мой составной поход"/></label>
        <div className={styles.toolbarActions}>
          <button type="button" className="button primary" disabled={!draft.stages.length} onClick={save}><BookmarkSimple size={18}/>Сохранить</button>
          <button type="button" className="button secondary" disabled={!canExportGpx} title={gpxExport.canExport ? undefined : gpxExport.reason} onClick={() => exportFile('gpx')}><DownloadSimple size={18}/>{plan.gaps.length ? 'GPX участков' : 'Скачать GPX'}</button>
          <details className={styles.fileMenu}><summary>Файлы и планы</summary><div>
            <button type="button" onClick={() => exportFile('json')} disabled={!draft.stages.length}>Скачать план JSON</button>
            <button type="button" onClick={() => fileInput.current?.click()}>Открыть файл плана</button>
            <button type="button" onClick={event => {event.currentTarget.closest('details')?.removeAttribute('open'); setDraft(createHikeDraft(index)); setPicker(null); setNotice('Новый план. Сохранённые походы доступны ниже.');}}>Новый план</button>
            {saved.length > 0 && <><strong>Сохранено на устройстве</strong>{saved.map(item => <div className={styles.savedRow} key={item.id}><button type="button" onClick={event => {event.currentTarget.closest('details')?.removeAttribute('open'); try {setDraft(validateHikeDraft(item, index)); setPicker(null); setNotice('Открыт сохранённый план.');} catch (error) {setNotice(message(error));}}}>{item.name || 'Поход без названия'}</button><button type="button" aria-label={`Скачать сохранённый план ${item.name}`} onClick={() => download(JSON.stringify(item, null, 2), `${safeHikeFilename(item.name)}.json`, 'application/json;charset=utf-8')}><DownloadSimple size={17}/></button><button type="button" aria-label={`Убрать сохранённый план ${item.name}`} onClick={() => removeSaved(item)}><Trash size={17}/></button></div>)}</>}
          </div></details>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label="Файл плана похода" onChange={event => void importPlan(event.target.files?.[0])}/>
        </div>
      </div>
      {notice && <div role="status" className={styles.notice}><span>{notice}</span><button type="button" aria-label="Закрыть сообщение конструктора" onClick={() => setNotice('')}><X size={18}/></button></div>}
      {removedPlan && <div className={styles.undo}><span>Убран план «{removedPlan.name}».</span><button type="button" onClick={restoreSaved}>Вернуть план</button><button type="button" onClick={() => download(JSON.stringify(removedPlan, null, 2), `${safeHikeFilename(removedPlan.name)}.json`, 'application/json;charset=utf-8')}>Скачать копию</button></div>}
      <section className={styles.summary} aria-label="Итог похода">
        <div><strong>{draft.stages.length ? km(plan.knownDistanceM) : '—'}<small> км</small></strong><span>по выбранным линиям</span></div>
        <div><strong>{draft.stages.length}<small> {plural(draft.stages.length, ['этап', 'этапа', 'этапов'])}</small></strong><span>{days.length ? `${days.length} ${plural(days.length, ['день', 'дня', 'дней'])} в плане` : 'Дни ещё не выбраны'}</span></div>
        <div className={styles.summaryStatus}><span className={ready ? styles.goodDot : styles.pendingDot}/><div><b>{!first ? 'Начните с первой тропы' : loading ? 'Загружаем геометрию' : ready ? 'Линия собрана' : plan.gaps.length ? `${plural(plan.gaps.length, ['Непроверенный переход', 'Непроверенные переходы', 'Непроверенные переходы'])}: ${plan.gaps.length}` : 'Выберите точки пути'}</b><span>{ready ? 'Доступ и условия проверьте перед выходом.' : 'Переходы без трека не входят в километраж.'}</span></div></div>
      </section>
      <div className={styles.workspace}>
        <section className={styles.editor} aria-labelledby="stages-heading">
          <div className={styles.sectionHeading}><h2 id="stages-heading">{first ? 'Этапы похода' : 'С какой тропы начнём?'}</h2><span>{first ? `${draft.stages.length} / 20` : `${index.stats.geometryRoutes} с линией`}</span></div>
          {!first ? <>
            <label className={styles.field}>Найти тропу<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Название или место"/></label>
            <label className={styles.field}>Направление<select value={regionFilter} onChange={event => setRegionFilter(event.target.value)}><option value="">Все направления</option>{regions.map(region => <option value={region.id} key={region.id}>{region.name}</option>)}</select></label>
            <div className={styles.catalogue}>{suggestions.map(trail => <button type="button" key={trail.id} onClick={() => startWith(trail.id)}><span><b>{trail.title}</b><small>{regionById(trail.regionId)?.name} · стыков: {getTrailConnections(index, trail.id).length}</small></span><ArrowRight size={20}/></button>)}</div>
            {!suggestions.length && <p className={styles.empty}>Подходящих троп с геометрией нет. Измените запрос или направление.</p>}
            <p className={styles.help}>{index.stats.missingGeometryRoutes} {plural(index.stats.missingGeometryRoutes, ['карточка', 'карточки', 'карточек'])} пока без линии. Их нельзя использовать для расчёта пути.</p>
          </> : <>
            <label className={styles.field}>Старт<select aria-label="Старт похода" value={draft.start || ''} onChange={event => update({start: event.target.value || undefined})}><option value="">Выберите точку первой тропы</option>{startPoints.map(point => <option key={point.id} value={point.id}>{pointLabel(point)}</option>)}</select></label>
            <button type="button" className={styles.mapPick} onClick={() => openPicker({stage: 0, role: 'start'})}><MapPin size={17}/>Выбрать старт на карте</button>
            <ol className={styles.stages}>
              {draft.stages.map((stage, i) => {
                const trail = trailById(stage.trailId)!, points = getTrailEndpoints(index, stage.trailId);
                const join = i ? index.connections.find(connection => connection.id === stage.entryConnectionId) : undefined;
                const alternatives = i ? getTrailConnections(index, draft.stages[i - 1].trailId).filter(candidate => candidate.otherTrailId === stage.trailId) : [];
                return <li key={`${i}-${stage.trailId}`} className={styles.stage}>
                  {join && <div className={styles.join}><span>{connectionLabel(join)}</span>{alternatives.length > 1 && <select aria-label={`Стык перед этапом ${i + 1}`} value={stage.entryConnectionId} onChange={event => update({stages: draft.stages.map((item, n) => n === i ? {...item, entryConnectionId: event.target.value} : item)})}>{alternatives.map((candidate, n) => <option key={candidate.connection.id} value={candidate.connection.id}>{n + 1}. {connectionLabel(candidate.connection)} · {coords(candidate.from.point)}</option>)}</select>}{!join.sourceVertex && <small>Переход не подтверждён. Проверьте его отдельно.</small>}</div>}
                  <div className={styles.stageTitle}><span className={styles.number} style={{background: colors[i % colors.length]}}>{i + 1}</span><h3><a href={`/routes/${trail.id}`}>{trail.title}</a></h3><button type="button" aria-label={`Убрать этап ${i + 1} и следующие`} title="Убрать этот и следующие этапы" onClick={() => removeFrom(i)}><Trash size={17}/></button></div>
                  <div className={styles.stageMeta}><span>{plan.stages[i]?.connected ? `${km(plan.stages[i].distanceM)} км выбранного пути` : 'Путь ещё не определён'}</span><label>День<select aria-label={`День этапа ${i + 1}`} value={stage.day} onChange={event => {const day = Number(event.target.value); update({stages: draft.stages.map((item, n) => n < i ? item : {...item, day: n === i ? day : Math.max(day, item.day)})});}}>{Array.from({length: 31}, (_, n) => n + 1).filter(day => day >= (draft.stages[i - 1]?.day ?? 1)).map(day => <option value={day} key={day}>{day}</option>)}</select></label></div>
                  {trail.accessStatus && trail.accessStatus !== 'unknown' && <p className={styles.restriction}>{trail.operatingNotice?.title || (trail.accessStatus === 'closed' ? 'Источник сообщает о закрытии' : 'Есть ограничения доступа')}</p>}
                  <details className={styles.via}><summary>Через… {stage.via?.length ? `(${stage.via.length})` : 'выбрать ветку'}</summary>
                    <p>Между точками выбирается кратчайший путь по линии. Для радиального выхода задайте точку возвращения. Повторный проход входит в километраж.</p>
                    {(stage.via || []).map((id, n) => <div className={styles.viaItem} key={`${id}-${n}`}><span>{n + 1}. {pointLabel(endpointById(id)!)}</span><button type="button" aria-label={`Убрать промежуточную точку ${n + 1} этапа ${i + 1}`} onClick={() => update({stages: draft.stages.map((item, at) => at === i ? {...item, via: item.via?.filter((_, atPoint) => atPoint !== n)} : item)})}><X size={16}/></button></div>)}
                    <select aria-label={`Добавить точку через на этапе ${i + 1}`} value="" disabled={(stage.via?.length || 0) >= 10} onChange={event => {if (event.target.value) choosePoint(event.target.value, {stage: i, role: 'via'});}}><option value="">Добавить обязательную точку</option>{points.map(point => <option value={point.id} key={point.id}>{pointLabel(point)}</option>)}</select>
                    <button type="button" className={styles.mapPick} disabled={(stage.via?.length || 0) >= 10} onClick={() => openPicker({stage: i, role: 'via'})}><MapPin size={16}/>Выбрать точку на карте</button>
                  </details>
                </li>;
              })}
            </ol>
            <label className={styles.field}>Финиш<select aria-label="Финиш похода" value={draft.finish || ''} onChange={event => update({finish: event.target.value || undefined})}><option value="">Выберите точку последней тропы</option>{finishPoints.map(point => <option key={point.id} value={point.id}>{pointLabel(point)}</option>)}</select></label>
            <button type="button" className={styles.mapPick} onClick={() => openPicker({stage: draft.stages.length - 1, role: 'finish'})}><Flag size={17}/>Выбрать финиш на карте</button>
            <label className={styles.field}>Заметки к походу<textarea rows={3} maxLength={5000} value={draft.notes} placeholder="Подъезд, вода, места остановок и вопросы для проверки" onChange={event => update({notes: event.target.value})}/></label>
            <p className={styles.help}>Дни задаются вручную. Места ночёвок в заметках — ваши отметки; допустимость стоянки нужно уточнить.</p>
          </>}
        </section>
        <section ref={mapSection} className={styles.mapSection} aria-label="Карта составного похода">
          <div className={styles.mapHeading}><h2>Ваш путь на карте</h2><span>{picker ? 'Исходная тропа и точки выбора' : resolved.features.length ? 'Выбранные участки' : first ? 'Исходные линии' : 'Выберите тропу или откройте пример'}</span></div>
          {picker && <div className={styles.picker} role="status"><span>Нажмите «+» на карте: {picker.role === 'start' ? 'старт' : picker.role === 'finish' ? 'финиш' : 'обязательная точка'} этапа {picker.stage + 1}</span><button type="button" onClick={() => setPicker(null)}>Отмена</button></div>}
          <div className={`explore-layout ${styles.map}`}>
            <Suspense fallback={<div className={styles.mapLoading}>Открываем карту…</div>}><PlannerAtlas planning region={first ? regionById(trailById(first.trailId)!.regionId) : undefined} trail={mapTrail} planPoints={mapPoints} onRegion={noRegionChange} onMapNote={setMapNote}/></Suspense>
          </div>
          <div className={styles.mapCaption}><span><i className={styles.startDot}/>Старт</span><span><i className={styles.finishDot}/>Финиш</span><span><i className={styles.joinDot}/>Стык</span><span>Разрывы не соединяются прямой</span></div>
          {mapNote && <div className={styles.mapNote} role="status"><span>{mapNote}</span><button type="button" aria-label="Закрыть сообщение карты" onClick={() => setMapNote('')}><X size={18}/></button></div>}
          {geometryError && <p className={styles.error} role="alert">{geometryError} <button type="button" onClick={() => setRetry(value => value + 1)}>Повторить загрузку</button></p>}
          {!loading && !geometryError && resolved.issues.length > 0 && <p className={styles.error} role="alert">Исходная линия не совпала с текущим планом. Экспорт остановлен. <button type="button" onClick={() => setRetry(value => value + 1)}>Загрузить свежие линии</button></p>}
        </section>
        <section className={styles.connections} aria-labelledby="connections-heading">
          <div className={styles.sectionHeading}><div><h2 id="connections-heading">{last ? 'Продолжить поход' : 'Как соединяются тропы'}</h2>{last && <p>Связи с тропой «{trailById(last.trailId)?.title}»</p>}</div><Path size={24}/></div>
          {!last ? <div className={styles.explanation}><p><b>Общая точка или участок.</b> Выберите место, где перейдёте с одной тропы на другую.</p><p><b>Пересечение линий или близость.</b> Конструктор покажет кандидата и оставит неподтверждённый переход отдельным разрывом.</p><p>Километраж считается по выбранным участкам. Условия доступа, переправы и состояние пути требуют отдельной проверки.</p></div> : <>
            <div className={styles.connectionFilters}><input aria-label="Поиск связанных троп" value={relatedQuery} onChange={event => setRelatedQuery(event.target.value)} placeholder="Поиск среди связанных троп"/><label><input type="checkbox" checked={showNearby} onChange={event => setShowNearby(event.target.checked)}/>Показывать переходы без подтверждённого стыка</label></div>
            <div className={styles.relatedList}>{related.slice(0, 16).map(({trail, choices}) => {
              const selected = choices.find(candidate => candidate.connection.id === connectionChoice[trail.id]) || choices[0];
              return <article key={trail.id} className={styles.relatedCard}>
                <span className={selected.connection.sourceVertex ? styles.connectionBadge : styles.gapBadge}>{connectionLabel(selected.connection)}</span>
                <h3>{trail.title}</h3><p>{trail.subtitle || regionById(trail.regionId)?.name}</p>
                {choices.length > 1 && <label>Точка перехода<select aria-label={`Точка перехода на ${trail.title}`} value={selected.connection.id} onChange={event => setConnectionChoice(current => ({...current, [trail.id]: event.target.value}))}>{choices.map((candidate, n) => <option key={candidate.connection.id} value={candidate.connection.id}>{n + 1}. {connectionLabel(candidate.connection)} · {coords(candidate.from.point)}</option>)}</select></label>}
                {!selected.connection.sourceVertex && <small>{selected.connection.kind === 'nearby' ? 'Длина и проходимость перехода неизвестны.' : 'Линии могут проходить на разных уровнях.'}</small>}
                <button type="button" className="button secondary" disabled={draft.stages.length >= 20} onClick={() => addTrail(trail.id, selected.connection.id)}><Plus size={17}/>{trailIds.includes(trail.id) ? 'Добавить повторный этап' : 'Добавить этап'}</button>
              </article>;
            })}</div>
            {!related.length && <p className={styles.empty}>Подходящих связей нет. Попробуйте изменить фильтр. Конструктор ищет соседние линии в пределах {index.parameters.nearbyMeters} м.</p>}
            {related.length > 16 && <p className={styles.help}>Показаны 16 из {related.length} троп. Уточните название, чтобы найти нужную.</p>}
          </>}
        </section>
      </div>
      {first && <section className={styles.review} aria-labelledby="review-heading">
        <div><h2 id="review-heading">Перед выходом</h2><p>Геометрия помогает составить план. Она не подтверждает открытый доступ и фактическую проходимость.</p></div>
        <div>{issues.length > 0 && <ul>{issues.map((issue, i) => <li key={`${issue.code}-${i}`}>{issue.trailId && <b>{trailById(issue.trailId)?.title}: </b>}{issue.message}</li>)}</ul>}
          {plan.gaps.length > 0 && <p>Разрывы по прямой: {plan.gaps.map(gap => `${Math.round(gap.distanceM)} м`).join(' · ')}. Эти расстояния не входят в пешеходный километраж.</p>}
          <details><summary>Источники и ограничения этапов</summary><ul>{[...new Set(trailIds)].map(id => {const trail = trailById(id)!; return <li key={id}><a href={trail.sourceUrl} target="_blank" rel="noreferrer">{trail.title} · {trail.sourceName}</a><span> · сведения проверены {trail.checkedAt}</span>{trail.operatingNotice && <p>{trail.operatingNotice.body}</p>}</li>;})}</ul></details>
          <a href="/safety/registration" className={styles.safetyLink}>Подготовить паспорт похода <ArrowRight size={17}/></a>
        </div>
      </section>}
      <p className={styles.storageNote}>Планы сохраняются только в этом браузере. JSON переносит настройки плана, GPX — рассчитанную линию. Связи проверены по {index.stats.geometryRoutes} исходным геометриям.</p>
    </main>
    <Footer/>
  </>;
}
