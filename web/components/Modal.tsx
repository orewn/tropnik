'use client';

import {useEffect, useId, useRef, useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {X} from '@/components/TropnikIcons';
import {BRAND} from '@/lib/brand';
import {BrandMark} from './BrandMark';

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
const dialogStack: HTMLDivElement[] = [];
const inertSiblings = new Map<HTMLElement, {count: number; original: boolean}>();
let scrollLock: {body: string; root: string} | undefined;

export function Modal({title, onClose, children, wide = false}: {title: string; onClose: () => void; children: React.ReactNode; wide?: boolean}) {
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const ref = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const titleId = useId();
  useEffect(() => {close.current = onClose;}, [onClose]);

  useEffect(() => {
    const dialog = ref.current, layer = backdrop.current;
    if (!mounted || !dialog || !layer) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialogStack.length) {
      scrollLock = {body: document.body.style.overflow, root: document.documentElement.style.overflow};
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
    }
    dialogStack.push(dialog);
    const siblings = [...document.body.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== layer);
    for (const element of siblings) {
      const state = inertSiblings.get(element) ?? {count: 0, original: element.inert};
      state.count++;
      inertSiblings.set(element, state);
      element.inert = true;
    }
    const isTopDialog = () => dialogStack.at(-1) === dialog;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]')]
      .filter(element => element.getClientRects().length > 0 && !element.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(element).visibility !== 'hidden');
    dialog.focus({preventScroll: true});
    const onKey = (event: KeyboardEvent) => {
      if (!isTopDialog()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key !== 'Tab') return;
      const items = focusable(), first = items[0], last = items.at(-1);
      if (!first || !last) {event.preventDefault(); dialog.focus({preventScroll: true}); return;}
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {event.preventDefault(); last.focus({preventScroll: true});}
      else if (!event.shiftKey && (active === last || active === dialog || !dialog.contains(active))) {event.preventDefault(); first.focus({preventScroll: true});}
    };
    const onFocus = (event: FocusEvent) => {
      if (isTopDialog() && event.target instanceof Node && !dialog.contains(event.target)) dialog.focus({preventScroll: true});
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
      const index = dialogStack.indexOf(dialog);
      if (index >= 0) dialogStack.splice(index, 1);
      for (const element of siblings) {
        const state = inertSiblings.get(element);
        if (!state || --state.count > 0) continue;
        element.inert = state.original;
        inertSiblings.delete(element);
      }
      if (!dialogStack.length && scrollLock) {
        document.body.style.overflow = scrollLock.body;
        document.documentElement.style.overflow = scrollLock.root;
        scrollLock = undefined;
      }
      const remaining = dialogStack.at(-1);
      if (previous?.isConnected && !previous.closest('[inert]') && (!remaining || remaining.contains(previous))) previous.focus({preventScroll: true});
      else remaining?.focus({preventScroll: true});
    };
  }, [mounted]);

  if (!mounted) return null;
  return createPortal(<div ref={backdrop} className="modal-backdrop" onClick={event => {if (event.target === event.currentTarget) onClose();}}>
    <div ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <div className="modal-brandline"><BrandMark size={24}/><span>{BRAND.name}</span></div>
      <div className="modal-heading"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Закрыть" onClick={onClose}><X size={22}/></button></div>
      {children}
    </div>
  </div>, document.body);
}
