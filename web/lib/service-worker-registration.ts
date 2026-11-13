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

const UPDATE_ACTIVATION_TIMEOUT_MS = 15000;
type UpdateRequestOptions = {
  registration: ServiceWorkerRegistration | null;
  container: ServiceWorkerContainer;
  documentController: ServiceWorker | null;
  schedule: (callback: () => void, delay: number) => () => void;
  reload: () => void;
  failed: () => void;
};

/** One explicit user decision owns one bounded activation attempt. A timeout
 * or unmount revokes that decision, including a late controllerchange. */
export class ServiceWorkerUpdateRequest {
  private options: UpdateRequestOptions;
  private started = false;
  private ended = false;
  private checking = false;
  private checked = false;
  private cancelDeadline?: () => void;
  private watched = new Map<ServiceWorker, () => void>();
  private requested = new WeakSet<ServiceWorker>();

  constructor(options: UpdateRequestOptions) {this.options = options;}

  start() {
    if (this.started || this.ended) return;
    this.started = true;
    this.options.container.addEventListener('controllerchange', this.reconcile);
    this.options.registration?.addEventListener('updatefound', this.reconcile);
    this.cancelDeadline = this.options.schedule(() => this.fail(), UPDATE_ACTIVATION_TIMEOUT_MS);
    this.reconcile();
  }

  cancel() {
    if (this.ended) return;
    this.ended = true;
    this.cancelDeadline?.(); this.cancelDeadline = undefined;
    this.options.container.removeEventListener('controllerchange', this.reconcile);
    this.options.registration?.removeEventListener('updatefound', this.reconcile);
    for (const [worker, listener] of this.watched) worker.removeEventListener('statechange', listener);
    this.watched.clear();
  }

  private fail() {
    if (this.ended) return;
    this.cancel(); this.options.failed();
  }

  private reconcile = () => {
    if (this.ended) return;
    const {container, registration, documentController} = this.options;
    if (container.controller && container.controller !== documentController) {
      this.cancel(); this.options.reload(); return;
    }
    if (!registration) {this.fail(); return;}
    const activating = registration.active !== documentController ? registration.active : null;
    const candidates = new Set([registration.waiting, registration.installing, activating].filter((worker): worker is ServiceWorker => !!worker));
    for (const [worker, listener] of this.watched) if (!candidates.has(worker)) {
      worker.removeEventListener('statechange', listener); this.watched.delete(worker);
    }
    for (const worker of candidates) if (!this.watched.has(worker)) {
      this.watched.set(worker, this.reconcile); worker.addEventListener('statechange', this.reconcile);
    }
    const waiting = registration.waiting;
    if (waiting && waiting.state !== 'redundant') {
      if (waiting.state === 'installed' && !this.requested.has(waiting)) {
        this.requested.add(waiting);
        // Optional work in the old controller can delay skipWaiting. Old
        // published workers may ignore this message; the deadline still holds.
        for (const worker of new Set([container.controller, registration.active])) {
          try {worker?.postMessage({type: 'cancel-map-warm'});} catch { /* Optional cancellation is best effort. */ }
        }
        try {waiting.postMessage({type: 'skip-waiting'});} catch {this.fail();}
      }
      return;
    }
    // Registration.active and the worker's activating state are delivered
    // before the new page controller. That interval is still an owned update.
    if (activating && activating.state !== 'redundant' || registration.installing && registration.installing.state !== 'redundant' || this.checking) return;
    if (!this.checked) {
      this.checked = true; this.checking = true;
      // A waiting worker may have been replaced or removed since the banner
      // appeared. One current check may find its successor; never reload the
      // unchanged old controller and call that a successful update.
      void registration.update().then(() => {this.checking = false; this.reconcile();}, () => this.fail());
      return;
    }
    this.fail();
  };
}
