'use client';

import Link from 'next/link';
import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import {ApiError, api, errorText, isAbort, type Departure, type EmergencyCard, type Participant, type SafetyPassport, type User} from '@/lib/api';
import type {SafetyPrivateDetails, MCHSStatus} from '@/lib/contract';
import {MCHS_REGISTRATION_URL} from '@/lib/safety-passport';
import {saveOfflineEmergencyCard} from '@/public/offline-safety.js';
import {ArrowClockwise, ArrowSquareOut, ShieldCheck} from './TropnikIcons';
import styles from './SafetyPanel.module.css';

type Props = {departure: Departure; user: User; participants: Participant[]; onChanged: () => void | Promise<void>};
type Details = Omit<SafetyPrivateDetails, 'participants'>;
const blank: Details = {leaderPhone: '', emergencyContactName: '', emergencyContactPhone: '', communicationPlan: '', transport: '', backupRoute: '', equipment: '', firstAid: '', insurance: '', notes: ''};
const labels: Record<MCHSStatus, string> = {
  not_required: 'Проверка уведомления не включена в условия старта', recommended: 'Уведомление рекомендуется условиями маршрута', required: 'Для старта нужна проверка уведомления',
  preparing: 'Паспорт готовится', ready_to_submit: 'Паспорт готов для официальной подачи', submitted_unverified: 'Отправка записана, подтверждение ещё не проверено',
  start_contact_pending: 'Сотрудник проверил подтверждение, нужен предвыходный контакт', confirmed: 'Подтверждение и предвыходный контакт проверены',
  amendment_required: 'Сведения изменились: обновите паспорт и уведомление', active: 'Группа на маршруте', return_report_pending: 'Нужно сообщить о возвращении', closed: 'Контур безопасности закрыт', rejected: 'Подтверждение отклонено', cancelled: 'Выход отменён',
};

