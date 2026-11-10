import type {Envelope, User} from './contract';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly localSessionCleared: boolean;
  constructor(status: number, code: string, message: string, localSessionCleared = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.localSessionCleared = localSessionCleared;
  }
}

export type {User, Departure, RecruitmentRequest, Route, Review, Participant, Guide, Message as ChatMessage, RecruitmentMessage, SafetyPassport, EmergencyCard, SafetyCheckIn, MCHSStatus, MCHSNotificationPolicy} from './contract';
export const AUTH_EVENT = 'tropnik-auth';
export type AuthChange = {user: User | null};

export function announceAuth(user: User | null) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AuthChange>(AUTH_EVENT, {detail: {user}}));
  // Only an invalidation timestamp is shared; no session or profile is stored here.
  try { localStorage.setItem('tropa-auth-change', String(Date.now())); } catch { /* Storage is optional. */ }
}

export function isAbort(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

export async function apiEnvelope<T>(path: string, init?: RequestInit): Promise<Envelope<T>> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(init?.signal?.reason);
  if (init?.signal?.aborted) abort();
  else init?.signal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try {
    const headers = new Headers(init?.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json');
    const response = await fetch(`/api/backend/${path.replace(/^\//, '')}`, {
      ...init, signal: controller.signal, credentials: 'same-origin', cache: 'no-store', headers,
    });
    const cleared = response.headers.get('X-Tropa-Session-Cleared') === '1';
    if (response.status === 204) return {data: undefined as T};
    let result: unknown;
    try { result = await response.json(); }
    catch { throw new ApiError(response.status, 'invalid_response', 'Не удалось обновить данные. Попробуйте ещё раз.', cleared); }
    if (!result || typeof result !== 'object') throw new ApiError(response.status, 'invalid_response', 'Сервер вернул неполный ответ. Попробуйте обновить данные.', cleared);
    const body = result as {data?: T; error?: {code?: string; message?: string}; meta?: Envelope<T>['meta']};
    if (!response.ok) throw new ApiError(response.status, body.error?.code || 'request_failed', body.error?.message || 'Не удалось выполнить действие.', cleared);
    if (!Object.prototype.hasOwnProperty.call(body, 'data')) throw new ApiError(response.status, 'invalid_response', 'Сервер не подтвердил результат действия.', cleared);
    return {data: body.data as T, meta: body.meta};
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) throw new ApiError(0, 'timeout', 'Ответ не получен вовремя. Действие не подтверждено. Обновите данные перед повтором.');
    if (init?.signal?.aborted) throw error;
    throw new ApiError(0, 'network_unavailable', 'Не удалось подтвердить действие. Проверьте подключение и попробуйте ещё раз. Сохранённые карты доступны без сети.');
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener('abort', abort);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return (await apiEnvelope<T>(path, init)).data;
}

export async function serviceStatus(signal?: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('/api/status', {signal: controller.signal, cache: 'no-store', credentials: 'same-origin'});
    if (!response.ok) throw new ApiError(response.status, 'status_unavailable', 'Не удалось подключиться. Попробуйте ещё раз.');
    const value: unknown = await response.json();
    const state = value as {configured?: unknown; connected?: unknown; mode?: unknown} | null;
    if (!state || typeof state !== 'object' || typeof state.connected !== 'boolean' || typeof state.configured !== 'boolean') throw new ApiError(502, 'status_unavailable', 'Не удалось подключиться. Попробуйте ещё раз.');
    if (state.connected && state.configured && state.mode === 'connected') return true;
    if (!state.connected && !state.configured && state.mode === 'preview') return false;
    throw new ApiError(503, 'status_unavailable', 'Сейчас это действие недоступно. Попробуйте позже.');
  } catch (error) {
    if (signal?.aborted || error instanceof ApiError) throw error;
    throw new ApiError(0, 'status_unavailable', 'Не удалось подключиться. Попробуйте ещё раз.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export const errorText = (error: unknown) => error instanceof ApiError ? error.message : error instanceof Error && error.name !== 'TypeError' ? error.message : 'Не удалось связаться с сервером. Проверьте подключение и повторите попытку.';
