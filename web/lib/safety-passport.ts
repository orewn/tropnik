export const SAFETY_PASSPORT_SCHEMA = 1 as const;
export const SAFETY_STORAGE_KEY = 'tropnik-safety-passports-v1';
export const MCHS_REGISTRATION_URL = 'https://forms.mchs.gov.ru/registration_tourist_groups';

export type SafetyStatus = 'draft' | 'ready' | 'submitted' | 'confirmed' | 'amendment_required' | 'active' | 'closed';

export type SafetyParticipant = {
  id: string;
  name: string;
  phone: string;
  emergencyName: string;
  emergencyPhone: string;
  minor: boolean;
};

export type SafetyPassport = {
  schemaVersion: typeof SAFETY_PASSPORT_SCHEMA;
  id: string;
  createdAt: string;
  updatedAt: string;
  status: SafetyStatus;
  routeId?: string;
  routeTitle: string;
  region: string;
  startDate: string;
  endDate: string;
  startPoint: string;
  finishPoint: string;
  routeDescription: string;
  reserveRoute: string;
  emergencyExits: string;
  transport: string;
  communication: string;
  equipment: string;
  leaderName: string;
  leaderPhone: string;
  leaderEmail: string;
  outsideContactName: string;
  outsideContactPhone: string;
  returnDeadline: string;
  participants: SafetyParticipant[];
  mchsReference: string;
  submittedAt: string;
  confirmedAt: string;
  prestartCallAt: string;
  returnedAt: string;
};

export type SafetyReadiness = {
  complete: boolean;
  completed: number;
  total: number;
  percent: number;
  missing: string[];
};

export type DeadlineState = 'unknown' | 'comfortable' | 'soon' | 'late';

const requiredFields: Array<[keyof SafetyPassport, string]> = [
  ['routeTitle', 'Название маршрута'],
  ['region', 'Регион начала маршрута'],
  ['startDate', 'Дата выхода'],
  ['endDate', 'Дата возвращения'],
  ['startPoint', 'Точка старта'],
  ['finishPoint', 'Точка завершения'],
  ['routeDescription', 'Подробное описание маршрута'],
  ['communication', 'Способы связи'],
  ['leaderName', 'Ответственный руководитель'],
  ['leaderPhone', 'Телефон руководителя'],
  ['outsideContactName', 'Контакт вне группы'],
  ['outsideContactPhone', 'Телефон контакта вне группы'],
  ['returnDeadline', 'Контрольный срок возвращения'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function boolean(value: unknown): boolean {
  return value === true;
}

function localDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day));
  return result.getUTCFullYear() === year && result.getUTCMonth() === month - 1 && result.getUTCDate() === day ? result : undefined;
}

function localDateTime(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const result = new Date(value + ':00');
  return Number.isFinite(result.getTime()) ? result : undefined;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function newSafetyPassport(id: string, now = new Date()): SafetyPassport {
  const timestamp = now.toISOString();
  return {
    schemaVersion: SAFETY_PASSPORT_SCHEMA,
    id,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'draft',
    routeTitle: '',
    region: '',
    startDate: '',
    endDate: '',
    startPoint: '',
    finishPoint: '',
    routeDescription: '',
    reserveRoute: '',
    emergencyExits: '',
    transport: '',
    communication: '',
    equipment: '',
    leaderName: '',
    leaderPhone: '',
    leaderEmail: '',
    outsideContactName: '',
    outsideContactPhone: '',
    returnDeadline: '',
    participants: [],
    mchsReference: '',
    submittedAt: '',
    confirmedAt: '',
    prestartCallAt: '',
    returnedAt: '',
  };
}

export function safetyPassportSnapshot(passport: SafetyPassport): string {
  return JSON.stringify(passport, (key, value) => key === 'updatedAt' ? undefined : value);
}

export function safetyReadiness(passport: SafetyPassport): SafetyReadiness {
  const missing = requiredFields.filter(([key]) => !String(passport[key] || '').trim()).map(([, label]) => label);
  const validParticipants = passport.participants.filter(participant => participant.name.trim() && participant.phone.trim());
  if (!validParticipants.length) missing.push('Хотя бы один участник с телефоном');
  if (passport.startDate && passport.endDate) {
    const start = localDate(passport.startDate);
    const end = localDate(passport.endDate);
    if (!start || !end || end < start) missing.push('Корректный период похода');
  }
  if (passport.returnDeadline && !localDateTime(passport.returnDeadline)) missing.push('Корректный контрольный срок');
  const total = requiredFields.length + 2;
  const completed = Math.max(0, total - missing.length);
  return {complete: missing.length === 0, completed, total, percent: Math.round(completed / total * 100), missing};
}

export function notificationDeadline(startDate: string, workingDays = 10): string | undefined {
  const date = localDate(startDate);
  if (!date || !Number.isInteger(workingDays) || workingDays < 1) return undefined;
  let remaining = workingDays;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() - 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining--;
  }
  return isoDay(date);
}

