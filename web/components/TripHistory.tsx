'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowClockwise, ArrowRight, CalendarCheck, Mountains} from '@/components/TropnikIcons';
import {apiEnvelope, errorText, isAbort} from '@/lib/api';
import type {CompletedDeparture} from '@/lib/contract';

function historyDate(value: string, timeZone: string) {
  try { return new Intl.DateTimeFormat('ru', {timeZone, day: 'numeric', month: 'long', year: 'numeric'}).format(new Date(value)); }
  catch { return 'Дата уточняется'; }
}

/** Mounted with the authenticated account ID as its React key. Nothing is
 * written to public storage, and responses from an old account are discarded. */
export function TripHistory() {
  const [items, setItems] = useState<CompletedDeparture[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async (after?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = ++sequence.current;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setError('');
    try {
      const page = await apiEnvelope<CompletedDeparture[]>(`me/departures?limit=20${after ? '&cursor=' + encodeURIComponent(after) : ''}`, {signal: controller.signal});
      if (request !== sequence.current) return;
      if (after && page.meta?.nextCursor === after) throw new Error('Страница истории не обновилась. Обновите историю целиком.');
      setItems(previous => after ? [...new Map([...previous, ...page.data].map(item => [item.id, item])).values()] : page.data);
      setCursor(page.meta?.nextCursor);
      setLoaded(true);
    } catch (failure) {
      if (request === sequence.current && !isAbort(failure)) setError(errorText(failure));
    } finally {
      if (request === sequence.current) { inFlight.current = false; setLoading(false); }
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { ++sequence.current; inFlight.current = false; active.current?.abort(); };
  }, [load]);

  return <section aria-labelledby="trip-history-title">
    <div className="offline-heading"><div><span className="eyebrow">Подтверждённое участие</span><h2 id="trip-history-title">История походов</h2></div><button className="button secondary small" onClick={() => void load()} disabled={loading}><ArrowClockwise size={17}/>{loading ? 'Обновляем…' : 'Обновить'}</button></div>
    <p className="muted">Здесь собраны завершённые походы с подтверждённым участием. История доступна только вам. Из неё можно вернуться в чат и оставить отзыв.</p>
    {loading && !loaded && <div className="status-loading" role="status">Загружаем историю походов…</div>}
    {error && <div className="error-message" role="alert">{error}<button className="text-link" disabled={loading} onClick={() => void load()}>Обновить историю</button></div>}
    {loaded && !items.length && <div className="empty-state"><CalendarCheck size={40}/><h3>Ваши истории ещё впереди</h3><p>После завершённого похода с подтверждённым участием здесь появится запись.</p><a className="button secondary" href="/trips">Найти поход <ArrowRight size={17}/></a></div>}
    {!!items.length && <div className="record-list">{items.map(item => <article className="account-card" key={item.id}>
      <div className="card-heading"><Mountains size={22}/><h3>{item.routeTitle}</h3></div>
      <p>{historyDate(item.startsAt, item.timeZone)}<br/>Гид: {item.guideName || 'Имя недоступно'}</p>
      <p className="muted">{item.role === 'guide' ? 'Вы провели этот поход' : 'Ваше участие подтверждено'} · Завершён {historyDate(item.completedAt, item.timeZone)}</p>
      <a className="button secondary" href={'/trips?departure=' + encodeURIComponent(item.id)}>Поход, чат и отзывы <ArrowRight size={17}/></a>
      {item.reviewTargets.length > 0 && <p className="source-note">Можно поделиться опытом {item.reviewTargets.includes('route') && item.reviewTargets.includes('guide') ? 'маршрута и работы гида' : item.reviewTargets.includes('route') ? 'маршрута' : 'работы гида'}.</p>}
    </article>)}</div>}
    {cursor && <div className="button-row"><button className="button secondary" disabled={loading} onClick={() => void load(cursor)}>{loading ? 'Загружаем…' : 'Показать предыдущие походы'}</button></div>}
  </section>;
}
