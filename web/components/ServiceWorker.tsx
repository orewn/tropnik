'use client';

import {useEffect, useRef, useState} from 'react';
import {watchServiceWorkerRegistration} from '@/lib/service-worker-registration';

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: {timeout: number}) => number;
  cancelIdleCallback?: (handle: number) => void;
};
type NetworkNavigator = Navigator & {
  connection?: {saveData?: boolean; effectiveType?: string};
};

const UPDATE_INTERVAL = 30 * 60 * 1000;

export function ServiceWorker() {
  const [updateReady, setUpdateReady] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const refreshRequested = useRef(false);
  const lastUpdateCheck = useRef(0);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    const target = window as IdleWindow;
    const idleHandles = new Set<number>();
    const timers = new Set<number>();
    let disposed = false;
    let unwatchRegistration: (() => void) | undefined;
    let controllerKnown = !!navigator.serviceWorker.controller;
    let checkUpdate = () => {};
    const controllerChanged = () => {
      if (disposed) return;
      if (refreshRequested.current) { location.reload(); return; }
      if (controllerKnown && !disposed) setUpdateReady(true);
      controllerKnown = true;
    };
    const wake = () => { if (!document.hidden) checkUpdate(); };
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);

    const schedule = (task: () => void, timeout: number) => {
      if (disposed) return;
      if (target.requestIdleCallback) {
        const handle = target.requestIdleCallback(() => {
          idleHandles.delete(handle);
          if (!disposed) task();
        }, {timeout});
        idleHandles.add(handle);
        return;
      }
      const handle = window.setTimeout(() => {
        timers.delete(handle);
        if (!disposed) task();
      }, Math.min(timeout, 1400));
      timers.add(handle);
    };

    const register = () => schedule(() => {
      void navigator.serviceWorker.register('/sw.js', {updateViaCache: 'none'}).then(registration => {
        if (disposed) return;
        registrationRef.current = registration;
        lastUpdateCheck.current = Date.now();
        checkUpdate = () => {
          if (disposed || document.hidden || !navigator.onLine || !registrationRef.current) return;
          const now = Date.now();
          if (now - lastUpdateCheck.current < UPDATE_INTERVAL) return;
          lastUpdateCheck.current = now;
          void registrationRef.current.update().catch(() => {});
        };
        const announceWaiting = () => {
          if (!disposed && registration.waiting && navigator.serviceWorker.controller) setUpdateReady(true);
        };
        announceWaiting();
        unwatchRegistration?.();
        unwatchRegistration = watchServiceWorkerRegistration(registration, announceWaiting);
        if (disposed || !document.querySelector('.explore-layout')) return;
        const connection = (navigator as NetworkNavigator).connection;
        if (connection?.saveData || /(?:^|-)2g$/.test(connection?.effectiveType || '')) return;
        schedule(() => {
          const worker = registration.active || registration.waiting || registration.installing;
          worker?.postMessage({
            type: 'warm-map',
            engine: window.matchMedia('(pointer: coarse)').matches ? 'canvas' : 'webgl',
          });
        }, 4200);
      }).catch(() => {});
    }, 2800);

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, {once: true});

    return () => {
      disposed = true;
      unwatchRegistration?.();
      registrationRef.current = null;
      window.removeEventListener('load', register);
      navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('pageshow', wake);
      for (const handle of idleHandles) target.cancelIdleCallback?.(handle);
      for (const handle of timers) window.clearTimeout(handle);
    };
  }, []);

  function activateUpdate() {
    const waiting = registrationRef.current?.waiting;
    if (!waiting) { location.reload(); return; }
    refreshRequested.current = true;
    waiting.postMessage({type: 'skip-waiting'});
  }

  if (!updateReady) return null;
  return <div className="app-update" role="region" aria-label="Обновление Тропника">
    <span role="status" aria-live="polite"><strong>Доступна свежая версия.</strong> Обновите страницу, когда будете готовы получить последние исправления.</span>
    <div><button type="button" className="button primary small" onClick={activateUpdate}>Обновить</button><button type="button" className="button secondary small" onClick={()=>setUpdateReady(false)}>Позже</button></div>
  </div>;
}