export function notificationDeadlineState(startDate: string, today = new Date()): DeadlineState {
  const deadline = notificationDeadline(startDate);
  if (!deadline) return 'unknown';
  const target = localDate(deadline)!;
  const current = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const days = Math.ceil((target.getTime() - current.getTime()) / 86_400_000);
  if (days < 0) return 'late';
  if (days <= 3) return 'soon';
  return 'comfortable';
}

export function allowedSafetyTransition(current: SafetyStatus, next: SafetyStatus): boolean {
  const allowed: Record<SafetyStatus, SafetyStatus[]> = {
    draft: ['ready'],
    ready: ['draft', 'submitted'],
    submitted: ['ready', 'confirmed', 'amendment_required'],
    confirmed: ['submitted', 'active', 'amendment_required'],
    amendment_required: ['ready', 'submitted'],
    active: ['confirmed', 'closed', 'amendment_required'],
    closed: ['active'],
  };
  return allowed[current].includes(next);
}

export function transitionSafetyPassport(passport: SafetyPassport, next: SafetyStatus, now = new Date()): SafetyPassport {
  if (!allowedSafetyTransition(passport.status, next)) throw new Error(`Недопустимый переход ${passport.status} → ${next}`);
  if (next === 'ready' && !safetyReadiness(passport).complete) throw new Error('Сначала заполните обязательные сведения.');
  if (next === 'confirmed' && !passport.mchsReference.trim()) throw new Error('Укажите номер или подтверждение регистрации.');
  if (next === 'active' && !passport.prestartCallAt) throw new Error('Сначала отметьте предвыходное уточнение сведений.');
  if (next === 'closed' && !passport.returnedAt) throw new Error('Сначала отметьте сообщение о возвращении.');
  const timestamp = now.toISOString();
  return {
    ...passport,
    status: next,
    updatedAt: timestamp,
    submittedAt: next === 'submitted' && !passport.submittedAt ? timestamp : passport.submittedAt,
    confirmedAt: next === 'confirmed' && !passport.confirmedAt ? timestamp : passport.confirmedAt,
  };
}

export function invalidateOfficialStatus(passport: SafetyPassport, now = new Date()): SafetyPassport {
  if (!['submitted', 'confirmed', 'active'].includes(passport.status)) return {...passport, updatedAt: now.toISOString()};
  return {...passport, status: 'amendment_required', updatedAt: now.toISOString()};
}

export function parseSafetyPassport(value: unknown): SafetyPassport | undefined {
  if (!isRecord(value) || value.schemaVersion !== SAFETY_PASSPORT_SCHEMA || typeof value.id !== 'string' || !value.id) return undefined;
  const statuses: SafetyStatus[] = ['draft', 'ready', 'submitted', 'confirmed', 'amendment_required', 'active', 'closed'];
  const status = statuses.includes(value.status as SafetyStatus) ? value.status as SafetyStatus : 'draft';
  const participants = Array.isArray(value.participants) ? value.participants.flatMap(item => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id) return [];
    return [{
      id: item.id,
      name: text(item.name),
      phone: text(item.phone),
      emergencyName: text(item.emergencyName),
      emergencyPhone: text(item.emergencyPhone),
      minor: boolean(item.minor),
    }];
  }) : [];
  return {
    schemaVersion: SAFETY_PASSPORT_SCHEMA,
    id: value.id,
    createdAt: text(value.createdAt) || new Date(0).toISOString(),
    updatedAt: text(value.updatedAt) || text(value.createdAt) || new Date(0).toISOString(),
    status,
    routeId: text(value.routeId) || undefined,
    routeTitle: text(value.routeTitle),
    region: text(value.region),
    startDate: text(value.startDate),
    endDate: text(value.endDate),
    startPoint: text(value.startPoint),
    finishPoint: text(value.finishPoint),
    routeDescription: text(value.routeDescription),
    reserveRoute: text(value.reserveRoute),
    emergencyExits: text(value.emergencyExits),
    transport: text(value.transport),
    communication: text(value.communication),
    equipment: text(value.equipment),
    leaderName: text(value.leaderName),
    leaderPhone: text(value.leaderPhone),
    leaderEmail: text(value.leaderEmail),
    outsideContactName: text(value.outsideContactName),
    outsideContactPhone: text(value.outsideContactPhone),
    returnDeadline: text(value.returnDeadline),
    participants,
    mchsReference: text(value.mchsReference),
    submittedAt: text(value.submittedAt),
    confirmedAt: text(value.confirmedAt),
    prestartCallAt: text(value.prestartCallAt),
    returnedAt: text(value.returnedAt),
  };
}

