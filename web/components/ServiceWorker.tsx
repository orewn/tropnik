'use client';

import {useEffect} from 'react';

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: {timeout: number}) => number;
  cancelIdleCallback?: (handle: number) => void;
};
type NetworkNavigator = Navigator & {
  connection?: {saveData?: boolean; effectiveType?: string};
};

export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    const target = window as IdleWindow;
    const idleHandles = new Set<number>();
    const timers = new Set<number>();
    let disposed = false;

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
      for (const handle of idleHandles) target.cancelIdleCallback?.(handle);
      for (const handle of timers) window.clearTimeout(handle);
    };
  }, []);
  return null;
}
