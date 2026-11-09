'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {Mountains, Backpack, CheckCircle, Info} from '@/components/TropnikIcons';
import {api, announceAuth, errorText, isAbort, serviceStatus, type User} from '@/lib/api';
import {Modal} from './Modal';

export function AuthDialog({onClose, onUser}: {onClose: () => void; onUser: (user: User) => void}) {
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [role, setRole] = useState<'tourist' | 'guide'>('tourist');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [consent, setConsent] = useState(false);
  const [service, setService] = useState<'checking' | 'ready' | 'preview' | 'error'>('checking');
  const submitting = useRef(false);
  const check = useCallback(async (signal?: AbortSignal) => {
    setService('checking');
    try { setService(await serviceStatus(signal) ? 'ready' : 'preview'); }
    catch (error) { if (!isAbort(error)) setService('error'); }
  }, []);
  // Start/cancel the external readiness check with this dialog lifecycle.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { const controller = new AbortController(); void check(controller.signal); return () => controller.abort(); }, [check]);
  const close = useCallback(() => { if (!submitting.current) onClose(); }, [onClose]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current || service !== 'ready') return;
    const displayName = name.trim();
    if (mode === 'register' && (!consent || [...displayName].length < 2 || [...displayName].length > 80 || [...password].length < 12 || [...password].length > 128)) {
      setError('Проверьте имя, пароль из 12–128 символов и согласие с условиями.');
      return;
    }
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      const value = await api<{user: User}>('auth/' + mode, {method: 'POST', body: JSON.stringify({email: email.trim(), password, ...(mode === 'register' ? {displayName, role} : {})})});
      if (!value?.user?.id) throw new Error('Не удалось подтвердить вход. Повторите попытку.');
      onUser(value.user);
      announceAuth(value.user);
      onClose();
    } catch (error) { setError(errorText(error)); }
    finally { submitting.current = false; setPending(false); }
  }

  return <Modal title={mode === 'register' ? 'Ваш путь начинается здесь' : 'Рады снова видеть'} onClose={close}>
    <p className="muted">Сохраняйте маршруты, находите компанию и готовьтесь к походу вместе.</p>
    <div className="segmented">
      <button type="button" disabled={pending} className={mode === 'register' ? 'active' : ''} aria-pressed={mode === 'register'} onClick={() => { setMode('register'); setError(''); }}>Регистрация</button>
      <button type="button" disabled={pending} className={mode === 'login' ? 'active' : ''} aria-pressed={mode === 'login'} onClick={() => { setMode('login'); setError(''); }}>Войти</button>
    </div>
    <form onSubmit={submit} className="stack">
      {mode === 'register' && <>
        <div className="role-options">
          <button type="button" disabled={pending} className={'role-option ' + (role === 'tourist' ? 'selected' : '')} aria-pressed={role === 'tourist'} onClick={() => setRole('tourist')}><Backpack size={26}/><span><strong>Турист</strong><small>Ищу новые маршруты</small></span>{role === 'tourist' && <CheckCircle size={20}/>}</button>
          <button type="button" disabled={pending} className={'role-option ' + (role === 'guide' ? 'selected' : '')} aria-pressed={role === 'guide'} onClick={() => setRole('guide')}><Mountains size={26}/><span><strong>Гид</strong><small>Хочу вести группы</small></span>{role === 'guide' && <CheckCircle size={20}/>}</button>
        </div>
        {role === 'guide' && <div className="inline-note"><Info size={20}/><span>Роль гида создаёт заявку на проверку. Вести группы можно только после отдельного подтверждения допуска.</span></div>}
        <label>Как вас зовут<input required minLength={2} maxLength={80} disabled={pending} autoComplete="name" value={name} onChange={event => setName(event.target.value)} placeholder="Имя и фамилия"/></label>
      </>}
      <label>Электронная почта<input required type="email" maxLength={254} disabled={pending} autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="name@example.ru"/></label>
      <label>Пароль<input required type="password" disabled={pending} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength={mode === 'register' ? 12 : 1} maxLength={256} value={password} onChange={event => setPassword(event.target.value)} placeholder={mode === 'register' ? 'От 12 до 128 символов' : 'Ваш пароль'}/></label>
      {mode === 'register' && <label className="check-label"><input required type="checkbox" disabled={pending} checked={consent} onChange={event => setConsent(event.target.checked)}/><span>Мне исполнилось 18 лет. Я принимаю <a href="/terms" target="_blank" rel="noreferrer">условия</a> и ознакомился с <a href="/privacy" target="_blank" rel="noreferrer">обработкой данных</a>.</span></label>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <button className="button primary full" disabled={pending || service !== 'ready' || mode === 'register' && !consent}>{pending ? 'Ожидаем ответ…' : mode === 'register' ? 'Создать аккаунт' : 'Войти'}</button>
      {mode === 'login' && <a className="text-link" href="/account/action">Не помню пароль</a>}
      {mode === 'register' && <p className="field-help">После создания аккаунта запросим письмо для подтверждения почты. Если оно не придёт, можно запросить новое в личном кабинете.</p>}
      {service === 'checking' && <p className="fineprint" role="status">Проверяем доступность входа…</p>}
      {service === 'preview' && <p className="fineprint">Вход и регистрация пока недоступны. Избранное и сохранённые карточки можно использовать без аккаунта.</p>}
      {service === 'error' && <div className="inline-note"><span>Не удалось проверить доступность входа. Попробуйте ещё раз.</span><button className="text-link" type="button" onClick={() => void check()}>Проверить снова</button></div>}
    </form>
  </Modal>;
}
