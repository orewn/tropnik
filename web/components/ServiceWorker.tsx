'use client';

import {useEffect, useRef, useState} from 'react';

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: {timeout: number}) => number;
  cancelIdleCallback?: (handle: number) => void;
};
type NetworkNavigator = Navigator & {
  connection?: {saveData?: boolean; effectiveType?: string};
};

export function ServiceWorker() {
  const [updateReady, setUpdateReady] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const refreshRequested = useRef(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    const target = window as IdleWindow;
    const idleHandles = new Set<number>();
    const timers = new Set<number>();
    let disposed = false;
    const controllerChanged = () => { if (refreshRequested.current) location.reload(); };
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);

    const schedule = (task: () => void, timeout: number) => {
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
        registrationRef.current = registration;
        const announceWaiting = () => {
          if (!disposed && registration.waiting && navigator.serviceWorker.controller) setUpdateReady(true);
        };
        announceWaiting();
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          installing?.addEventListener('statechange', () => {
            if (installing.state === 'installed') announceWaiting();
          });
        });
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
      window.removeEventListener('load', register);
      navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged);
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
  return <div className="app-update" role="status" aria-live="polite">
    <span><strong>Тропник обновлён.</strong> Перезагрузите страницу, чтобы получить свежую карту и исправления.</span>
    <div><button type="button" className="button primary small" onClick={activateUpdate}>Обновить</button><button type="button" className="button secondary small" onClick={()=>setUpdateReady(false)}>Позже</button></div>
  </div>;
}
