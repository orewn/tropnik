'use client';
import Link from 'next/link';

import {useCallback, useEffect, useRef, useState} from 'react';
import {UsersThree, Compass, ArrowRight, ArrowLeft, Plus, CalendarBlank, ShieldCheck, ArrowClockwise, ChatCircleDots, Star, Info, CheckCircle, UserCircle, Flag} from '@/components/TropnikIcons';
import {api, apiEnvelope, ApiError, AUTH_EVENT, announceAuth, errorText, isAbort, serviceStatus, type AuthChange, type User, type Route, type Departure, type RecruitmentRequest, type Review, type Participant} from '@/lib/api';
import {joinAllowed, startAllowed, reviewAllowed, routePolicy, zonedISO} from '@/lib/trip-policy';
import {AuthDialog} from './AuthDialog';
import {Modal} from './Modal';
import {ChatPanel} from './ChatPanel';
import {ReportDialog} from './ReportDialog';
import {regions, trails} from '@/lib/content';
import {deriveRouteCategories, type EventCategoryId} from '@/lib/event-categories';
import {EventCategoryIcon, RouteCategoryBadges} from './EventCategoryIcon';

const labels: Record<string, string> = {recruiting: 'Идёт набор', ready: 'Группа собрана', awaiting_guide: 'Нужен гид', in_progress: 'В пути', completed: 'Поход завершён', cancelled: 'Отменён', aborted: 'Поход прекращён', open: 'Ищем гида', accepted: 'Выход назначен'};
const membershipLabels: Record<Departure['membership'], string> = {none: 'Вы пока не в группе', confirmed: 'Участие подтверждено', checked_in: 'Явка подтверждена', cancelled: 'Вы вышли из группы', completed: 'Поход завершён', no_show: 'Явка на старт не подтверждена'};
type Selection = {kind: 'departures' | 'recruitment-requests'; id: string};
type Draft = {id: string; routeId: string; title: string; preferredDate: string; note: string; createdAt: string};
type Action = 'start' | 'complete' | 'cancel' | 'abort' | 'leave';
type WriteResult<T> = {ok: true; value: T} | {ok: false; error?: unknown};

