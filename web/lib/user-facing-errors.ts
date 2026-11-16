/** Only application-authored messages use this type. Native and upstream
 * diagnostics keep their original message/cause and are localized at the UI. */
export class UserFacingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UserFacingError';
  }
}

export type UserErrorContext = 'action' | 'storage' | 'download' | 'plan_import' | 'plan_export' | 'route_geometry' | 'safety_status';

const fallback: Record<UserErrorContext, string> = {
  action: 'Не удалось подтвердить действие. Проверьте подключение и обновите данные перед повторной попыткой.',
  storage: 'Не удалось сохранить изменения на устройстве. Проверьте доступ к хранилищу браузера и свободное место.',
  download: 'Не удалось завершить скачивание карты. Проверьте подключение и свободное место, затем повторите попытку.',
  plan_import: 'Не удалось прочитать файл плана. Проверьте формат и выберите файл ещё раз.',
  plan_export: 'Не удалось подготовить файл похода. Проверьте этапы и пересчитайте путь.',
  route_geometry: 'Не удалось загрузить линии этапов. Проверьте подключение и повторите попытку.',
  safety_status: 'Не удалось изменить статус уведомления. Проверьте текущий этап и заполненные сведения.',
};

// Public standalone safety storage cannot import TypeScript. Its stable codes
// select these reviewed messages without trusting an arbitrary Error.message.
const storageMessages: Record<string, string> = {
  safety_passports_too_large: 'Паспорта занимают слишком много места для автономного просмотра. Сократите описания или удалите старые паспорта. Изменения не сохранены.',
  emergency_card_incomplete: 'Сервис вернул неполную аварийную карточку. Обновите сведения перед сохранением.',
  emergency_cards_too_large: 'Карточки занимают слишком много места. Удалите старую локальную копию.',
};

export function userErrorText(error: unknown, context: UserErrorContext = 'action'): string {
  if (error instanceof UserFacingError) return error.message;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' &&
      Object.prototype.hasOwnProperty.call(storageMessages, error.code)) return storageMessages[error.code];
  const name = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError') return 'Недостаточно места для сохранения. Освободите место на устройстве и повторите попытку.';
  if (name === 'SecurityError' && (context === 'storage' || context === 'download')) return 'Хранилище браузера недоступно. Проверьте настройки приватности и разрешения сайта.';
  if (name === 'AbortError' && context === 'download') return 'Скачивание остановлено. Незавершённый пакет не отмечен готовым.';
  if (name === 'TimeoutError' && context === 'action') return 'Ответ не получен вовремя. Действие не подтверждено. Обновите данные перед повторной попыткой.';
  return fallback[context];
}

const apiMessages: Record<string, string> = {
  unauthorized: 'Войдите в аккаунт.',
  forbidden: 'Действие недоступно для вашей роли или текущего участия.',
  not_found: 'Запрошенные сведения не найдены. Обновите страницу.',
  route_response_unavailable: 'Данные маршрута требуют исправления. Попробуйте позже.',
  invalid_request: 'Проверьте заполненные поля и повторите действие.',
  departure_full: 'Свободных мест больше нет.',
  departure_not_ready: 'Условия похода изменились или ещё не выполнены. Обновите данные.',
  route_closed: 'Набор на этот маршрут приостановлен.',
  conflict: 'Данные изменились. Обновите страницу перед повтором.',
  already_exists: 'Такая запись уже существует.',
  temporarily_muted: 'Публикация временно ограничена. Причина, срок и обжалование доступны в личном кабинете.',
  posting_cooldown: 'Сообщение не отправлено: превышен лимит публикаций. Подождите и повторите позже.',
  repeated_content: 'Этот текст уже публиковался недавно. Новое сообщение не отправлено. Проверьте историю обсуждения.',
  link_limit: 'Сообщение не отправлено: слишком много ссылок для текущего лимита аккаунта. Сократите их количество.',
  safety_not_configured: 'Сервис безопасности сейчас недоступен. Обновите сведения перед повторной попыткой.',
  temporarily_unavailable: 'Сервис временно недоступен. Результат действия не подтверждён; обновите данные перед повторной попыткой.',
  not_ready: 'Сервис временно недоступен. Попробуйте открыть данные позже.',
  rate_limited: 'Слишком много запросов. Подождите минуту и повторите попытку.',
  auth_busy: 'Сервис сейчас занят. Повторите через несколько секунд.',
  json_required: 'Не удалось передать данные формы. Обновите страницу и заполните форму ещё раз.',
  content_type: 'Не удалось передать данные формы. Обновите страницу и заполните форму ещё раз.',
  invalid_json: 'Данные формы не удалось прочитать. Обновите страницу и проверьте заполненные поля.',
  idempotency_key_required: 'Не удалось подтвердить запрос. Обновите данные перед повторной попыткой.',
  origin_denied: 'Запрос отклонён. Откройте форму на сайте.',
  origin_mismatch: 'Запрос отклонён. Откройте форму на сайте.',
  internal_error: 'Не удалось подтвердить результат действия. Обновите данные перед повторной попыткой.',
  registration_unavailable: 'Сейчас не удаётся отправлять письма. Регистрация и новые ссылки временно недоступны. Попробуйте позже. В существующий аккаунт можно войти.',
  account_link_invalid: 'Ссылка недействительна или уже использована. Запросите новую.',
  account_has_active_trips: 'Сначала завершите участие в текущих походах и закройте свои открытые заявки. Назначенному гиду нужно завершить или отменить выход.',
  staff_account_managed: 'Служебный доступ сначала должен закрыть оператор сервиса.',
  reauthentication_failed: 'Не удалось подтвердить текущий пароль.',
  service_not_configured: 'Сервис аккаунтов и групп ещё не подключён. Карта и сохранение карточек доступны без регистрации.',
  service_config: 'Сервис временно недоступен. Попробуйте позже.',
  invalid_session: 'Не удалось безопасно открыть сессию. Повторите вход.',
  body_too_large: 'Данные слишком велики. Сократите текст или размер файла и повторите попытку.',
  response_too_large: 'Ответ сервера слишком велик. Действие не подтверждено; обновите данные перед повторной попыткой.',
  invalid_response: 'Сервер вернул неполный ответ. Действие не подтверждено; обновите данные перед повторной попыткой.',
  upstream_unavailable: 'Нет ответа от сервера. Действие не подтверждено; обновите данные перед повторной попыткой.',
  network_unavailable: 'Не удалось подтвердить действие. Проверьте подключение и обновите данные перед повторной попыткой. Сохранённые карты доступны без сети.',
  timeout: 'Ответ не получен вовремя. Действие не подтверждено. Обновите данные перед повтором.',
  status_unavailable: 'Не удалось подключиться к сервису. Проверьте подключение и попробуйте ещё раз.',
  static_preview: 'Сейчас это действие недоступно. Попробуйте позже. Сохранённые маршруты остаются на вашем устройстве.',
};

export function apiErrorText(code: string, status: number): string {
  if (Object.prototype.hasOwnProperty.call(apiMessages, code)) return apiMessages[code];
  if (status === 401) return apiMessages.unauthorized;
  if (status === 403) return apiMessages.forbidden;
  if (status === 404) return apiMessages.not_found;
  if (status === 409) return apiMessages.conflict;
  if (status === 413) return apiMessages.body_too_large;
  if (status === 429) return apiMessages.rate_limited;
  return fallback.action;
}
