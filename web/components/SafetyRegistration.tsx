'use client';

import {useEffect, useMemo, useState} from 'react';
import Link from 'next/link';
import {Header} from './Header';
import {Footer} from './Footer';
import {ArrowSquareOut, Check, CheckCircle, Clock, DownloadSimple, Export, Info, MapPin, NotePencil, Plus, ShieldCheck, Trash, UsersThree, X} from './TropnikIcons';
import {saveLocalSafetyPassports} from '@/public/offline-safety.js';
import {
  MCHS_REGISTRATION_URL,
  SAFETY_STORAGE_KEY,
  buildEmergencyMessage,
  buildSafetyPackage,
  invalidateOfficialStatus,
  newSafetyPassport,
  parseSafetyPassportList,
  safetyReadiness,
  safetyPassportSnapshot,
  transitionSafetyPassport,
  type SafetyParticipant,
  type SafetyPassport,
  type SafetyStatus,
} from '@/lib/safety-passport';
import styles from './SafetyRegistration.module.css';

type SafetyCatalog = {
  regions: Array<{id: string; name: string}>;
  routes: Array<{id: string; title: string; regionId: string; description: string}>;
};
let safetyCatalogPromise: Promise<SafetyCatalog> | undefined;
function loadSafetyCatalog(): Promise<SafetyCatalog> {
  safetyCatalogPromise ??= import('@/lib/content').then(({regions, trails}) => ({
    regions: regions.map(({id, name}) => ({id, name})),
    routes: trails.map(({id, title, regionId, description}) => ({id, title, regionId, description})),
  }));
  return safetyCatalogPromise;
}

const statusLabels: Record<SafetyStatus, string> = {
  draft: 'Черновик',
  ready: 'Пакет готов',
  submitted: 'Отправка отмечена лично',
  confirmed: 'Личная запись о подтверждении',
  amendment_required: 'Нужно обновить уведомление',
  active: 'Группа на маршруте',
  closed: 'Поход закрыт',
};

const statusDescriptions: Record<SafetyStatus, string> = {
  draft: 'Заполните маршрут, контакты и состав группы.',
  ready: 'Перенесите сведения в официальную форму МЧС.',
  submitted: 'Сохраните полученный номер или иное подтверждение.',
  confirmed: 'Перед выходом уточните сведения в территориальном органе МЧС.',
  amendment_required: 'После изменения маршрута, сроков или состава уведомление нужно актуализировать.',
  active: 'Сохраните карточку на устройстве и откройте автономный просмотр перед выходом.',
  closed: 'Возвращение отмечено. Черновик можно сохранить для истории или удалить.',
};

const criticalFields = new Set<keyof SafetyPassport>([
  'routeId', 'routeTitle', 'region', 'startDate', 'endDate', 'startPoint', 'finishPoint', 'routeDescription',
  'reserveRoute', 'emergencyExits', 'transport', 'communication', 'equipment', 'leaderName', 'leaderPhone',
  'leaderEmail', 'outsideContactName', 'outsideContactPhone', 'returnDeadline', 'timeZone', 'participants',
]);

