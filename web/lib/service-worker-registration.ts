/** Own both registration and installing-worker subscriptions. A registration
 * outlives React mounts, so its anonymous listeners must not outlive the host. */
export function watchServiceWorkerRegistration(registration: ServiceWorkerRegistration, installed: () => void) {
  let disposed = false;
  const workers = new Map<ServiceWorker, () => void>();
  const unwatch = (worker: ServiceWorker) => {
    const listener = workers.get(worker);
    if (listener) worker.removeEventListener('statechange', listener);
    workers.delete(worker);
  };
  const watchInstalling = () => {
    if (disposed) return;
    const worker = registration.installing;
    if (!worker || workers.has(worker)) return;
    const changed = () => {
      if (disposed) return;
      if (worker.state === 'installed') {unwatch(worker); installed();}
      else if (worker.state === 'redundant') unwatch(worker);
    };
    workers.set(worker, changed);
    worker.addEventListener('statechange', changed);
    changed();
  };
  registration.addEventListener('updatefound', watchInstalling);
  watchInstalling();
  return () => {
    disposed = true;
    registration.removeEventListener('updatefound', watchInstalling);
    for (const worker of workers.keys()) unwatch(worker);
  };
}