export function SafetyPanel({departure, user, participants, onChanged}: Props) {
  const [passport, setPassport] = useState<SafetyPassport | null>(null);
  const [card, setCard] = useState<EmergencyCard | null>(null);
  const [form, setForm] = useState<Details>(blank), [phones, setPhones] = useState<Record<string, string>>({});
  const [submission, setSubmission] = useState(''), [evidence, setEvidence] = useState(''), [contactNote, setContactNote] = useState(''), [returnMethod, setReturnMethod] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(false), inFlight = useRef(false), epoch = useRef(0), hydratedVersion = useRef(-1);
  const readController = useRef<AbortController | null>(null), writeController = useRef<AbortController | null>(null);
  const attempts = useRef<Record<string, {signature: string; key: string; body: string}>>({});
  const base = 'departures/' + encodeURIComponent(departure.id);
  const guide = departure.guideId === user.id;
  const member = ['confirmed', 'checked_in', 'completed'].includes(departure.membership);
  const independentStaff = user.staffRole !== 'none' && !guide && !member;
  const roster = participants.filter(person => person.status === 'confirmed' || person.status === 'checked_in');

  const load = useCallback(async () => {
    const request = ++epoch.current;
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    setLoading(true); setError('');
    try {
      const [next, nextCard] = await Promise.all([
        api<SafetyPassport>(base + '/safety-passport', {signal: controller.signal}),
        api<EmergencyCard>(base + '/emergency-card', {signal: controller.signal}),
      ]);
      if (!alive.current || request !== epoch.current) return;
      setPassport(next); setCard(nextCard);
      if (hydratedVersion.current !== next.version) {
        hydratedVersion.current = next.version;
        setSubmission(next.submissionId || '');
        setEvidence('');
        if (next.private) {
          const {participants: contacts, ...details} = next.private;
          setForm(details); setPhones(Object.fromEntries(contacts.map(person => [person.userId, person.phone])));
        }
      }
    } catch (failure) { if (alive.current && request === epoch.current && !isAbort(failure)) setError(errorText(failure)); }
    finally { if (alive.current && request === epoch.current) setLoading(false); }
  }, [base]);

  useEffect(() => {
    const activeEpoch = epoch, reads = readController, writes = writeController;
    alive.current = true;
    return () => { alive.current = false; ++activeEpoch.current; reads.current?.abort(); writes.current?.abort(); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const activeEpoch = epoch, reads = readController;
    queueMicrotask(() => { if (!cancelled && alive.current) void load(); });
    return () => { cancelled = true; ++activeEpoch.current; reads.current?.abort(); };
  }, [load, departure.version, departure.safetyPassportVersion, departure.safetyStatus]);

  async function mutate(name: string, path: string, payload: Record<string, unknown>, timestamp?: string) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(name); setError(''); setNotice('');
    // A retry after an unknown network outcome retains the exact timestamp,
    // body and idempotency key. Edited input creates a distinct versioned action.
    const signature = JSON.stringify([path, payload, timestamp]);
    const previous = attempts.current[name];
    const attempt = previous?.signature === signature ? previous : {
      signature, key: crypto.randomUUID(), body: JSON.stringify(timestamp ? {...payload, [timestamp]: new Date().toISOString()} : payload),
    };
    attempts.current[name] = attempt;
    const controller = new AbortController(); writeController.current = controller;
    try {
      await api(path, {method: 'POST', headers: {'Idempotency-Key': attempt.key}, body: attempt.body, signal: controller.signal});
      delete attempts.current[name];
      if (!alive.current) return;
      setNotice('Сервис сохранил действие. Уведомление в МЧС автоматически не отправлялось.');
      await load();
      if (alive.current) await onChanged();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status > 0) delete attempts.current[name];
      if (alive.current && !isAbort(failure)) setError(errorText(failure));
    } finally { inFlight.current = false; if (alive.current) setBusy(''); }
  }

  function prepare(event: FormEvent) {
    event.preventDefault();
    if (!passport) return;
    void mutate('prepare', base + '/safety-passport/prepare', {...form, expectedVersion: passport.version, participants: roster.map(person => ({userId: person.userId, phone: (phones[person.userId] || '').trim()}))});
  }
  function saveCard() {
    if (!card) return;
    try { saveOfflineEmergencyCard(localStorage, card); setNotice('Карточка сохранена на этом устройстве. Откройте автономный просмотр перед выходом.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить карточку. Проверьте свободное место.'); }
  }
  async function checkPoint(kind: 'control_point' | 'incident') {
    if (inFlight.current) return;
    inFlight.current = true; setBusy('location'); setError('');
    let position: {latitude?: number; longitude?: number} = {};
    try {
      position = await new Promise<{latitude: number; longitude: number}>((resolve, reject) => {
        if (!navigator.geolocation) { reject(new Error('location unavailable')); return; }
        navigator.geolocation.getCurrentPosition(value => resolve({latitude: value.coords.latitude, longitude: value.coords.longitude}), reject, {enableHighAccuracy: true, timeout: 12000, maximumAge: 0});
      });
    } catch { /* An observation without coordinates remains explicitly such. */ }
    inFlight.current = false;
    if (alive.current) await mutate('check-in', base + '/safety-check-ins', {kind, ...position, note: position.latitude === undefined ? 'Координаты недоступны' : ''}, 'observedAt');
  }
  const status = passport?.status || departure.safetyStatus;
  const version = passport?.version;
  const beforeStart = ['ready', 'recruiting', 'awaiting_guide'].includes(departure.status);
  const renewStartContact = beforeStart && status === 'confirmed' && !departure.startContactConfirmed;
  const field = (key: keyof Details, title: string, multiline = false, max = 2000) => <label key={key}>{title}{multiline ? <textarea required={key !== 'notes'} rows={2} maxLength={max} value={form[key]} onChange={event => setForm({...form, [key]: event.target.value})}/> : <input required={key !== 'notes'} maxLength={max} type={key.toLowerCase().includes('phone') ? 'tel' : 'text'} value={form[key]} onChange={event => setForm({...form, [key]: event.target.value})}/>}</label>;

  return <section className={'prose-card ' + styles.panel} aria-labelledby={'safety-' + departure.id}>
    <div className={styles.heading}><h3 id={'safety-' + departure.id}><ShieldCheck size={20}/>Паспорт безопасности</h3><button className="icon-button" onClick={() => void load()} disabled={loading || !!busy} aria-label="Обновить паспорт безопасности"><ArrowClockwise size={18}/></button></div>
    <p className={styles.notice}>Подачу завершает руководитель через официальный ресурс. Запись номера ожидает проверки сотрудником Тропника. При происшествии обращайтесь по номеру <a href="tel:112">112</a>.</p>
    {error && <p className="error-message" role="alert">{error}</p>}{notice && <p role="status" aria-live="polite">{notice}</p>}
    {loading && !passport ? <div className={styles.skeleton} role="status">Проверяем сохранённый паспорт…</div> : passport && <>
      <p><strong>{renewStartContact ? 'Подтверждение проверено, предвыходный контакт нужно обновить' : status ? labels[status] : 'Статус недоступен'}</strong><br/>Версия паспорта: {version}. Часовой пояс: {departure.timeZone}.</p>
      {renewStartContact && <p className={styles.notice}>Перед выходом ещё раз уточните актуальные сведения у ответственного подразделения и зафиксируйте выполненный контакт.</p>}
      {status === 'amendment_required' && <p className={styles.notice}>Состав, сроки или маршрут изменились. Сформируйте новую версию, уточните сведения в МЧС и передайте новое подтверждение сотруднику.</p>}
      {passport.public && <details><summary>Маршрут и аварийный план</summary><p>{passport.public.route.title}</p><p>{passport.public.route.description}</p><p>Аварийные выходы: {passport.public.route.emergencyExits.map(point => point.name).join('; ') || 'Не указаны. Уточните до выхода.'}</p><p>Контрольные точки: {passport.public.route.controlPoints.map(point => point.name).join('; ') || 'Не указаны.'}</p></details>}
      {guide && beforeStart && <details open={!version || status === 'amendment_required'}><summary>{version ? 'Обновить паспорт' : 'Подготовить паспорт'}</summary><form onSubmit={prepare}><fieldset disabled={!!busy || loading}>
        {field('leaderPhone', 'Телефон руководителя', false, 25)}{field('emergencyContactName', 'Контакт вне группы', false, 120)}{field('emergencyContactPhone', 'Телефон контакта', false, 25)}
        {field('communicationPlan', 'Когда и как группа выходит на связь', true)}{field('transport', 'Транспорт')}{field('backupRoute', 'Запасной маршрут', true)}{field('equipment', 'Снаряжение', true)}{field('firstAid', 'Первая помощь', true)}{field('insurance', 'Сведения о страховании или его отсутствии')}
        <h4>Контакты официального состава</h4>{roster.map(person => <label key={person.userId}>{person.displayName}<input type="tel" required maxLength={25} value={phones[person.userId] || ''} onChange={event => setPhones({...phones, [person.userId]: event.target.value})}/></label>)}
        {field('notes', 'Дополнительные сведения', true, 4000)}
        <p className="fineprint">Контакты участников доступны руководителю и уполномоченным сотрудникам. Участники видят отдельную аварийную карточку. Убедитесь, что вправе передать эти сведения.</p>
        <button className="button primary full" disabled={!roster.length || roster.length !== departure.participantCount}>{busy === 'prepare' ? 'Сохраняем…' : 'Сформировать версию паспорта'}</button>
      </fieldset></form></details>}
      {guide && version && passport.notificationPolicy !== 'not_required' ? <div className={styles.actions}>
        <a className="button secondary full" href={MCHS_REGISTRATION_URL} target="_blank" rel="noreferrer">Официальная форма МЧС <ArrowSquareOut size={16}/></a>
        {status === 'ready_to_submit' && <form onSubmit={event => { event.preventDefault(); void mutate('submission', base + '/mchs/submission', {passportVersion: version, submissionId: submission.trim()}, 'submittedAt'); }}><label>Номер фактически поданного уведомления<input required minLength={3} maxLength={160} disabled={!!busy} value={submission} onChange={event => setSubmission(event.target.value)}/></label><button className="button primary full" disabled={!!busy || submission.trim().length < 3}>Сохранить номер для проверки</button></form>}
        {['start_contact_pending', 'confirmed'].includes(status || '') && <form onSubmit={event => {event.preventDefault(); void mutate('contact', base + '/mchs/start-contact', {passportVersion: version, note: contactNote}, 'contactedAt');}}><label>Кому сообщили актуальные сведения перед выходом<input maxLength={1000} value={contactNote} disabled={!!busy} onChange={event => setContactNote(event.target.value)}/></label><button className="button secondary full" disabled={!!busy}>Зафиксировать выполненный контакт</button></form>}
        {status === 'return_report_pending' && <form onSubmit={event => {event.preventDefault(); void mutate('return', base + '/mchs/return-report', {passportVersion: version, method: returnMethod, note: ''}, 'reportedAt');}}><label>Как сообщили о возвращении<input required minLength={2} maxLength={120} value={returnMethod} disabled={!!busy} onChange={event => setReturnMethod(event.target.value)}/></label><button className="button primary full" disabled={!!busy}>Зафиксировать сообщение о возвращении</button></form>}
      </div> : null}
      {independentStaff && status === 'submitted_unverified' && <form onSubmit={event => {event.preventDefault(); void mutate('confirmation', base + '/mchs/confirmation', {passportVersion: version, confirmationRef: evidence.trim()});}}><label>Основание проверки внешнего подтверждения<input required minLength={3} maxLength={240} value={evidence} disabled={!!busy} onChange={event => setEvidence(event.target.value)}/></label><p className="fineprint">Сверьте внешнее подтверждение именно с версией {version}. Собственный поход подтвердить нельзя.</p><button className="button primary full" disabled={!!busy || evidence.trim().length < 3}>Подтвердить проверку</button></form>}
      {guide && departure.status === 'in_progress' && <div className={styles.actions}><button className="button secondary full" disabled={!!busy} onClick={() => void checkPoint('control_point')}>Записать контрольную точку</button><button className="button secondary full" disabled={!!busy} onClick={() => void checkPoint('incident')}>Записать происшествие</button><p className="fineprint">Запись не вызывает помощь. Для экстренного обращения звоните 112.</p></div>}
      {card && <details><summary>Аварийная карточка</summary><p>{card.messageTemplate}</p><p>Руководитель: {card.leaderName} · {card.leaderPhone || 'телефон не указан'}<br/>Контакт вне группы: {card.emergencyContactName || 'не указан'} · {card.emergencyContactPhone || 'телефон не указан'}</p><p className="fineprint">Копия с контактами останется в браузере после выхода из аккаунта. Сохраняйте только на своём устройстве; удалить её можно в автономном просмотре.</p><div className={styles.actions}><button className="button secondary full" onClick={saveCard} disabled={loading || !!busy}>Сохранить аварийную карточку на устройстве</button><Link prefetch={false} className="button secondary full" href={'/offline-safety.html?departure=' + encodeURIComponent(departure.id)}>Открыть автономную карточку</Link><a className="button primary full" href="tel:112">Позвонить 112</a></div></details>}
    </>}
  </section>;
}
