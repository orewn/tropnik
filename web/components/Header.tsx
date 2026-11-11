'use client';

import Link from 'next/link';
import {memo, useState, useEffect, useCallback, useRef} from 'react';
import {ArrowDown, UserCircle, CheckCircle, MagnifyingGlass} from '@/components/TropnikIcons';
import {Brand} from './Brand';
import {AuthDialog} from './AuthDialog';
import {api, ApiError, AUTH_EVENT, announceAuth, errorText, isAbort, type AuthChange, type User} from '@/lib/api';
import styles from './Header.module.css';

export const Header = memo(function Header({active = 'map'}: {active?: string}) {
  const [auth, setAuth] = useState(false);
  const [menu, setMenu] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const sequence = useRef(0);
  const logoutPending = useRef(false);
  const searchLink = useRef<HTMLAnchorElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('[role="dialog"]')) return;
      const field = document.querySelector<HTMLInputElement>('[data-site-search-input]');
      if (field) {event.preventDefault(); field.focus(); field.select(); return;}
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input,textarea,select,[role="dialog"]'))) return;
      if (!searchLink.current) return;
      event.preventDefault();
      const destination = new URL(searchLink.current.href);
      destination.hash = 'search-query';
      location.assign(destination.href);
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => {
    const authSequence = sequence;
    let controller: AbortController | null = null;
    const sync = async () => {
      const request = ++authSequence.current;
      controller?.abort();
      controller = new AbortController();
      try { const profile = await api<User>('me', {signal: controller.signal}); if (request === authSequence.current) setUser(profile); }
      catch (error) { if (!isAbort(error) && request === authSequence.current) setUser(null); }
    };
    const authChanged = (event: Event) => {
      const detail = (event as CustomEvent<AuthChange>).detail;
      if (detail && Object.prototype.hasOwnProperty.call(detail, 'user')) {
        ++authSequence.current;
        controller?.abort();
        setUser(detail.user);
      } else void sync();
    };
    const storageChanged = (event: StorageEvent) => { if (event.key === 'tropa-auth-change') void sync(); };
    void sync();
    window.addEventListener(AUTH_EVENT, authChanged);
    window.addEventListener('storage', storageChanged);
    return () => { ++authSequence.current; controller?.abort(); window.removeEventListener(AUTH_EVENT, authChanged); window.removeEventListener('storage', storageChanged); };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    const media = window.matchMedia('(max-width: 1024px)');
    const mobile = media.matches;
    if (mobile) { document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden'; }
    const focusable = () => [...(header.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])') ?? [])]
      .filter(element => element.getClientRects().length > 0 && !element.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(element).visibility !== 'hidden');
    const focusFrame = requestAnimationFrame(() => navigation.current?.querySelector<HTMLElement>('a[href]')?.focus({preventScroll: true}));
    const background = mobile ? [...document.querySelectorAll<HTMLElement>('main,footer')].map(element => ({element, inert: element.inert})) : [];
    for (const {element} of background) element.inert = true;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenu(false);
        requestAnimationFrame(() => menuButton.current?.focus({preventScroll: true}));
        return;
      }
      if (event.key !== 'Tab' || !mobile) return;
      const items = focusable();
      const first = items[0], last = items.at(-1);
      if (!first || !last) return;
      const outsideHeader = !header.current?.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || outsideHeader)) { event.preventDefault(); last.focus({preventScroll: true}); }
      else if (!event.shiftKey && (document.activeElement === last || outsideHeader)) { event.preventDefault(); first.focus({preventScroll: true}); }
    };
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || navigation.current?.contains(target) || menuButton.current?.contains(target)) return;
      setMenu(false);
    };
    const resize = () => { if (!media.matches) setMenu(false); };
    window.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    media.addEventListener('change', resize);
    return () => {
      cancelAnimationFrame(focusFrame);
      for (const {element, inert} of background) element.inert = inert;
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
      window.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
      media.removeEventListener('change', resize);
    };
  }, [menu]);
  const close = useCallback(() => setAuth(false), []);

  async function logout() {
    if (logoutPending.current) return;
    logoutPending.current = true;
    setPending(true);
    setNotice('');
    ++sequence.current;
    try {
      await api<void>('auth/logout', {method: 'POST', body: '{}'});
      setUser(null);
      announceAuth(null);
      setNotice('Вы вышли из аккаунта.');
    } catch (error) {
      if (error instanceof ApiError && error.localSessionCleared) {
        setUser(null);
        announceAuth(null);
        setNotice('На этом устройстве вы вышли. Не удалось подтвердить завершение входа: проверьте подключение и повторите попытку.');
      } else {
        setNotice('Выход не подтверждён. Аккаунт может оставаться открытым на этом устройстве. ' + errorText(error));
      }
    } finally { logoutPending.current = false; setPending(false); }
  }

  return <>
    <header ref={header} className={`site-header ${styles.header}`}>
      <Brand/>
      <nav ref={navigation} id="main-navigation" aria-label="Основная навигация" className={menu ? 'top-nav open' : 'top-nav'} onClick={event=>{if((event.target as HTMLElement).closest('a[href]'))setMenu(false);}}>
        <Link className={active === 'map' ? 'active' : ''} aria-current={active === 'map' ? 'page' : undefined} href="/">Карта маршрутов</Link>
        <a className={active === 'planner' ? 'active' : ''} aria-current={active === 'planner' ? 'page' : undefined} href="/planner">Конструктор</a>
        <a className={active === 'trips' ? 'active' : ''} aria-current={active === 'trips' ? 'page' : undefined} href="/trips">Походы</a>
        <a className={active === 'community' ? 'active' : ''} aria-current={active === 'community' ? 'page' : undefined} href="/community">Сообщество</a>
        <a className={active === 'guides' ? 'active' : ''} aria-current={active === 'guides' ? 'page' : undefined} href="/guides">Гидам</a>
        <a className={`${styles.menuSearchLink}${active === 'search' ? ' active' : ''}`} aria-current={active === 'search' ? 'page' : undefined} href="/search" onClick={() => setMenu(false)}>Поиск по сайту</a>
        <a className={`${styles.menuOfflineLink}${active === 'offline' ? ' active' : ''}`} aria-current={active === 'offline' ? 'page' : undefined} href="/offline" onClick={() => setMenu(false)}>Карты с собой</a>
        {user && <a className={active === 'account' ? 'active' : ''} aria-current={active === 'account' ? 'page' : undefined} href="/account">Кабинет</a>}
      </nav>
      <div className={`header-actions ${styles.actions}`}>
        <a ref={searchLink} href="/search" className={`icon-button ${styles.searchLink}`} aria-label="Поиск по сайту" aria-keyshortcuts="Control+K Meta+K" aria-current={active === 'search' ? 'page' : undefined} title="Поиск по сайту (Ctrl/Cmd+K)" onClick={() => setMenu(false)}><MagnifyingGlass size={22}/></a>
        <a href="/offline" className={`offline-link ${styles.offlineLink}`} aria-label="Карты с собой" title="Карты с собой"><ArrowDown size={18}/><span>Офлайн</span></a>
        {user ? <button className={`button secondary small ${styles.sessionButton}`} onClick={() => void logout()} disabled={pending} aria-label={pending ? 'Выходим из аккаунта' : 'Выйти из аккаунта ' + user.displayName}><CheckCircle size={17}/><span className={styles.sessionLabel}>{pending ? 'Выходим…' : user.displayName.split(' ')[0].slice(0, 16) + ' · выйти'}</span></button>
          : <button className={`button primary small login-button ${styles.sessionButton}`} aria-label="Войти" onClick={() => { setMenu(false); setAuth(true); }}><UserCircle size={18}/><span className={styles.sessionLabel}>Войти</span></button>}
        <button ref={menuButton} type="button" className="icon-button menu-toggle" aria-label={menu ? 'Закрыть меню' : 'Открыть меню'} aria-expanded={menu} aria-controls="main-navigation" onClick={() => setMenu(!menu)}><span className={styles.menuGlyph} aria-hidden="true"><span/><span/><span/></span></button>
      </div>
    </header>
    {notice && <div className="notice-block" role="status">{notice} <button type="button" className="text-link" aria-label="Закрыть уведомление" onClick={() => setNotice('')}>Закрыть</button></div>}
    {auth && <AuthDialog onClose={close} onUser={setUser}/>}
  </>;
});
