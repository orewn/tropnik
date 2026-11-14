'use client';

import {useEffect, useRef, useState} from 'react';
import {ServiceWorkerUpdateRequest, watchServiceWorkerRegistration} from '@/lib/service-worker-registration';

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
  const [updateState, setUpdateState] = useState<'ready' | 'updating' | 'error'>('ready');
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const refreshRequested = useRef(false);
  const documentController = useRef<ServiceWorker | null>(null);
  const updateRequest = useRef<ServiceWorkerUpdateRequest | null>(null);
  const lastUpdateCheck = useRef(0);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    const target = window as IdleWindow;
    const idleHandles = new Set<number>();
    const timers = new Set<number>();
    let disposed = false;
    let unwatchRegistration: (() => void) | undefined;
    let controllerKnown = !!navigator.serviceWorker.controller;
    documentController.current = navigator.serviceWorker.controller;
    let checkUpdate = () => {};
    let scheduleWarm = () => {};
    const controllerChanged = () => {
      if (disposed) return;
      if (refreshRequested.current) return;
      if (controllerKnown) setUpdateReady(true);
      else documentController.current = navigator.serviceWorker.controller;
      controllerKnown = true;
      scheduleWarm();
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
        let warmScheduled = false;
        scheduleWarm = () => {
          if (disposed || warmScheduled || refreshRequested.current) return;
          warmScheduled = true;
          schedule(() => {
            warmScheduled = false;
            if (refreshRequested.current || registration.waiting || registration.installing) return;
            const worker = registration.active;
            if (worker?.state === 'activated') worker.postMessage({
              type: 'warm-map',
              engine: window.matchMedia('(pointer: coarse)').matches ? 'canvas' : 'webgl',
            });
          }, 4200);
        };
        scheduleWarm();
      }).catch(() => {});
    }, 2800);

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, {once: true});

    return () => {
      disposed = true;
      unwatchRegistration?.();
      updateRequest.current?.cancel(); updateRequest.current = null;
      refreshRequested.current = false;
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
    if (refreshRequested.current) return;
    refreshRequested.current = true;
    setUpdateState('updating');
    const finish = () => {if (updateRequest.current !== request) return false; updateRequest.current = null; refreshRequested.current = false; return true;};
    const request = new ServiceWorkerUpdateRequest({
      registration: registrationRef.current, container: navigator.serviceWorker, documentController: documentController.current,
      schedule: (callback, delay) => {const handle = window.setTimeout(callback, delay); return () => window.clearTimeout(handle);},
      reload: () => {if (finish()) {setUpdateState('ready'); location.reload();}},
      failed: () => {if (finish()) setUpdateState('error');},
    });
    updateRequest.current = request;
    request.start();
  }

  if (!updateReady) return null;
  return <div className="app-update" role="region" aria-label="Обновление Тропиныча">
    <span role="status" aria-live="polite"><strong>{updateState === 'error' ? 'Не удалось обновить страницу.' : updateState === 'updating' ? 'Подготавливаем свежую версию.' : 'Доступна свежая версия.'}</strong>{' '}{updateState === 'error' ? 'Обновление пока не завершилось. Проверьте подключение и повторите попытку.' : updateState === 'updating' ? 'Страница откроется заново, когда обновление будет готово.' : 'Обновите страницу, когда будете готовы получить последние исправления.'}</span>
    <div><button type="button" className="button primary small" disabled={updateState === 'updating'} onClick={activateUpdate}>{updateState === 'updating' ? 'Обновляем…' : updateState === 'error' ? 'Повторить' : 'Обновить'}</button><button type="button" className="button secondary small" disabled={updateState === 'updating'} onClick={()=>{setUpdateReady(false); setUpdateState('ready');}}>Позже</button></div>
  </div>;
}
