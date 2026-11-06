'use client';

import {useEffect, useState, useCallback, useRef} from 'react';
import {ShieldCheck, UserCircle, ArrowRight, ArrowClockwise} from '@/components/TropnikIcons';
import {api, ApiError, AUTH_EVENT, announceAuth, errorText, isAbort, type AuthChange, type User} from '@/lib/api';
import {AuthDialog} from './AuthDialog';

const guideStates: Record<User['guideStatus'], string> = {
  none: 'Профиль туриста',
  pending: 'Заявка гида ожидает проверки',
  verified: 'Есть действующий допуск гида',
  suspended: 'Допуск временно приостановлен',
  expired: 'Срок допуска истёк',
};

export function GuidePanel() {
  const [user, setUser] = useState<User | null>(null);
  const [auth, setAuth] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const submitting = useRef(false);
  const sync = useCallback(async (signal?: AbortSignal) => {
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    try { const profile = await api<User>('me', {signal}); if (request === sequence.current) setUser(profile); }
    catch (error) {
      if (isAbort(error) || request !== sequence.current) return;
      setUser(null);
      if (!(error instanceof ApiError && (error.status === 401 || error.code === 'service_not_configured'))) setError(errorText(error));
    } finally { if (request === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void sync(controller.signal);
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<AuthChange>).detail;
      if (detail && Object.prototype.hasOwnProperty.call(detail, 'user')) {
        ++sequence.current;
        setUser(detail.user);
        setLoading(false);
        setError('');
      } else void sync();
    };
    const storage = (event: StorageEvent) => { if (event.key === 'tropa-auth-change') void sync(); };
    window.addEventListener(AUTH_EVENT, changed);
    window.addEventListener('storage', storage);
    return () => { ++sequence.current; controller.abort(); window.removeEventListener(AUTH_EVENT, changed); window.removeEventListener('storage', storage); };
  }, [sync]);
  const close = useCallback(() => setAuth(false), []);

  async function applyAsGuide() {
    if (!user || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      const profile = await api<User>('me/profile', {method: 'PATCH', body: JSON.stringify({displayName: user.displayName, role: 'guide'})});
      setUser(profile);
      announceAuth(profile);
    } catch (error) { setError(errorText(error)); }
    finally { submitting.current = false; setPending(false); }
  }

  return <>
    <div className="guide-state">
      <ShieldCheck size={30}/>
      <div><strong>{user ? user.displayName : 'Профиль гида'}</strong>
        <p>{loading ? 'Проверяем статус профиля…' : user ? guideStates[user.guideStatus] : 'Выберите роль при регистрации. Проверка допуска проходит отдельно.'}</p>
        {user?.guideStatus === 'verified' && <p>Для каждого маршрута проверяются квалификация гида и срок допуска.</p>}
        {user && ['pending', 'expired', 'suspended'].includes(user.guideStatus) && <p>Назначение выходов доступно после проверки действующих оснований оператором.</p>}
      </div>
      {!loading && (user?.guideStatus === 'verified' ? <a className="button primary small" style={{marginLeft: 'auto'}} href="/trips?tab=requests">К запросам <ArrowRight size={16}/></a>
        : user?.role === 'tourist' ? <button className="button primary small" style={{marginLeft: 'auto'}} disabled={pending} onClick={() => void applyAsGuide()}>{pending ? 'Сохраняем заявку…' : 'Подать заявку гида'}</button>
        : user ? <button className="button secondary small" style={{marginLeft: 'auto'}} onClick={() => void sync()}><ArrowClockwise size={17}/>Обновить статус</button>
        : <button className="button primary small" style={{marginLeft: 'auto'}} onClick={() => setAuth(true)}><UserCircle size={17}/>Войти или зарегистрироваться</button>)}
    </div>
    {error && <p className="error-message" role="alert">{error}</p>}
    {auth && <AuthDialog onClose={close} onUser={setUser}/>}
  </>;
}
