'use client';

import {useEffect, useRef, useState} from 'react';
import {CheckCircle, LockKey, ShieldCheck} from '@/components/TropnikIcons';
import {api, announceAuth, errorText, type User} from '@/lib/api';
import {parseAccountAction, validAccountPassword, type AccountAction} from '@/lib/account-action';
import type {AccountMailResponse} from '@/lib/contract';
import styles from './AccountLifecycle.module.css';

export function AccountLifecycle({user}: {user: User}) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false), [password, setPassword] = useState(''), [understood, setUnderstood] = useState(false);
  const operation = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function request(purpose: 'email' | 'password') {
    if (operation.current) return;
    operation.current = true; setBusy(true); setMessage(''); setError('');
    try {
      const response = await api<AccountMailResponse>(`auth/${purpose}/request`, {method: 'POST', body: JSON.stringify({email: user.email})});
      if (alive.current) setMessage(response.message);
    } catch (error) { if (alive.current) setError(errorText(error)); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  }

  async function remove(event: React.FormEvent) {
    event.preventDefault();
    if (operation.current || !understood || !password) return;
    operation.current = true; setBusy(true); setMessage(''); setError('');
    try {
      await api<void>('me/delete', {method: 'POST', body: JSON.stringify({password, confirmation: 'delete'})});
      setPassword('');
      announceAuth(null);
    } catch (error) { if (alive.current) setError(errorText(error)); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  }

  if (user.staffRole !== 'none') return <section className="account-card"><div className="card-heading"><LockKey size={22}/><h3>Доступ к аккаунту</h3></div><p className="muted">Восстановление доступа к служебному аккаунту и его закрытие выполняет оператор сервиса.</p></section>;

  return <section className="account-card">
    <div className="card-heading"><LockKey size={22}/><h3>Почта и безопасность</h3></div>
    <div className="stack">
      <p className={user.emailVerified ? 'success-inline' : 'muted'}>{user.emailVerified ? <><CheckCircle size={17}/>Почта подтверждена</> : 'Почта пока не подтверждена. Откройте письмо Tropnik и подтвердите адрес.'}</p>
      <div className={styles.actions}>
        {!user.emailVerified && <button className="button secondary small" type="button" disabled={busy} onClick={() => void request('email')}>Запросить письмо</button>}
        <button className="text-link" type="button" disabled={busy} onClick={() => void request('password')}>Изменить пароль</button>
      </div>
      <p className="field-help">Ссылка для нового пароля придёт на вашу почту. После смены пароля потребуется снова войти на всех устройствах.</p>
      {message && <p className="success-inline" role="status">{message}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {busy && <p className="muted" role="status">Ожидаем ответ…</p>}
      {user.staffRole === 'none' && (!deleting ? <button type="button" className="text-link" disabled={busy} onClick={() => {setDeleting(true); setMessage(''); setError('');}}>Удалить аккаунт</button> : <form className="stack" onSubmit={remove}>
        <h4>Удаление аккаунта</h4>
        <p>Вход будет закрыт на всех устройствах. Почта и публичное имя будут удалены из профиля. История походов, сообщения, отзывы и обращения сохранятся с обезличенным автором; служебные записи о допусках и решениях сохраняются для проверки.</p>
        <p className="field-help">Тексты ваших публикаций могут содержать контакты. Удаление аккаунта само по себе их не очищает. Сначала завершите участие в текущих походах и закройте свои открытые заявки. Гиду нужно завершить или отменить выход.</p>
        <label>Текущий пароль<input type="password" autoComplete="current-password" required maxLength={256} disabled={busy} value={password} onChange={event => setPassword(event.target.value)}/></label>
        <label className="check-label"><input type="checkbox" required checked={understood} disabled={busy} onChange={event => setUnderstood(event.target.checked)}/><span>Понимаю, что восстановить этот аккаунт после удаления нельзя.</span></label>
        <div className={styles.actions}><button className="button secondary" disabled={busy || !understood || !password}>Удалить аккаунт</button><button type="button" className="text-link" disabled={busy} onClick={() => {setDeleting(false); setPassword(''); setUnderstood(false); setError('');}}>Отмена</button></div>
      </form>)}
    </div>
  </section>;
}

export function AccountActionScreen() {
  const [action, setAction] = useState<AccountAction | null>(null), [ready, setReady] = useState(false), [invalidLink, setInvalidLink] = useState(false);
  const [purpose, setPurpose] = useState<'password' | 'email'>('password'), [email, setEmail] = useState('');
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [done, setDone] = useState(false);
  const initialized = useRef(false), operation = useRef(false), alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!initialized.current) {
      initialized.current = true;
      const fragment = location.hash, parsed = parseAccountAction(fragment);
      // Read once, then remove the secret before any user action or API call.
      history.replaceState(history.state, '', location.pathname);
      setAction(parsed); setInvalidLink(!!fragment && !parsed); setReady(true);
    }
    return () => { alive.current = false; };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (operation.current) return;
    if (action?.action === 'reset_password' && (!validAccountPassword(password) || password !== confirmation)) {
      setError('Введите одинаковый пароль из 12–128 символов в обоих полях.'); return;
    }
    operation.current = true; setBusy(true); setError(''); setMessage('');
    try {
      if (!action) {
        const response = await api<AccountMailResponse>(`auth/${purpose}/request`, {method: 'POST', body: JSON.stringify({email: email.trim()})});
        if (alive.current) setMessage(response.message);
      } else {
        const reset = action.action === 'reset_password';
        await api(reset ? 'auth/password/reset' : 'auth/email/confirm', {method: 'POST', body: JSON.stringify(reset ? {token: action.token, password, passwordConfirmation: confirmation} : {token: action.token})});
        if (reset) announceAuth(null);
        if (alive.current) {setAction(null); setPassword(''); setConfirmation(''); setDone(true); setMessage(reset ? 'Пароль изменён. Вы вышли из аккаунта на всех устройствах. Войдите заново.' : 'Почта подтверждена. Можно вернуться в личный кабинет.');}
      }
    } catch (error) { if (alive.current) setError(errorText(error)); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  }

  const title = done ? 'Готово' : action?.action === 'verify_email' ? 'Подтвердите почту' : action?.action === 'reset_password' ? 'Новый пароль' : 'Доступ к аккаунту';
  return <section className={`account-card ${styles.action}`}>
    <div className="card-heading"><ShieldCheck size={24}/><h1>{title}</h1></div>
    {!ready ? <p role="status">Открываем ссылку…</p> : done ? <div className="stack"><p className="success-inline" role="status"><CheckCircle size={20}/>{message}</p><a className="button primary" href="/account">В личный кабинет</a></div> : <form className="stack" onSubmit={submit}>
      {invalidLink && !action && <p className="notice-block warning">Эта ссылка не подходит. Запросите новую на вашу почту.</p>}
      {!action ? <>
        <p className="muted">Укажите почту, с которой создавали аккаунт. Мы попробуем отправить ссылку для выбранного действия.</p>
        <div className="segmented"><button type="button" className={purpose === 'password' ? 'active' : ''} aria-pressed={purpose === 'password'} disabled={busy} onClick={() => {setPurpose('password'); setMessage(''); setError('');}}>Новый пароль</button><button type="button" className={purpose === 'email' ? 'active' : ''} aria-pressed={purpose === 'email'} disabled={busy} onClick={() => {setPurpose('email'); setMessage(''); setError('');}}>Подтвердить почту</button></div>
        <label>Электронная почта<input type="email" autoComplete="email" required maxLength={254} disabled={busy} value={email} onChange={event => setEmail(event.target.value)}/></label>
      </> : action.action === 'reset_password' ? <>
        <p className="muted">Придумайте пароль из 12–128 символов. После сохранения потребуется снова войти на всех устройствах.</p>
        <label>Новый пароль<input type="password" autoComplete="new-password" required minLength={12} maxLength={256} disabled={busy} value={password} onChange={event => setPassword(event.target.value)}/></label>
        <label>Повторите пароль<input type="password" autoComplete="new-password" required minLength={12} maxLength={256} disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)}/></label>
      </> : <p className="muted">Нажмите кнопку, если вы создавали аккаунт Tropnik и хотите подтвердить этот адрес.</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {message && <p className="success-inline" role="status">{message}</p>}
      <button className="button primary" disabled={busy}>{busy ? 'Ожидаем ответ…' : action?.action === 'reset_password' ? 'Сохранить новый пароль' : action ? 'Подтвердить почту' : 'Запросить ссылку'}</button>
      {action && <button className="text-link" type="button" disabled={busy} onClick={() => {setPurpose(action.action === 'verify_email' ? 'email' : 'password'); setAction(null); setError('');}}>Запросить новую ссылку</button>}
      <a className="text-link" href="/account">В личный кабинет</a>
    </form>}
  </section>;
}