function id(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `${prefix}-${random}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function blankParticipant(value = 'participant-1'): SafetyParticipant {
  return {id: value, name: '', phone: '', emergencyName: '', emergencyPhone: '', minor: false};
}

function initialPassport(): SafetyPassport {
  const passport = newSafetyPassport('new');
  passport.participants = [blankParticipant()];
  return passport;
}

function timeLabel(value: string): string {
  if (!value) return 'не отмечено';
  try { return new Intl.DateTimeFormat('ru', {dateStyle: 'medium', timeStyle: 'short'}).format(new Date(value)); }
  catch { return value; }
}

function dateLabel(value: string): string {
  if (!value) return 'не указано';
  try { return new Intl.DateTimeFormat('ru', {dateStyle: 'long'}).format(new Date(value + 'T12:00:00')); }
  catch { return value; }
}

function fileName(passport: SafetyPassport, extension: string): string {
  const base = (passport.routeTitle || 'pohod').toLocaleLowerCase('ru').replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 48) || 'pohod';
  return `tropnik-${base}-${passport.startDate || 'draft'}.${extension}`;
}

function download(name: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], {type}));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export function SafetyRegistration() {
  const [passport, setPassport] = useState<SafetyPassport>(initialPassport);
  const [savedSnapshot, setSavedSnapshot] = useState(() => safetyPassportSnapshot(passport));
  const [saved, setSaved] = useState<SafetyPassport[]>([]);
  const [notice, setNotice] = useState('');
  const [submittedCheck, setSubmittedCheck] = useState(false);
  const [coordinates, setCoordinates] = useState('');
  const [locating, setLocating] = useState(false);
  const [catalog, setCatalog] = useState<SafetyCatalog | null>(null);
  const [catalogState, setCatalogState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const readiness = useMemo(() => safetyReadiness(passport), [passport]);
  const dirty = useMemo(() => safetyPassportSnapshot(passport) !== savedSnapshot, [passport, savedSnapshot]);
  const locked = passport.status === 'closed';

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      let stored: SafetyPassport[] = [];
      try {
        stored = parseSafetyPassportList(JSON.parse(localStorage.getItem(SAFETY_STORAGE_KEY) || '[]'));
        setSaved(stored);
      } catch { setNotice('Не удалось прочитать сохранённые паспорта на этом устройстве.'); }
      const params = new URLSearchParams(location.search);
      const requested = params.get('passport');
      const existing = requested ? stored.find(item => item.id === requested) : undefined;
      if (existing) { setSavedSnapshot(safetyPassportSnapshot(existing)); setPassport(existing); return; }
      const routeId = params.get('route');
      if (!routeId) return;
      setCatalogState('loading');
      void loadSafetyCatalog().then(next => {
        if (cancelled) return;
        setCatalog(next);
        setCatalogState('ready');
        const route = next.routes.find(item => item.id === routeId);
        if (!route) return;
        const region = next.regions.find(item => item.id === route.regionId);
        setPassport(previous => ({
          ...previous,
          routeId: route.id,
          routeTitle: route.title,
          region: region?.name || previous.region,
          routeDescription: route.description || previous.routeDescription,
          updatedAt: new Date().toISOString(),
        }));
      }).catch(() => {
        if (!cancelled) { setCatalogState('error'); setNotice('Каталог маршрутов не загрузился. Форму можно заполнить вручную.'); }
      });
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4200);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  function update<K extends keyof SafetyPassport>(key: K, value: SafetyPassport[K]) {
    if (criticalFields.has(key)) setSubmittedCheck(false);
    setPassport(previous => {
      const changed = {...previous, [key]: value} as SafetyPassport;
      if (previous.status === 'ready' && criticalFields.has(key)) return {...changed, status: 'draft', updatedAt: new Date().toISOString()};
      if (criticalFields.has(key)) return invalidateOfficialStatus(changed);
      return {...changed, updatedAt: new Date().toISOString()};
    });
  }

  async function openCatalog() {
    if (catalog || catalogState === 'loading') return;
    setCatalogState('loading');
    try { const next = await loadSafetyCatalog(); setCatalog(next); setCatalogState('ready'); }
    catch { setCatalogState('error'); setNotice('Каталог маршрутов не загрузился. Форму можно заполнить вручную.'); }
  }

  function selectRoute(routeId: string) {
    setSubmittedCheck(false);
    if (!routeId) { update('routeId', undefined); return; }
    const route = catalog?.routes.find(item => item.id === routeId);
    if (!route) return;
    const region = catalog?.regions.find(item => item.id === route.regionId);
    setPassport(previous => invalidateOfficialStatus({
      ...previous,
      routeId: route.id,
      routeTitle: route.title,
      region: region?.name || previous.region,
      routeDescription: route.description || previous.routeDescription,
    }));
  }

  function updateParticipant(participantId: string, patch: Partial<SafetyParticipant>) {
    update('participants', passport.participants.map(item => item.id === participantId ? {...item, ...patch} : item));
  }

  function addParticipant() {
    update('participants', [...passport.participants, blankParticipant(id('participant'))]);
  }

  function removeParticipant(participantId: string) {
    const next = passport.participants.filter(item => item.id !== participantId);
    update('participants', next.length ? next : [blankParticipant(id('participant'))]);
  }

  function writeSavedPassports(list: SafetyPassport[]): boolean {
    try { saveLocalSafetyPassports(localStorage, list); return true; }
    catch (error) {
      setNotice(error instanceof RangeError ? error.message : 'Не удалось записать данные в браузер. Скачайте JSON-копию и проверьте свободное место.');
      return false;
    }
  }

  function persist(next = passport, message = 'Черновик сохранён только на этом устройстве.') {
    const value = next.id === 'new' ? {...next, id: id('passport'), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()} : {...next, updatedAt: new Date().toISOString()};
    const list = [value, ...saved.filter(item => item.id !== value.id)].slice(0, 20);
    if (!writeSavedPassports(list)) return undefined;
    setSavedSnapshot(safetyPassportSnapshot(value));
    setPassport(value);
    setSaved(list);
    setNotice(message);
    return value;
  }

  function removeCurrent() {
    if (passport.id === 'new') { const next = initialPassport(); setSavedSnapshot(safetyPassportSnapshot(next)); setPassport(next); return; }
    if (!window.confirm('Удалить этот паспорт безопасности с устройства?')) return;
    const list = saved.filter(item => item.id !== passport.id);
    if (!writeSavedPassports(list)) return;
    setSaved(list);
    const next = initialPassport();
    setSavedSnapshot(safetyPassportSnapshot(next));
    setPassport(next);
    setNotice('Локальная копия удалена.');
  }

  function startNew() {
    const next = initialPassport();
    setSavedSnapshot(safetyPassportSnapshot(next));
    setPassport(next);
    setSubmittedCheck(false);
    setCoordinates('');
    history.replaceState(null, '', location.pathname);
  }

  function loadPassport(item: SafetyPassport) {
    setSavedSnapshot(safetyPassportSnapshot(item));
    setPassport(item);
    setSubmittedCheck(false);
    setCoordinates('');
    const url = new URL(location.href);
    url.searchParams.set('passport', item.id);
    history.replaceState(null, '', url);
  }

  function setStatus(next: SafetyStatus, patch: Partial<SafetyPassport> = {}) {
    try {
      const candidate = {...passport, ...patch, updatedAt: new Date().toISOString()};
      const transitioned = transitionSafetyPassport(candidate, next);
      persist(transitioned, next === 'ready' ? 'Пакет готов к переносу в официальную форму.' : 'Статус сохранён на этом устройстве.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Не удалось изменить статус.'); }
  }

  async function copyPackage() {
    try { await copyText(buildSafetyPackage(passport)); setNotice('Пакет скопирован. Перенесите сведения в официальную форму МЧС.'); }
    catch { setNotice('Не удалось скопировать пакет. Скачайте текстовый файл.'); }
  }

  async function copyEmergency() {
    try { await copyText(buildEmergencyMessage(passport, coordinates)); setNotice('Аварийное сообщение скопировано. При угрозе жизни звоните 112.'); }
    catch { setNotice('Не удалось скопировать сообщение.'); }
  }

  function locate() {
    if (!navigator.geolocation) { setNotice('Геолокация не поддерживается этим устройством.'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(position => {
      setCoordinates(`${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)} · точность около ${Math.round(position.coords.accuracy)} м`);
      setLocating(false);
    }, () => { setLocating(false); setNotice('Не удалось получить координаты. Проверьте разрешение и сигнал.'); }, {enableHighAccuracy: true, timeout: 12000, maximumAge: 30_000});
  }

  const emergencyMessage = buildEmergencyMessage(passport, coordinates);

  return <div className={styles.page}>
    <Header active="safety"/>
    <main id="main">
      <section className={styles.hero}>
        <div className={styles.heroGrid}>
          <div>
            <span className={styles.kicker}>Безопасность похода</span>
            <h1>Подготовьте уведомление МЧС без потери деталей</h1>
            <p className={styles.heroLead}>Тропник собирает маршрут, состав и контрольные сроки в один паспорт. Отправка выполняется только на официальном сайте МЧС России — сервис не выдаёт черновик за регистрацию и не обещает автоматический вызов спасателей.</p>
          </div>
          <aside className={styles.heroAside}>
            <strong>Что делает помощник</strong>
            <p>Проверяет полноту сведений, рассчитывает ориентир для подачи, готовит переносимый пакет, хранит локальную копию и формирует аварийное сообщение.</p>
            <a href={MCHS_REGISTRATION_URL} target="_blank" rel="noreferrer">Официальная форма МЧС <ArrowSquareOut size={16}/></a>
          </aside>
        </div>
      </section>

      <div className={styles.workspace}>
        <aside className={styles.sidebar} aria-label="Сохранённые паспорта">
          <section className={`${styles.card} ${styles.savedCard}`}>
            <h2>На этом устройстве</h2>
            <div className={styles.savedList}>
              {saved.length ? saved.map(item => <button key={item.id} className={styles.savedButton} aria-current={item.id === passport.id} onClick={() => loadPassport(item)}>
                <strong>{item.routeTitle || 'Без названия'}</strong><span>{statusLabels[item.status]} · {item.startDate || 'дата не указана'}</span>
              </button>) : <p className={styles.hint}>Сохранённых паспортов пока нет.</p>}
            </div>
            <button className={styles.newButton} onClick={startNew}><Plus size={18}/>Новый паспорт</button>
          </section>
          <section className={`${styles.card} ${styles.privacyNote}`}>
            <strong>Персональные данные</strong>
            <p>Черновики остаются только в localStorage этого браузера и не отправляются в Tropnik. Хранилище браузера не является защищённым сейфом: на общем устройстве удалите паспорт после переноса.</p>
          </section>
        </aside>

        <div className={styles.form}>
          <section className={`${styles.card} ${styles.statusCard}`}>
            <div>
              <div className={styles.statusTop}>
                <span className={styles.statusPill} data-state={passport.status}>{passport.status === 'amendment_required' ? <Info size={16}/> : <ShieldCheck size={16}/>} {statusLabels[passport.status]}</span>
                <span className={styles.progressLabel}>{readiness.completed} из {readiness.total} обязательных блоков · {readiness.percent}%</span>
                <span className={`${styles.saveState} ${dirty ? styles.unsaved : ''}`} role="status">{dirty ? 'Есть несохранённые изменения' : passport.id === 'new' ? 'Изменений пока нет' : 'Сохранено на этом устройстве'}</span>
              </div>
              <div className={styles.progressTrack} aria-label={`Готовность ${readiness.percent}%`}><span style={{transform: `scaleX(${readiness.percent / 100})`}}/></div>
            </div>
            <div className={styles.statusActions}>
              <button type="button" className={styles.miniButton} disabled={!dirty} onClick={() => persist()}><NotePencil size={17}/>{dirty ? 'Сохранить изменения' : 'Сохранено'}</button>
              <button className={`${styles.miniButton} ${styles.danger}`} onClick={removeCurrent}><Trash size={17}/>Удалить</button>
            </div>
          </section>

          <section className={`${styles.card} ${styles.section}`}>
            <div className={styles.sectionHeader}><div><h2>Маршрут и сроки</h2><p>Укажите фактическую нитку маршрута, а не только название направления.</p></div><span className={styles.sectionNumber}>01</span></div>
            <div className={styles.fieldGrid}>
              <div className={styles.fieldWide}><label htmlFor="catalog-route">Маршрут из каталога Тропника</label>{catalog ? <select id="catalog-route" value={passport.routeId || ''} disabled={locked} onChange={event => selectRoute(event.target.value)}><option value="">Не выбран — заполню вручную</option>{catalog.routes.map(route => <option key={route.id} value={route.id}>{route.title}</option>)}</select> : <button id="catalog-route" type="button" className={styles.catalogButton} disabled={locked || catalogState === 'loading'} onClick={() => void openCatalog()}><MapPin size={18}/>{catalogState === 'loading' ? 'Загружаем каталог…' : catalogState === 'error' ? 'Повторить загрузку каталога' : 'Выбрать маршрут из каталога'}</button>}<span className={styles.hint}>Каталог загружается только по запросу. Описание остаётся справочным: проверьте ограничения и фактическую нитку перед подачей.</span></div>
              <div className={styles.field}><label htmlFor="route-title">Название маршрута *</label><input id="route-title" value={passport.routeTitle} disabled={locked} onChange={event => update('routeTitle', event.target.value)} placeholder="Например, Бзерпинский карниз"/></div>
              <div className={styles.field}><label htmlFor="region">Регион начала *</label><input id="region" list="safety-regions" value={passport.region} disabled={locked} onChange={event => update('region', event.target.value)} placeholder="Введите регион"/><datalist id="safety-regions">{catalog?.regions.map(region => <option key={region.id} value={region.name}/>)}</datalist></div>
            </div>
            <div className={styles.fieldGridThree} style={{marginTop: 16}}>
              <div className={styles.field}><label htmlFor="start-date">Дата выхода *</label><input id="start-date" type="date" value={passport.startDate} disabled={locked} onChange={event => update('startDate', event.target.value)}/></div>
              <div className={styles.field}><label htmlFor="end-date">Дата возвращения *</label><input id="end-date" type="date" value={passport.endDate} disabled={locked} onChange={event => update('endDate', event.target.value)}/></div>
              <div className={styles.field}><label htmlFor="trip-time-zone">Часовой пояс похода *</label><select id="trip-time-zone" value={passport.timeZone} disabled={locked} onChange={event => update('timeZone', event.target.value)}><option value="">Уточните часовой пояс</option>{['Europe/Kaliningrad','Europe/Moscow','Europe/Samara','Asia/Yekaterinburg','Asia/Omsk','Asia/Krasnoyarsk','Asia/Irkutsk','Asia/Yakutsk','Asia/Vladivostok','Asia/Magadan','Asia/Kamchatka'].map(zone=><option key={zone} value={zone}>{zone}</option>)}</select></div>
              <div className={styles.field}><label htmlFor="return-deadline">Контрольный срок *</label><input id="return-deadline" type="datetime-local" value={passport.returnDeadline} disabled={locked} onChange={event => update('returnDeadline', event.target.value)}/><span className={styles.hint}>Время, после которого контакт вне группы должен начать проверку.</span></div>
            </div>
            <div className={styles.deadline} style={{marginTop: 16}}><Clock size={19}/><div>До выхода проверьте порядок уведомления на официальной форме МЧС и уточните актуальный состав в территориальном органе. Тропник не рассчитывает юридический крайний срок подачи.</div></div>
            <div className={styles.fieldGrid} style={{marginTop: 16}}>
              <div className={styles.field}><label htmlFor="start-point">Точка старта *</label><input id="start-point" value={passport.startPoint} disabled={locked} onChange={event => update('startPoint', event.target.value)} placeholder="Населённый пункт, кордон, координаты"/></div>
              <div className={styles.field}><label htmlFor="finish-point">Точка завершения *</label><input id="finish-point" value={passport.finishPoint} disabled={locked} onChange={event => update('finishPoint', event.target.value)} placeholder="Финиш и способ выхода к связи"/></div>
              <div className={styles.fieldWide}><label htmlFor="route-description">Подробное описание маршрута *</label><textarea id="route-description" value={passport.routeDescription} disabled={locked} onChange={event => update('routeDescription', event.target.value)} placeholder="Дневные переходы, ночёвки, перевалы, реки, контрольные точки"/></div>
              <div className={styles.fieldWide}><label htmlFor="reserve-route">Запасной вариант</label><textarea id="reserve-route" value={passport.reserveRoute} disabled={locked} onChange={event => update('reserveRoute', event.target.value)} placeholder="Когда группа меняет план и куда выходит"/></div>
              <div className={styles.fieldWide}><label htmlFor="emergency-exits">Аварийные выходы</label><textarea id="emergency-exits" value={passport.emergencyExits} disabled={locked} onChange={event => update('emergencyExits', event.target.value)} placeholder="Ближайшие дороги, приюты, кордоны, места устойчивой связи"/></div>
            </div>
          </section>

          <section className={`${styles.card} ${styles.section}`}>
            <div className={styles.sectionHeader}><div><h2>Ответственные и связь</h2><p>Контакт вне группы должен знать контрольный срок и не находиться на маршруте.</p></div><span className={styles.sectionNumber}>02</span></div>
            <div className={styles.fieldGrid}>
              <div className={styles.field}><label htmlFor="leader-name">Руководитель *</label><input id="leader-name" value={passport.leaderName} disabled={locked} onChange={event => update('leaderName', event.target.value)} autoComplete="name"/></div>
              <div className={styles.field}><label htmlFor="leader-phone">Телефон руководителя *</label><input id="leader-phone" value={passport.leaderPhone} disabled={locked} onChange={event => update('leaderPhone', event.target.value)} inputMode="tel" autoComplete="tel" placeholder="+7 …"/></div>
              <div className={styles.field}><label htmlFor="leader-email">Электронная почта</label><input id="leader-email" type="email" value={passport.leaderEmail} disabled={locked} onChange={event => update('leaderEmail', event.target.value)} autoComplete="email"/></div>
              <div className={styles.field}><label htmlFor="transport">Транспорт</label><input id="transport" value={passport.transport} disabled={locked} onChange={event => update('transport', event.target.value)} placeholder="Автомобиль, автобус, лодка; номера при необходимости"/></div>
              <div className={styles.field}><label htmlFor="outside-name">Контакт вне группы *</label><input id="outside-name" value={passport.outsideContactName} disabled={locked} onChange={event => update('outsideContactName', event.target.value)} autoComplete="name"/></div>
              <div className={styles.field}><label htmlFor="outside-phone">Телефон контакта *</label><input id="outside-phone" value={passport.outsideContactPhone} disabled={locked} onChange={event => update('outsideContactPhone', event.target.value)} inputMode="tel" autoComplete="tel" placeholder="+7 …"/></div>
              <div className={styles.fieldWide}><label htmlFor="communication">Способы связи *</label><textarea id="communication" value={passport.communication} disabled={locked} onChange={event => update('communication', event.target.value)} placeholder="Телефоны, спутниковый коммуникатор, радиостанции, расписание контрольных сеансов"/></div>
              <div className={styles.fieldWide}><label htmlFor="equipment">Групповое аварийное снаряжение</label><textarea id="equipment" value={passport.equipment} disabled={locked} onChange={event => update('equipment', event.target.value)} placeholder="Аптечка, навигация, ремонтный набор, укрытие, резерв питания"/></div>
            </div>
          </section>

          <section className={`${styles.card} ${styles.section}`}>
            <div className={styles.sectionHeader}><div><h2>Состав группы</h2><p>В официальный пакет включайте людей, которые действительно планируют выход. Перед стартом уточните изменения.</p></div><span className={styles.sectionNumber}>03</span></div>
            <div className={styles.participants}>
              {passport.participants.map((participant, index) => <article className={styles.participant} key={participant.id}>
                <div className={styles.participantHeader}><strong>Участник {index + 1}</strong><button className={styles.removeParticipant} aria-label={`Удалить участника ${index + 1}`} disabled={locked} onClick={() => removeParticipant(participant.id)}><X size={18}/></button></div>
                <div className={styles.fieldGrid}>
                  <div className={styles.field}><label htmlFor={`participant-name-${participant.id}`}>Имя и фамилия *</label><input id={`participant-name-${participant.id}`} value={participant.name} disabled={locked} onChange={event => updateParticipant(participant.id, {name: event.target.value})}/></div>
                  <div className={styles.field}><label htmlFor={`participant-phone-${participant.id}`}>Телефон *</label><input id={`participant-phone-${participant.id}`} value={participant.phone} disabled={locked} inputMode="tel" onChange={event => updateParticipant(participant.id, {phone: event.target.value})}/></div>
                  <div className={styles.field}><label htmlFor={`emergency-name-${participant.id}`}>Аварийный контакт</label><input id={`emergency-name-${participant.id}`} value={participant.emergencyName} disabled={locked} onChange={event => updateParticipant(participant.id, {emergencyName: event.target.value})}/></div>
                  <div className={styles.field}><label htmlFor={`emergency-phone-${participant.id}`}>Телефон контакта</label><input id={`emergency-phone-${participant.id}`} value={participant.emergencyPhone} disabled={locked} inputMode="tel" onChange={event => updateParticipant(participant.id, {emergencyPhone: event.target.value})}/></div>
                </div>
                <label className={styles.participantMinor}><input type="checkbox" checked={participant.minor} disabled={locked} onChange={event => updateParticipant(participant.id, {minor: event.target.checked})}/>Несовершеннолетний участник</label>
              </article>)}
              <button className={styles.addParticipant} disabled={locked} onClick={addParticipant}><Plus size={19}/>Добавить участника</button>
            </div>
          </section>

          <section className={`${styles.card} ${styles.section}`}>
            <div className={styles.sectionHeader}><div><h2>Официальное уведомление</h2><p>Тропник готовит данные, но не отправляет их от вашего имени и не получает ведомственный статус автоматически.</p></div><span className={styles.sectionNumber}>04</span></div>
            <div className={styles.officialBox}>
              <h3>1. Подготовьте переносимый пакет</h3>
              <p>Перед отправкой сверьте маршрут, сроки и состав. Если критичные данные меняются после подачи, статус автоматически станет «Нужно обновить уведомление».</p>
              <div className={styles.officialActions}>
                <button className={styles.secondaryButton} onClick={copyPackage}><Export size={18}/>Скопировать пакет</button>
                <button className={styles.secondaryButton} onClick={() => download(fileName(passport, 'txt'), buildSafetyPackage(passport), 'text/plain;charset=utf-8')}><DownloadSimple size={18}/>Скачать текст</button>
                <button className={styles.secondaryButton} onClick={() => download(fileName(passport, 'json'), JSON.stringify(passport, null, 2), 'application/json')}><DownloadSimple size={18}/>Скачать JSON</button>
              </div>
              {passport.status === 'draft' || passport.status === 'amendment_required' ? <button className={styles.primaryLink} disabled={!readiness.complete} onClick={() => setStatus('ready')}><CheckCircle size={19}/>{passport.status === 'amendment_required' ? 'Пакет исправлен — готов к повторной подаче' : 'Отметить пакет готовым'}</button> : null}
            </div>
            <div className={styles.officialBox} style={{marginTop: 14}}>
              <h3>2. Отправьте данные на официальном сайте</h3>
              <p>На сайте МЧС выберите подходящий тип заявителя, перенесите сведения, дайте согласие на обработку персональных данных и завершите отправку.</p>
              <div className={styles.officialActions}><a className={styles.primaryLink} aria-disabled={passport.status !== 'ready'} href={passport.status === 'ready' ? MCHS_REGISTRATION_URL : undefined} target="_blank" rel="noreferrer">Открыть форму МЧС <ArrowSquareOut size={18}/></a></div>
              <label className={styles.checkline}><input type="checkbox" checked={submittedCheck} onChange={event => setSubmittedCheck(event.target.checked)}/>Я действительно завершил отправку на официальном сайте. Переход по ссылке сам по себе не является регистрацией.</label>
              {passport.status === 'ready' && <button className={styles.secondaryButton} disabled={!submittedCheck} onClick={() => setStatus('submitted')}><Check size={18}/>Отметить отправку</button>}
            </div>
            <div className={styles.officialBox} style={{marginTop: 14}}>
              <h3>3. Сохраните подтверждение и закройте маршрут</h3>
              <div className={styles.fieldWide}><label htmlFor="mchs-reference">Номер или описание подтверждения</label><input id="mchs-reference" value={passport.mchsReference} disabled={locked} onChange={event => update('mchsReference', event.target.value)} placeholder="Регистрационный номер, письмо или иной идентификатор"/></div>
              {passport.status === 'submitted' && <button className={styles.primaryLink} disabled={!passport.mchsReference.trim()} onClick={() => setStatus('confirmed')}><ShieldCheck size={18}/>Подтверждение получено</button>}
              {passport.status === 'confirmed' && <button className={styles.secondaryButton} onClick={() => setStatus('active', {prestartCallAt: new Date().toISOString()})}><CheckCircle size={18}/>Предвыходные сведения уточнены</button>}
              {passport.status === 'active' && <button className={styles.primaryLink} onClick={() => setStatus('closed', {returnedAt: new Date().toISOString()})}><CheckCircle size={18}/>Возвращение подтверждено и МЧС уведомлено</button>}
              <div className={styles.warning}><Info size={18}/><span>Не отмечайте этап заранее. Приложение хранит только вашу локальную отметку и не подтверждает действия территориального органа МЧС.</span></div>
            </div>
          </section>

          <section className={`${styles.card} ${styles.saveBar}`}>
            <div className={styles.saveDescription}><p>{statusDescriptions[passport.status]}</p><p>Все отметки этой формы хранятся на устройстве. Они не являются проверкой регистрации МЧС со стороны Тропника.</p></div>
            <div className={styles.saveActions}><Link prefetch={false} className={styles.secondaryButton} href="/offline-safety.html">Открыть автономную карточку</Link><button className={styles.secondaryButton} onClick={() => window.print()}>Печать</button><button className={styles.primaryLink} onClick={() => persist()}><NotePencil size={18}/>Сохранить на устройстве</button></div>
          </section>
        </div>

        <aside className={styles.summary} aria-label="Сводка паспорта безопасности">
          <section className={`${styles.card} ${styles.summaryCard}`}>
            <h2>Сводка</h2>
            <div className={styles.summaryRows}>
              <div className={styles.summaryRow}><span>Статус</span><strong>{statusLabels[passport.status]}</strong></div>
              <div className={styles.summaryRow}><span>Маршрут</span><strong>{passport.routeTitle || 'не указан'}</strong></div>
              <div className={styles.summaryRow}><span>Период</span><strong>{passport.startDate && passport.endDate ? `${dateLabel(passport.startDate)} — ${dateLabel(passport.endDate)}` : 'не указан'}</strong></div>
              <div className={styles.summaryRow}><span>Участники</span><strong>{passport.participants.filter(item => item.name.trim()).length}</strong></div>
              <div className={styles.summaryRow}><span>Уведомление</span><strong>через официальный ресурс</strong></div>
              <div className={styles.summaryRow}><span>МЧС</span><strong>{passport.mchsReference || 'подтверждение не указано'}</strong></div>
              <div className={styles.summaryRow}><span>Предвыходное уточнение</span><strong>{timeLabel(passport.prestartCallAt)}</strong></div>
              <div className={styles.summaryRow}><span>Возвращение</span><strong>{timeLabel(passport.returnedAt)}</strong></div>
            </div>
            {!readiness.complete && <div className={styles.missing}><strong>Не заполнено</strong><ul>{readiness.missing.slice(0, 7).map(item => <li key={item}>{item}</li>)}{readiness.missing.length > 7 && <li>И ещё {readiness.missing.length - 7}</li>}</ul></div>}
          </section>
          <section className={`${styles.card} ${styles.emergency}`}>
            <h2>Аварийная карточка</h2>
            <p>{emergencyMessage}</p>
            <div className={styles.emergencyActions}>
              <a className={styles.call112} href="tel:112">Позвонить 112</a>
              <button className={styles.copyEmergency} onClick={copyEmergency}>Скопировать сообщение</button>
              <button className={styles.copyEmergency} disabled={locating} onClick={locate}><MapPin size={18}/>{locating ? 'Определяем…' : 'Добавить координаты'}</button>
            </div>
            {coordinates && <div className={styles.coordinates}>{coordinates}</div>}
          </section>
          <section className={`${styles.card} ${styles.privacyNote}`}>
            <strong><UsersThree size={18}/> Важно для группы</strong>
            <p>Перед стартом каждый участник должен знать маршрут, контрольный срок, аварийные выходы и контакт человека вне группы.</p>
          </section>
        </aside>
      </div>
    </main>
    <Footer/>
    {notice && <div className={styles.notice} role="status" aria-live="polite">{notice}</div>}
  </div>;
}