export function parseSafetyPassportList(value: unknown): SafetyPassport[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const parsed = parseSafetyPassport(item);
    return parsed ? [parsed] : [];
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function line(label: string, value: string): string {
  return value.trim() ? `${label}: ${value.trim()}` : `${label}: не указано`;
}

export function buildSafetyPackage(passport: SafetyPassport): string {
  const participants = passport.participants.map((participant, index) => [
    `${index + 1}. ${participant.name || 'Имя не указано'}${participant.minor ? ' (несовершеннолетний)' : ''}`,
    `телефон: ${participant.phone || 'не указан'}`,
    `аварийный контакт: ${participant.emergencyName || 'не указан'} ${participant.emergencyPhone || ''}`.trim(),
  ].join(' · ')).join('\n');
  const deadline = notificationDeadline(passport.startDate);
  return [
    'ПАСПОРТ БЕЗОПАСНОСТИ ПОХОДА · ТРОПНИК',
    'Черновик для переноса в официальную форму МЧС России. Сам по себе этот файл не является поданным уведомлением.',
    '',
    line('Маршрут', passport.routeTitle),
    line('Регион начала', passport.region),
    line('Дата выхода', passport.startDate),
    line('Дата возвращения', passport.endDate),
    line('Ориентировочный крайний срок подачи', deadline || ''),
    line('Точка старта', passport.startPoint),
    line('Точка завершения', passport.finishPoint),
    line('Описание маршрута', passport.routeDescription),
    line('Запасной вариант', passport.reserveRoute),
    line('Аварийные выходы', passport.emergencyExits),
    line('Транспорт', passport.transport),
    line('Связь', passport.communication),
    line('Снаряжение', passport.equipment),
    '',
    line('Ответственный руководитель', passport.leaderName),
    line('Телефон руководителя', passport.leaderPhone),
    line('Электронная почта', passport.leaderEmail),
    line('Контакт вне группы', passport.outsideContactName),
    line('Телефон контакта вне группы', passport.outsideContactPhone),
    line('Контрольный срок возвращения', passport.returnDeadline),
    '',
    'УЧАСТНИКИ',
    participants || 'Список не заполнен',
    '',
    line('Номер/подтверждение МЧС', passport.mchsReference),
    line('Уведомление отправлено', passport.submittedAt),
    line('Подтверждение получено', passport.confirmedAt),
    line('Предвыходное уточнение выполнено', passport.prestartCallAt),
    line('О возвращении сообщено', passport.returnedAt),
  ].join('\n');
}

export function buildEmergencyMessage(passport: SafetyPassport, coordinates?: string): string {
  return [
    'Нужна помощь туристской группе.',
    `Маршрут: ${passport.routeTitle || 'не указан'}.`,
    `Регион: ${passport.region || 'не указан'}.`,
    `Ответственный: ${passport.leaderName || 'не указан'}, ${passport.leaderPhone || 'телефон не указан'}.`,
    `Участников: ${passport.participants.length || 'не указано'}.`,
    coordinates ? `Координаты: ${coordinates}.` : 'Координаты: сообщу отдельно.',
    `Контрольный срок: ${passport.returnDeadline || 'не указан'}.`,
    passport.mchsReference ? `Регистрация МЧС: ${passport.mchsReference}.` : 'Регистрация МЧС: подтверждение не указано.',
  ].join(' ');
}
