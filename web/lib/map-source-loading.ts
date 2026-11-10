export type MapSourceSignal = {
  sourceId?: string;
  sourceDataType?: string;
  tile?: unknown;
  coord?: unknown;
};

export type MapSourceFailure = {id: string; retrying: boolean};
type SourceRecord = {
  source: object;
  pending: boolean;
  metadataPending: boolean;
  metadataReady: boolean;
  failed: boolean;
};
type SourceLoadingOptions = {
  getSource: (id: string) => object | undefined;
  isSourceLoaded: (id: string) => boolean;
  metadataSources: readonly string[];
  retryMetadata: (id: string, source: object) => boolean;
  onLoading: (loading: boolean) => void;
  onFailures: (failures: MapSourceFailure[]) => void;
  defer?: (callback: () => void) => ReturnType<typeof setTimeout>;
  cancelDefer?: (timer: ReturnType<typeof setTimeout>) => void;
};

/** Source completion is independent of camera/render idle. Keep one debounce
 * timer, and distinguish settled failures from successfully loaded metadata. */
export class MapSourceLoading {
  private readonly options: SourceLoadingOptions;
  private readonly sources = new Map<string, SourceRecord>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerRevision = 0;
  private revision = 0;
  private reconcileQueued = false;
  private visible = false;
  private suspended = false;
  private disposed = false;
  private failureKey = '';

  constructor(options: SourceLoadingOptions) {this.options = options;}

  loading(event: MapSourceSignal): void {
    const record = this.record(event.sourceId);
    if (!record) return;
    record.pending = true;
    // Initial definition load. A successful source is never downgraded merely
    // because a later tile event omits its tile field; retries are explicit.
    if (!record.metadataReady && !event.tile && !event.coord && this.monitors(event.sourceId!)) record.metadataPending = true;
    this.publish();
  }

  data(event: MapSourceSignal): void {
    const record = this.record(event.sourceId);
    if (!record) return;
    if (event.sourceDataType === 'metadata') {
      record.metadataReady = true;
      record.metadataPending = false;
      record.failed = false;
    }
    this.reconcile();
  }

  aborted(event: MapSourceSignal): void {
    if (!this.record(event.sourceId)) return;
    // The SDK can emit dataabort while the cancelled tile is still being
    // removed. Reconcile once after that event stack has finished.
    this.queueReconcile();
  }

  error(event: MapSourceSignal): void {
    const record = this.record(event.sourceId);
    if (record?.metadataPending && !event.tile && !event.coord) {
      record.metadataPending = false;
      record.failed = true;
    }
    this.reconcile();
    this.queueReconcile();
  }

  beforeStyleChange(): void {
    if (this.disposed) return;
    this.revision++;
    this.reconcileQueued = false;
    this.suspended = true;
    this.clearTimer();
    this.show(false);
  }

  styleLoaded(): void {
    if (this.disposed) return;
    this.suspended = false;
    // A diff can retain a source. Keep its availability until successful
    // metadata arrives; only removed/replaced source objects are obsolete.
    this.reconcile();
  }

  reconcile(): void {
    if (this.disposed) return;
    for (const [id, record] of this.sources) {
      if (this.options.getSource(id) !== record.source) this.sources.delete(id);
      else record.pending = !this.options.isSourceLoaded(id);
    }
    this.publish();
  }

  retry(): number {
    if (this.disposed || this.suspended) return 0;
    let started = 0;
    for (const [id, record] of this.sources) {
      if (!record.failed || record.metadataPending || this.options.getSource(id) !== record.source) continue;
      record.metadataPending = true;
      record.pending = true;
      try {
        if (this.options.retryMetadata(id, record.source)) {started++; continue;}
      } catch { /* Keep the existing failure actionable after a rejected retry. */ }
      record.metadataPending = false;
      record.pending = !this.options.isSourceLoaded(id);
    }
    this.publish();
    return started;
  }

  dispose(): void {
    this.disposed = true;
    this.revision++;
    this.reconcileQueued = false;
    this.clearTimer();
    this.sources.clear();
  }

  private monitors(id: string): boolean {return this.options.metadataSources.includes(id);}

  private record(id: string | undefined): SourceRecord | undefined {
    if (this.disposed || !id) return;
    const source = this.options.getSource(id);
    if (!source) return;
    let record = this.sources.get(id);
    if (!record || record.source !== source) {
      record = {source, pending: false, metadataPending: false, metadataReady: false, failed: false};
      this.sources.set(id, record);
    }
    return record;
  }

  private queueReconcile(): void {
    if (this.disposed || this.reconcileQueued) return;
    this.reconcileQueued = true;
    const revision = this.revision;
    queueMicrotask(() => {
      if (this.disposed || revision !== this.revision) return;
      this.reconcileQueued = false;
      this.reconcile();
    });
  }

  private publish(): void {
    if (this.disposed) return;
    const failures = [...this.sources].filter(([, record]) => record.failed)
      .map(([id, record]) => ({id, retrying: record.metadataPending})).sort((a, b) => a.id.localeCompare(b.id));
    const key = failures.map(failure => `${failure.id}:${failure.retrying}`).join(',');
    if (key !== this.failureKey) {this.failureKey = key; this.options.onFailures(failures);}
    if (this.suspended) return;
    if (![...this.sources.values()].some(record => record.pending)) {
      this.clearTimer();
      this.show(false);
    } else if (!this.visible && this.timer === undefined) {
      const revision = this.revision;
      const timerRevision = ++this.timerRevision;
      const show = () => {
        if (this.disposed || revision !== this.revision || timerRevision !== this.timerRevision) return;
        this.timer = undefined;
        this.show([...this.sources.values()].some(record => record.pending));
      };
      this.timer = this.options.defer ? this.options.defer(show) : setTimeout(show, 300);
    }
  }

  private show(loading: boolean): void {
    if (loading === this.visible) return;
    this.visible = loading;
    this.options.onLoading(loading);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.timerRevision++;
    if (this.options.cancelDefer) this.options.cancelDefer(this.timer); else clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** setUrl is a public SDK operation that starts a new metadata request even
 * for the same URL. It retains this source's camera-independent tile settings. */
export function retryMapSourceMetadata(source: object, definition: {type: string; url?: string} | undefined): boolean {
  const retryable = source as {setUrl?: (url: string) => unknown};
  if (!definition?.url || !['vector', 'raster', 'raster-dem'].includes(definition.type) || typeof retryable.setUrl !== 'function') return false;
  retryable.setUrl(definition.url);
  return true;
}
