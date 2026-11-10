/** No network or simulated successful server action exists in this public static build. */
import type {Envelope, User} from '../../lib/contract';
import build from 'virtual:pages-build';
export type {User, Departure, RecruitmentRequest, Route, Review, Participant, Guide, Message as ChatMessage, RecruitmentMessage, SafetyPassport, EmergencyCard, SafetyCheckIn, MCHSStatus, MCHSNotificationPolicy} from '../../lib/contract';
export type AuthChange = {user: User | null};
export const AUTH_EVENT = `${build.base.slice(1, -1)}-auth-unavailable`;
export const PREVIEW_API_MESSAGE = 'Сейчас это действие недоступно. Попробуйте позже. Сохранённые маршруты остаются на вашем устройстве.';

export class ApiError extends Error {
  readonly localSessionCleared = false;
  constructor(readonly status = 503, readonly code = 'static_preview', message = PREVIEW_API_MESSAGE) {super(message); this.name = 'ApiError';}
}
export function isAbort(error: unknown) {return error instanceof Error && error.name === 'AbortError';}
export const errorText = (error: unknown) => error instanceof Error ? error.message : PREVIEW_API_MESSAGE;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Preserve the shared API signature; static Pages has no account session.
export function announceAuth(_user: User | null) { /* There is no account session in this deployment. */ }
export async function apiEnvelope<T>(_path: string, init?: RequestInit): Promise<Envelope<T>> {
  if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  throw new ApiError();
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {return (await apiEnvelope<T>(path, init)).data;}
export async function serviceStatus(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return false;
}