function dateLabel(value: string, timeZone = 'Europe/Moscow') {
  try { return new Intl.DateTimeFormat('ru', {timeZone, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'}).format(new Date(value)); }
  catch { return 'Дата уточняется'; }
}

export function Trips({initialTab = 'departures'}: {initialTab?: 'departures' | 'requests' | 'drafts'}) {
  const [tab, setTab] = useState(initialTab);
  const [user, setUser] = useState<User | null>(null);
  const [auth, setAuth] = useState(false);
  const [service, setService] = useState<'checking' | 'configured' | 'preview' | 'unavailable'>('checking');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [departures, setDepartures] = useState<Departure[]>([]);
  const [requests, setRequests] = useState<RecruitmentRequest[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [routeCursor, setRouteCursor] = useState<string | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [current, setCurrent] = useState<Departure | null>(null);
  const [requestAccess, setRequestAccess] = useState(false);
  const [busy, setBusy] = useState('');
  const [create, setCreate] = useState(false);
  const [departureForm, setDepartureForm] = useState<{request: RecruitmentRequest | null} | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [rating, setRating] = useState(0);
  const [reviewBody, setReviewBody] = useState('');
  const [reviewTarget, setReviewTarget] = useState<'route' | 'guide'>('route');
  const [report, setReport] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{action: Action; version: number} | null>(null);
  const [routeId, setRouteId] = useState('');
  const [date, setDate] = useState('');
  const [body, setBody] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [zone, setZone] = useState('Europe/Moscow');
  const [capacity, setCapacity] = useState(8);
  const [minPeople, setMinPeople] = useState(4);
  const [now, setNow] = useState(0);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const actionSequence = useRef(0);
  const authEpoch = useRef(0);
  const listController = useRef<AbortController | null>(null);
  const routePageController = useRef<AbortController | null>(null);
  const routePageInFlight = useRef(false);
  const detailController = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const attempts = useRef<Record<string, {key: string; version: number}>>({});
  const closeAuth = useCallback(() => setAuth(false), []);
  const closeCreate = useCallback(() => { if (!inFlight.current) setCreate(false); }, []);
  const closeDeparture = useCallback(() => { if (!inFlight.current) setDepartureForm(null); }, []);
  const closeConfirm = useCallback(() => { if (!inFlight.current) setConfirm(null); }, []);
  const title = (id: string) => routes.find(route => route.id === id)?.title || trails.find(route => route.id === id)?.title || 'Маршрут';
  const routeCategories = (id: string, pinnedTitle?: string, revisionId?: string) => {
    const route = routes.find(item => item.id === id);
    if (route && (!revisionId || route.revisionId === revisionId)) return deriveRouteCategories(route);
    // Completed departures retain their own route revision; never label them from a newer description.
    if (pinnedTitle) return deriveRouteCategories({title: pinnedTitle});
    if (revisionId) return [];
    return deriveRouteCategories(trails.find(item => item.id === id));
  };
  const currentRequest = selected?.kind === 'recruitment-requests' ? requests.find(request => request.id === selected.id) : undefined;
  const chosenRoute = routes.find(route => route.id === (departureForm?.request?.routeId || routeId));
  const policy = routePolicy(chosenRoute);

  const choose = useCallback((value: Selection | null) => {
    ++detailSequence.current;
    detailController.current?.abort();
    setSelected(value);
    setCurrent(null);
    setParticipants([]);
    setReviews([]);
    setRequestAccess(false);
    setConfirm(null);
    setRating(0);
    setReviewBody('');
    setReviewTarget('route');
    setReport(null);
    setError('');
  }, []);

  const load = useCallback(async () => {
    const request = ++listSequence.current;
    listController.current?.abort();
    routePageController.current?.abort();
    routePageInFlight.current = false;
    setRouteCursor(null);
    setRouteLoading(false);
    const controller = new AbortController();
    listController.current = controller;
    setLoading(true);
    try {
      const connected = await serviceStatus(controller.signal);
      if (request !== listSequence.current) return;
      setService(connected ? 'configured' : 'preview');
      if (!connected) { setUser(null); setRequests([]); setDepartures([]); setRoutes([]); return; }
      const [profile, routeList, departureList] = await Promise.allSettled([
        api<User>('me', {signal: controller.signal}),
        apiEnvelope<Route[]>('routes?limit=100', {signal: controller.signal}),
        api<Departure[]>('departures', {signal: controller.signal}),
      ]);
      if (request !== listSequence.current) return;
      let me: User | null = null;
      if (profile.status === 'fulfilled') { me = profile.value; setUser(me); }
      else {
        setUser(null);
        setRequests([]);
        if (!(profile.reason instanceof ApiError && profile.reason.status === 401)) setError(errorText(profile.reason));
      }
      if (routeList.status === 'fulfilled') {
        const page = routeList.value;
        setRoutes(previous => [...page.data, ...previous.filter(route => !page.data.some(next => next.id === route.id))]);
        setRouteCursor(page.meta?.nextCursor || null);
      }
      else setError(errorText(routeList.reason));
      if (departureList.status === 'fulfilled') setDepartures(departureList.value);
      else { setDepartures([]); if (!(departureList.reason instanceof ApiError && departureList.reason.status === 401)) setError(errorText(departureList.reason)); }
      if (me) {
        const items = await api<RecruitmentRequest[]>('recruitment-requests', {signal: controller.signal});
        if (request === listSequence.current) setRequests(items);
      }
    } catch (error) {
      if (!isAbort(error) && request === listSequence.current) { setError(errorText(error)); setService(previous => previous === 'checking' ? 'unavailable' : previous); }
    } finally { if (request === listSequence.current) setLoading(false); }
  }, []);

  const loadMoreRoutes = useCallback(async () => {
    if (!routeCursor || loading || routePageInFlight.current) return;
    const request = listSequence.current, epoch = authEpoch.current, cursor = routeCursor;
    const controller = new AbortController();
    routePageController.current = controller;
    routePageInFlight.current = true;
    setRouteLoading(true);
    try {
      const page = await apiEnvelope<Route[]>('routes?limit=100&cursor=' + encodeURIComponent(cursor), {signal: controller.signal});
      if (request !== listSequence.current || epoch !== authEpoch.current) return;
      if (page.meta?.nextCursor === cursor) throw new Error('route_cursor_stalled');
      setRoutes(previous => [...previous, ...page.data.filter(route => !previous.some(item => item.id === route.id))]);
      setRouteCursor(page.meta?.nextCursor || null);
    } catch (error) {
      if (!isAbort(error) && request === listSequence.current && epoch === authEpoch.current) setError(errorText(error));
    } finally {
      if (request === listSequence.current && epoch === authEpoch.current) {
        routePageInFlight.current = false;
        setRouteLoading(false);
      }
    }
  }, [routeCursor, loading]);

  useEffect(() => {
    const listEpoch = listSequence, detailEpoch = detailSequence, sessionEpoch = authEpoch;
    try {
      const local: unknown = JSON.parse(localStorage.getItem('tropa-requests') || '[]');
      // Hydrate local drafts after SSR; subsequent edits remain explicit user actions.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (Array.isArray(local)) setDrafts(local.filter((item): item is Draft => !!item && ['id', 'routeId', 'title', 'preferredDate', 'note', 'createdAt'].every(key => typeof item[key] === 'string')));
    } catch { setError('Не удалось прочитать черновики этого устройства.'); }
    const query = new URLSearchParams(window.location.search);
    const requestedTab = query.get('tab');
    if (requestedTab === 'requests' || requestedTab === 'drafts' || requestedTab === 'departures') setTab(requestedTab);
    if (query.get('request')) setSelected({kind: 'recruitment-requests', id: query.get('request')!});
    if (query.get('departure')) setSelected({kind: 'departures', id: query.get('departure')!});
    void load();
    const changed = (event: Event) => {
      ++authEpoch.current;
      ++actionSequence.current;
      inFlight.current = false;
      setBusy('');
      ++detailSequence.current;
      detailController.current?.abort();
      setCurrent(null); setParticipants([]); setReviews([]); setRequests([]); setRequestAccess(false); setConfirm(null); setDepartureForm(null);
      attempts.current = {};
      const detail = (event as CustomEvent<AuthChange>).detail;
      if (detail && Object.prototype.hasOwnProperty.call(detail, 'user')) setUser(detail.user);
      void load();
    };
    const storage = (event: StorageEvent) => { if (event.key === 'tropa-auth-change') changed(event); };
    window.addEventListener(AUTH_EVENT, changed);
    window.addEventListener('storage', storage);
    const clock = setInterval(() => setNow(Date.now()), 30000);
    setNow(Date.now());
    return () => {
      ++listEpoch.current; ++detailEpoch.current; ++sessionEpoch.current;
      listController.current?.abort(); routePageController.current?.abort(); detailController.current?.abort();
      window.removeEventListener(AUTH_EVENT, changed); window.removeEventListener('storage', storage); clearInterval(clock);
    };
  }, [load]);

  const userId = user?.id;
  const refreshDetail = useCallback(async () => {
    if (!selected || service !== 'configured') return;
    const request = ++detailSequence.current;
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setDetailLoading(true);
    try {
      if (selected.kind === 'departures') {
        const departure = await api<Departure>('departures/' + encodeURIComponent(selected.id), {signal: controller.signal});
        if (request !== detailSequence.current) return;
        setCurrent(departure);
        setReviewTarget(previous => departure.reviewTargets && !departure.reviewTargets.includes(previous) ? departure.reviewTargets[0] || previous : previous);
        const [written, roster] = await Promise.all([
          api<Review[]>('departures/' + encodeURIComponent(selected.id) + '/reviews', {signal: controller.signal}),
          departure.guideId === userId ? api<Participant[]>('departures/' + encodeURIComponent(selected.id) + '/participants', {signal: controller.signal}) : Promise.resolve([]),
        ]);
        if (request !== detailSequence.current) return;
        setReviews(written); setParticipants(roster);
      } else {
        if (!userId) { setRequestAccess(false); return; }
        const items = await api<RecruitmentRequest[]>('recruitment-requests', {signal: controller.signal});
        if (request !== detailSequence.current) return;
        setRequests(items);
        if (!items.some(item => item.id === selected.id)) { setError('Запрос недоступен или уже закрыт. Вернитесь к списку.'); setRequestAccess(false); return; }
        try {
          await api<unknown[]>('recruitment-requests/' + encodeURIComponent(selected.id) + '/messages', {signal: controller.signal});
          if (request === detailSequence.current) setRequestAccess(true);
        } catch (error) {
          if (request !== detailSequence.current || isAbort(error)) return;
          setRequestAccess(false);
          if (!(error instanceof ApiError && error.status === 403)) throw error;
        }
      }
    } catch (error) {
      if (!isAbort(error) && request === detailSequence.current) {
        setError(errorText(error)); setParticipants([]); setReviews([]); setRequestAccess(false);
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) setCurrent(null);
      }
    } finally { if (request === detailSequence.current) setDetailLoading(false); }
  }, [selected, service, userId]);

  // Clear the previous server entity before loading the newly selected item.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { const activeSequence = detailSequence; setCurrent(null); setParticipants([]); setReviews([]); setRequestAccess(false); void refreshDetail(); return () => { ++activeSequence.current; detailController.current?.abort(); }; }, [refreshDetail]);
  useEffect(() => {
    const id = current?.routeId || currentRequest?.routeId;
    if (!id || routes.some(route => route.id === id)) return;
    const controller = new AbortController();
    api<Route>('routes/' + encodeURIComponent(id), {signal: controller.signal}).then(route => setRoutes(previous => previous.some(item => item.id === route.id) ? previous : [...previous, route])).catch(error => { if (!isAbort(error)) setError(errorText(error)); });
    return () => controller.abort();
  }, [current?.routeId, currentRequest?.routeId, routes]);

  async function write<T>(path: string, data: unknown, options: {key?: string; skipDetail?: boolean} = {}): Promise<WriteResult<T>> {
    if (inFlight.current) return {ok: false};
    inFlight.current = true;
    const action = ++actionSequence.current;
    const epoch = authEpoch.current;
    setBusy(path); setError('');
    try {
      const value = await api<T>(path, {method: 'POST', body: JSON.stringify(data), ...(options.key ? {headers: {'Idempotency-Key': options.key}} : {})});
      if (epoch !== authEpoch.current) return {ok: false};
      // Each endpoint has its own result type. A Review must never replace Departure.
      if (!options.skipDetail) await refreshDetail();
      await load();
      if (epoch !== authEpoch.current) return {ok: false};
      return {ok: true, value};
    } catch (error) {
      if (epoch !== authEpoch.current) return {ok: false};
      setError(errorText(error));
      if (error instanceof ApiError && error.status === 401) { announceAuth(null); setAuth(true); }
      if (error instanceof ApiError && error.status === 409) { setConfirm(null); await refreshDetail(); }
      return {ok: false, error};
    } finally { if (action === actionSequence.current) { inFlight.current = false; setBusy(''); } }
  }

  async function join(departure: Departure) {
    if (!user) { setAuth(true); return; }
    if (!joinAllowed(departure, Date.now())) { setError('Присоединение сейчас недоступно. Обновите статус, состав и условия похода.'); return; }
    const attempt = attempts.current[departure.id] || (attempts.current[departure.id] = {key: crypto.randomUUID(), version: departure.version});
    const result = await write<Departure>('departures/' + encodeURIComponent(departure.id) + '/join', {expectedVersion: attempt.version}, {key: attempt.key});
    if (result.ok) { delete attempts.current[departure.id]; choose({kind: 'departures', id: departure.id}); }
    else if (result.error instanceof ApiError && result.error.status >= 400 && result.error.status < 500) delete attempts.current[departure.id];
  }

  function openDepartureForm(request: RecruitmentRequest | null) {
    const route = routes.find(item => item.id === request?.routeId);
    const limits = routePolicy(route);
    setRouteId(request?.routeId || '');
    setMinPeople(limits.minPeople); setCapacity(Math.min(Math.max(8, limits.minPeople), limits.maxGroupSize));
    setZone(regions.find(region => region.id === route?.regionId)?.timezone || 'Europe/Moscow');
    setStartsAt(''); setEndsAt(''); setError(''); setDepartureForm({request});
  }

  async function createRequest(event: React.FormEvent) {
    event.preventDefault();
    if (!user) { setAuth(true); return; }
    const result = await write<RecruitmentRequest>('recruitment-requests', {routeId, preferredDate: date || undefined, body: body.trim()}, {skipDetail: true});
    if (result.ok) { setCreate(false); setBody(''); choose({kind: 'recruitment-requests', id: result.value.id}); }
  }

  async function createDeparture(event: React.FormEvent) {
    event.preventDefault();
    if (!departureForm || !chosenRoute || !user) return;
    try {
      const start = zonedISO(startsAt, zone), end = zonedISO(endsAt, zone);
      if (Date.parse(start) <= Date.now() || Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 30 * 86400000) throw new Error('Выберите будущее начало и окончание позже начала, не более чем через 30 дней.');
      if (policy.requiredGuides !== 1 || !Number.isInteger(minPeople) || !Number.isInteger(capacity) || minPeople < policy.minPeople || capacity < minPeople || capacity > policy.maxGroupSize) throw new Error('Состав должен соответствовать утверждённым ограничениям маршрута.');
      const request = departureForm.request;
      const result = await write<Departure>(request ? 'recruitment-requests/' + encodeURIComponent(request.id) + '/accept' : 'departures', {routeId: chosenRoute.id, startsAt: start, endsAt: end, timeZone: zone, minPeople, capacity, routeRevisionId: chosenRoute.revisionId}, {skipDetail: true});
      if (result.ok) { setDepartureForm(null); choose({kind: 'departures', id: result.value.id}); }
    } catch (error) { setError(errorText(error)); }
  }

  const activeMember = !!current && ['confirmed', 'checked_in', 'completed'].includes(current.membership);
  const canChat = !!user && (selected?.kind === 'recruitment-requests' ? requestAccess : activeMember);
  const assignedGuide = !!current && user?.id === current.guideId;
  const canCheckIn = !!current && assignedGuide && current.guideEligible && current.routeOpen && ['ready', 'recruiting'].includes(current.status) && now >= Date.parse(current.startsAt) - 86400000 && now < Date.parse(current.endsAt);
  const canReview = !!current && reviewAllowed(current, user, reviews, reviewTarget);
  const beforeStart = !!current && ['recruiting', 'ready', 'awaiting_guide'].includes(current.status);
  const selectedCategories = current ? routeCategories(current.routeId, current.routeTitle, current.routeRevisionId) : routeCategories(currentRequest?.routeId || '');

  return <>
    {error && <div className="inline-error" role="alert"><Info size={22}/><span>{error}</span></div>}
    {service === 'preview' && <div className="notice-block">Походы пока недоступны. Вы можете выбрать маршрут и сохранить личный план на устройстве.</div>}
    {selected ? <>
      <button className="back-link" onClick={() => choose(null)}><ArrowLeft size={17}/>К списку походов</button>
      <div className="offline-heading"><div className="trip-route-heading">{selectedCategories[0]&&<EventCategoryIcon category={selectedCategories[0]} size={32}/>}<h2>{current?.routeTitle || title(current?.routeId || currentRequest?.routeId || '')}</h2></div><button className="icon-button" onClick={() => { setError(''); void refreshDetail(); }} disabled={detailLoading || !!busy} aria-label="Обновить состояние группы"><ArrowClockwise size={20}/></button></div>
      <RouteCategoryBadges categories={selectedCategories} className="trip-detail-categories"/>
      {detailLoading && <p className="status-loading" role="status">Проверяем состав и доступ…</p>}
      <div className="conversation">
        {canChat ? <ChatPanel key={selected.kind + selected.id + user!.id} kind={selected.kind} id={selected.id} user={user!}/> : <div className="empty-state"><ChatCircleDots size={40}/><h2>Чат участников</h2><p>Доступ появится после подтверждённого присоединения к обсуждению или группе.</p>
          {!user ? <button className="button primary" onClick={() => setAuth(true)}>Войти</button>
            : current && joinAllowed(current, now) ? <button className="button primary" onClick={() => void join(current)} disabled={!!busy}>Присоединиться</button>
            : currentRequest?.status === 'open' && <button className="button primary" disabled={!!busy} onClick={() => void write('recruitment-requests/' + encodeURIComponent(currentRequest.id) + '/join', {})}>Присоединиться к обсуждению</button>}
        </div>}
        <aside className="chat-side">
          {current && <>
            <div className="prose-card"><span className="status-pill">{labels[current.status]}</span><h3 style={{marginTop: 16}}>Состав и условия</h3>
              <p>{dateLabel(current.startsAt, current.timeZone)}<br/>Часовой пояс: {current.timeZone}</p>
              <div className="quorum-track" aria-label={current.participantCount + ' из ' + current.minPeople + ' необходимых участников'}>{Array.from({length: Math.min(current.minPeople, 12)}, (_, i) => <span key={i} className={i < current.participantCount ? i === 0 && current.guideId ? 'filled guide' : 'filled' : ''}/>)}</div>
              <p>{current.participantCount} / {current.capacity} участников · минимум {current.minPeople}<br/>Гид: {current.guideName || 'Не назначен'}</p>
              <p style={{marginTop: 12}}>{current.guideEligible ? 'Допуск гида действителен для выхода' : 'Допуск гида требует проверки'}<br/>{current.routeOpen ? 'Маршрут доступен для похода' : 'Маршрут недоступен для старта'}</p>
              <p style={{marginTop: 12}}>{membershipLabels[current.membership]}</p>
              {['none', 'cancelled'].includes(current.membership) && <button className="button primary full" onClick={() => void join(current)} disabled={!!busy || !joinAllowed(current, now)}>Подтвердить участие</button>}
              {activeMember && beforeStart && <button className="text-link" disabled={!!busy} onClick={() => setConfirm({action: 'leave', version: current.version})}>Выйти из группы</button>}
            </div>
            {assignedGuide && <div className="prose-card"><h3>Решение гида</h3><p>Подтвердите, кто пришёл на место встречи. Для старта нужны подходящий состав, допуск гида и актуальный маршрут.</p>
              <div className="stack">{participants.map(person => <div className="roster-row" key={person.userId}><span>{person.displayName}<small>{person.role === 'guide' ? 'Гид' : 'Турист'}</small></span>
                {person.status === 'checked_in' || person.status === 'completed' ? <span title={person.status === 'completed' ? 'Поход завершён' : 'Явка подтверждена'}><CheckCircle size={20}/></span>
                  : person.status === 'no_show' ? <small>Не был на старте</small>
                  : <button className="button secondary small" disabled={!!busy || !canCheckIn} onClick={() => void write('departures/' + encodeURIComponent(current.id) + '/check-in', {userId: person.userId, expectedVersion: current.version})}>На месте</button>}
              </div>)}
                {beforeStart && <><p className="fineprint">Старт доступен в назначенное время после явки минимум {current.minPeople} человек вместе с гидом.</p><button className="button primary full" disabled={!!busy || !startAllowed(current, participants, user!.id, now)} onClick={() => setConfirm({action: 'start', version: current.version})}>Подтвердить старт</button></>}
                {current.status === 'in_progress' && <><button className="button primary full" onClick={() => setConfirm({action: 'complete', version: current.version})} disabled={!!busy}>Завершить поход</button><button className="button danger full" onClick={() => setConfirm({action: 'abort', version: current.version})} disabled={!!busy}>Прекратить поход</button></>}
                {beforeStart && <button className="text-link" disabled={!!busy} onClick={() => setConfirm({action: 'cancel', version: current.version})}>Отменить выход</button>}
              </div>
            </div>}
          </>}
          {currentRequest && <div className="prose-card"><span className="status-pill warning">{labels[currentRequest.status]}</span><h3 style={{marginTop: 16}}>Предложение похода</h3><p className="request-body">{currentRequest.body}</p><p style={{marginTop: 16}}>{currentRequest.interestedCount} заинтересовались<br/>Желаемая дата: {currentRequest.preferredDate || 'Обсуждается'}<br/>Автор: {currentRequest.creatorName}</p>
            <div className="notice-block">Участие в обсуждении ещё не бронирует место. После назначения выхода нужно подтвердить конкретную дату.</div>
            {user?.guideStatus === 'verified' && currentRequest.status === 'open' && <button className="button primary full" disabled={!!busy || !routes.some(route => route.id === currentRequest.routeId)} onClick={() => openDepartureForm(currentRequest)}>Принять как гид</button>}
            {currentRequest.departureId && <button className="button primary full" onClick={() => choose({kind: 'departures', id: currentRequest.departureId!})}>К назначенному выходу <ArrowRight size={16}/></button>}
            {requestAccess && <button className="text-link" disabled={!!busy} onClick={async () => { const result = await write<void>('recruitment-requests/' + encodeURIComponent(currentRequest.id) + '/leave', {}, {skipDetail: true}); if (result.ok) choose(null); }}>{user?.id === currentRequest.creatorId && currentRequest.status === 'open' ? 'Закрыть свой запрос' : 'Выйти из обсуждения'}</button>}
          </div>}
        </aside>
      </div>
      {current?.status === 'completed' && <section className="prose-card" style={{marginTop: 24}}><h3>Отзывы об этом походе</h3>
        {reviews.length ? <div className="record-list">{reviews.map(review => <article key={review.id}><span className="status-pill"><Star size={12} weight="fill"/>{review.rating} / 5 · {review.target === 'guide' ? 'Работа гида' : 'Маршрут'}</span><p style={{marginTop: 12, whiteSpace: 'pre-wrap'}}>{review.body}</p><small>Участие подтверждено · {new Date(review.createdAt).toLocaleDateString('ru')}</small><div><button className="text-link" onClick={() => setReport(review.id)}><Flag size={14}/>Сообщить о нарушении</button></div></article>)}</div> : <p>Опубликованных отзывов пока нет.</p>}
        {current.membership === 'completed' && !assignedGuide && user && <form className="review-form stack" onSubmit={async event => { event.preventDefault(); if (!canReview || !rating || !reviewBody.trim()) return; const result = await write<Review>('departures/' + encodeURIComponent(current.id) + '/reviews', {target: reviewTarget, rating, body: reviewBody.trim()}); if (result.ok) { setReviewBody(''); setRating(0); } }}>
          <label>Что оцениваете<select value={reviewTarget} disabled={!!busy} onChange={event => { setReviewTarget(event.target.value as 'route' | 'guide'); setRating(0); setReviewBody(''); }}><option value="route">Маршрут</option><option value="guide">Работу гида</option></select></label>
          {canReview ? <><div className="rating-input" role="group" aria-label="Оценка от одного до пяти">{[1, 2, 3, 4, 5].map(value => <button key={value} type="button" disabled={!!busy} className={value <= rating ? 'selected' : ''} aria-pressed={value === rating} aria-label={value + ' из 5'} onClick={() => setRating(value)}><Star weight={value <= rating ? 'fill' : 'regular'}/></button>)}</div><label>Ваш опыт<textarea rows={4} required maxLength={3000} disabled={!!busy} value={reviewBody} onChange={event => setReviewBody(event.target.value)} placeholder="Что понравилось и что стоит знать следующим участникам"/></label><button className="button primary" disabled={!!busy || !rating || !reviewBody.trim()}>Опубликовать отзыв</button></> : <p>Вы уже оставили отзыв об этом аспекте похода.</p>}
        </form>}
      </section>}
    </> : <>
      <div className="toolbar"><div className="status-pill"><ShieldCheck size={14}/>От четырёх человек вместе с гидом</div>
        <button className="button primary" disabled={!!busy} onClick={() => { setError(''); if (!user && service === 'configured') { setAuth(true); return; } setRouteId(''); setCreate(true); }}><Plus size={17}/>Предложить поход</button>
        {user?.guideStatus === 'verified' && <button className="button secondary" disabled={!!busy} onClick={() => openDepartureForm(null)}>Назначить выход</button>}
        <button className="icon-button" onClick={() => { setError(''); void load(); }} disabled={loading || !!busy} aria-label="Обновить походы"><ArrowClockwise size={20}/></button>
      </div>
      <nav className="page-tabs" aria-label="Разделы походов">{([['departures', 'Выходы с гидом', departures.length], ['requests', 'Ищут компанию', requests.length], ['drafts', 'Мои черновики', drafts.length]] as const).map(([key, label, count]) => <button key={key} className={tab === key ? 'active' : ''} aria-current={tab === key ? 'page' : undefined} onClick={() => setTab(key)}>{label} <span className="tab-count">{count}</span></button>)}</nav>
      {loading ? <p className="status-loading">Обновляем данные…</p> : tab === 'departures' ? departures.length ? <div className="list-grid">{departures.map(departure => <article className="departure-card" key={departure.id}><span className="status-pill">{labels[departure.status]}</span><TripRouteHeading title={departure.routeTitle || title(departure.routeId)} categories={routeCategories(departure.routeId, departure.routeTitle, departure.routeRevisionId)}/><RouteCategoryBadges categories={routeCategories(departure.routeId, departure.routeTitle, departure.routeRevisionId)} limit={2}/><p className="departure-date">{dateLabel(departure.startsAt, departure.timeZone)} · {departure.timeZone}</p><div className="departure-meta"><span><UsersThree size={16}/>{departure.participantCount}/{departure.capacity}</span><span><ShieldCheck size={16}/>{departure.guideName || 'Гид пока не назначен'}</span></div><footer><p>Минимум {departure.minPeople} человек<br/>Включая гида</p><button className="button secondary" onClick={() => choose({kind: 'departures', id: departure.id})}>Открыть группу <ArrowRight size={16}/></button></footer></article>)}</div> : <Empty title="Первый поход ещё впереди" description="Выберите опубликованный маршрут и предложите дату. Подходящий гид назначит выход и откроет набор."/>
        : tab === 'requests' ? requests.length ? <div className="list-grid">{requests.map(request => <article className="departure-card" key={request.id}><span className="status-pill warning">{labels[request.status]}</span><TripRouteHeading title={title(request.routeId)} categories={routeCategories(request.routeId)}/><RouteCategoryBadges categories={routeCategories(request.routeId)} limit={2}/><p className="request-body">{request.body}</p><div className="departure-meta"><span><CalendarBlank size={16}/>{request.preferredDate || 'Дата обсуждается'}</span><span><UsersThree size={16}/>{request.interestedCount} интересуются</span></div><footer><p>{request.creatorName}</p><button className="button secondary" disabled={!!busy} onClick={() => choose({kind: 'recruitment-requests', id: request.id})}>В обсуждение <ArrowRight size={16}/></button></footer></article>)}</div> : <Empty title={user ? 'Найдите своих попутчиков' : 'Начните со знакомства'} description={service === 'configured' && !user ? 'Войдите, чтобы увидеть запросы на походы и обсуждать их с другими участниками.' : 'Открытых запросов пока нет. Изучите карту и подготовьте предложение для будущей группы.'} onLogin={service === 'configured' && !user ? () => setAuth(true) : undefined}/>
          : drafts.length ? <div className="list-grid">{drafts.map(draft => <article className="departure-card" key={draft.id}><span className="status-pill offline">Личный черновик</span><TripRouteHeading title={draft.title} categories={routeCategories(draft.routeId)}/><RouteCategoryBadges categories={routeCategories(draft.routeId)} limit={2}/><p className="departure-date">Желаемая дата: {draft.preferredDate || 'Обсуждается'}</p><p className="request-body" style={{marginTop: 12}}>{draft.note}</p><footer><p>Не опубликован<br/>Гид не назначен</p><a className="button secondary" href={'/?route=' + encodeURIComponent(draft.routeId) + '&region=' + encodeURIComponent(trails.find(trail => trail.id === draft.routeId)?.regionId || 'krasnodar')}>К маршруту <ArrowRight size={16}/></a></footer><button className="text-link" onClick={() => { try { const next = drafts.filter(item => item.id !== draft.id); localStorage.setItem('tropa-requests', JSON.stringify(next)); setDrafts(next); } catch { setError('Не удалось удалить черновик. Проверьте доступ к хранилищу устройства.'); } }}>Удалить черновик</button></article>)}</div> : <Empty title="Место для будущих планов" description="Личный черновик можно сохранить из карточки маршрута. Он останется на этом устройстве, пока вы готовитесь к выходу."/>}
    </>}
    {auth && <AuthDialog onClose={closeAuth} onUser={setUser}/>}
    {create && <Modal title="Предложите свой поход" onClose={closeCreate}>
      {service !== 'configured' || !routes.some(route => route.status === 'published') ? <div className="small-empty"><Compass size={37}/><h3>Начните с маршрута на карте</h3><p>В карточке маршрута можно сохранить личный план и вернуться к нему позже.</p><Link prefetch={false} className="button primary" href="/">Выбрать маршрут <ArrowRight size={16}/></Link></div> : <form className="stack" onSubmit={createRequest}>
        <label>Маршрут<select required disabled={!!busy} value={routeId} onChange={event => setRouteId(event.target.value)}><option value="">Выберите опубликованный маршрут</option>{routes.filter(route => route.status === 'published').map(route => <option key={route.id} value={route.id}>{route.title}</option>)}</select></label>
        {routeCursor && <button type="button" className="button secondary" disabled={routeLoading || loading || !!busy} onClick={() => void loadMoreRoutes()}>{routeLoading ? 'Загружаем маршруты…' : 'Загрузить ещё маршруты'}</button>}
        <label>Желаемая дата<input type="date" disabled={!!busy} value={date} min={new Date().toLocaleDateString('en-CA')} onChange={event => setDate(event.target.value)}/></label>
        <label>Что важно для группы<textarea required maxLength={2000} disabled={!!busy} rows={4} value={body} onChange={event => setBody(event.target.value)} placeholder="Ваш опыт, ожидания и удобные даты"/></label>
        <div className="inline-note"><Info size={18}/><span>Это запрос на обсуждение. Гид отдельно подтвердит даты и условия. Места не бронируются автоматически.</span></div>
        {error && <p className="error-message" role="alert">{error}</p>}<button className="button primary full" disabled={!!busy || !body.trim() || !routeId}>{busy ? 'Ожидаем ответ…' : 'Открыть набор в обсуждение'}</button>
      </form>}
    </Modal>}
    {departureForm && <Modal title="Назначить выход с гидом" onClose={closeDeparture}><form className="stack" onSubmit={createDeparture}>
      {departureForm.request ? <p className="muted">{title(departureForm.request.routeId)}</p> : <label>Маршрут<select required value={routeId} disabled={!!busy} onChange={event => {
        const route = routes.find(item => item.id === event.target.value), limits = routePolicy(route);
        setRouteId(event.target.value); setMinPeople(limits.minPeople); setCapacity(Math.min(Math.max(8, limits.minPeople), limits.maxGroupSize)); setZone(regions.find(region => region.id === route?.regionId)?.timezone || 'Europe/Moscow');
      }}><option value="">Выберите опубликованный маршрут</option>{routes.filter(route => route.status === 'published').map(route => <option key={route.id} value={route.id}>{route.title}</option>)}</select></label>}
      {!departureForm.request && routeCursor && <button type="button" className="button secondary" disabled={routeLoading || loading || !!busy} onClick={() => void loadMoreRoutes()}>{routeLoading ? 'Загружаем маршруты…' : 'Загрузить ещё маршруты'}</button>}
      <label>Часовой пояс<select value={zone} disabled={!!busy} onChange={event => setZone(event.target.value)}>{Array.from(new Set(['Europe/Moscow', ...regions.map(region => region.timezone)])).map(value => <option value={value} key={value}>{value}</option>)}</select></label>
      <label>Начало по выбранному поясу<input type="datetime-local" required disabled={!!busy} value={startsAt} onChange={event => setStartsAt(event.target.value)}/></label>
      <label>Окончание по выбранному поясу<input type="datetime-local" required disabled={!!busy} value={endsAt} onChange={event => setEndsAt(event.target.value)}/></label>
      <label>Минимум участников вместе с гидом<input type="number" required step={1} disabled={!!busy} min={policy.minPeople} max={policy.maxGroupSize} value={minPeople} onChange={event => setMinPeople(Number(event.target.value))}/></label>
      <label>Всего мест вместе с гидом<input type="number" required step={1} disabled={!!busy} min={minPeople} max={policy.maxGroupSize} value={capacity} onChange={event => setCapacity(Number(event.target.value))}/></label>
      <div className="inline-note"><Info size={18}/><span>{chosenRoute ? 'Ограничения маршрута: от ' + policy.minPeople + ' до ' + policy.maxGroupSize + ' человек, включая гида. ' : ''}{policy.requiredGuides !== 1 ? 'Для маршрута требуется несколько гидов; такой состав пока не поддерживается.' : 'Перед выходом проверяются допуск гида и доступность маршрута. Участие в этих датах подтверждается отдельно.'}</span></div>
      {error && <p className="error-message" role="alert">{error}</p>}<button className="button primary" disabled={!!busy || !chosenRoute || policy.requiredGuides !== 1}>{busy ? 'Ожидаем ответ…' : 'Создать выход'}</button>
    </form></Modal>}
    {confirm && current && <Modal title={{start: 'Подтвердить начало похода?', complete: 'Завершить поход?', cancel: 'Отменить выход?', abort: 'Прекратить поход?', leave: 'Выйти из группы?'}[confirm.action]} onClose={closeConfirm}>
      <p className="muted">{confirm.action === 'start' ? 'Подтвердите готовность группы. Для старта нужны явка участников, действующий допуск гида и доступный маршрут.' : confirm.action === 'complete' ? 'Подтвердите, что выход завершён. У участников с подтверждённой явкой появится возможность оставить отзыв.' : confirm.action === 'leave' ? assignedGuide ? 'После вашего выхода группа останется без гида и потеряет готовность к старту. Участники смогут обсудить дальнейшие действия.' : 'Ваше участие перестанет быть подтверждённым. Состав и готовность группы будут пересчитаны.' : 'Участники увидят новый статус. Это действие не отправляет автоматический вызов экстренным службам.'}</p>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="section-actions"><button className="button primary" disabled={!!busy} onClick={async () => { const result = confirm.action === 'leave' ? await write<Departure>('departures/' + encodeURIComponent(current.id) + '/leave', {}) : await write<Departure>('departures/' + encodeURIComponent(current.id) + '/transition', {action: confirm.action, expectedVersion: confirm.version}); if (result.ok) setConfirm(null); }}>{busy ? 'Ожидаем ответ…' : 'Подтвердить'}</button><button className="button secondary" disabled={!!busy} onClick={closeConfirm}>Вернуться</button></div>
    </Modal>}
    {report && <ReportDialog targetType="review" targetId={report} onClose={() => setReport(null)}/>}
  </>;
}

function Empty({title, description, onLogin}: {title: string; description: string; onLogin?: () => void}) {
  return <div className="empty-state"><UsersThree size={46}/><h2>{title}</h2><p>{description}</p><div className="empty-actions">{onLogin && <button className="button primary" onClick={onLogin}><UserCircle size={18}/>Войти</button>}<Link prefetch={false} className={onLogin ? 'button secondary' : 'button primary'} href="/">Исследовать карту <ArrowRight size={17}/></Link></div></div>;
}

function TripRouteHeading({title, categories}: {title: string; categories: readonly EventCategoryId[]}) {
  return <div className="trip-route-heading">{categories[0]&&<EventCategoryIcon category={categories[0]} size={32}/>}<h3>{title}</h3></div>;
}
