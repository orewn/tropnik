type ExploreRequestState = {
  routeId?: string;
  open: boolean;
  date: string;
  note: string;
  error: string;
  busy: boolean;
  saved: boolean;
};
type ExploreRequestAttempt = Readonly<{routeId: string; date: string; note: string}>;

const emptyRequest = (routeId?: string): ExploreRequestState => ({routeId, open: false, date: '', note: '', error: '', busy: false, saved: false});

/** One route owns the form and its pending submission. Closing, changing route
 * or restoring history invalidates late responses, including navigation/auth. */
export class ExploreRequestSession {
  private state: ExploreRequestState;
  private pending?: ExploreRequestAttempt;
  private listeners = new Set<() => void>();

  constructor(routeId?: string) {this.state = emptyRequest(routeId);}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};

  select(routeId?: string, restore = false): void {
    if (routeId === this.state.routeId && !restore) return;
    this.pending = undefined;
    const draft = routeId === this.state.routeId ? {date: this.state.date, note: this.state.note} : {};
    this.update({...emptyRequest(routeId), ...draft});
  }
  open(routeId: string): void {
    this.select(routeId);
    this.pending = undefined;
    this.update({...this.state, open: true, busy: false, saved: false, error: ''});
  }
  close = (): void => {
    this.pending = undefined;
    this.update({...this.state, open: false, busy: false, saved: false, error: ''});
  };
  edit(field: 'date' | 'note', value: string): void {
    this.update({...this.state, [field]: value});
  }
  begin(routeId: string): ExploreRequestAttempt | undefined {
    if (!this.state.open || !this.state.routeId || this.state.routeId !== routeId || this.state.busy) return;
    const attempt = {routeId: this.state.routeId, date: this.state.date, note: this.state.note};
    this.pending = attempt;
    this.update({...this.state, busy: true, saved: false, error: ''});
    return attempt;
  }
  accept(attempt: ExploreRequestAttempt, apply: () => void): boolean {
    if (this.pending !== attempt || !this.state.open || this.state.routeId !== attempt.routeId) return false;
    apply();
    return true;
  }
  succeed(attempt: ExploreRequestAttempt): void {
    this.accept(attempt, () => this.update({...this.state, saved: true, busy: false}));
  }
  fail(attempt: ExploreRequestAttempt, error: string): void {
    this.accept(attempt, () => this.update({...this.state, error, busy: false}));
  }
  finish(attempt: ExploreRequestAttempt): void {
    this.accept(attempt, () => {this.pending = undefined; this.update({...this.state, busy: false});});
  }
  cancelPending = (): void => {this.pending = undefined;};

  private update(state: ExploreRequestState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
