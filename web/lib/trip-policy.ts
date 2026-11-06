import type {Departure, Participant, Review, Route, User} from './contract';

export function joinAllowed(d: Departure, now = Date.now()) {
  return ['recruiting', 'ready'].includes(d.status) && d.routeOpen && d.guideEligible && !!d.guideId && d.participantCount < d.capacity && now < Date.parse(d.startsAt) && ['none', 'cancelled'].includes(d.membership);
}

export function startAllowed(d: Departure, roster: Participant[], userId: string, now = Date.now()) {
  return d.status === 'ready' && d.guideId === userId && d.guideEligible && d.routeOpen && now >= Date.parse(d.startsAt) && now < Date.parse(d.endsAt) && roster.some(p => p.userId === userId && p.status === 'checked_in') && roster.filter(p => p.status === 'checked_in').length >= d.minPeople;
}

export function reviewAllowed(d: Departure, user: User | null, reviews: Review[], target: 'guide' | 'route') {
  return !!user && d.status === 'completed' && d.membership === 'completed' && d.guideId !== user.id && (!d.reviewTargets || d.reviewTargets.includes(target)) && !reviews.some(r => r.userId === user.id && r.target === target);
}

export function routePolicy(route?: Route) {
  return {minPeople: Math.max(4, route?.minPeople ?? 4), maxGroupSize: Math.min(50, route?.maxGroupSize ?? 8), requiredGuides: route?.requiredGuides ?? 1};
}

export function zonedISO(value: string, zone: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) throw new Error('Укажите дату и время.');
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  const checked = new Date(desired);
  if (checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day || checked.getUTCHours() !== hour || checked.getUTCMinutes() !== minute) throw new Error('Проверьте дату и время.');
  let epoch = desired;
  const fmt = new Intl.DateTimeFormat('en-CA', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(fmt.formatToParts(epoch).map(x => [x.type, x.value]));
    const actual = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const delta = desired - actual;
    if (!delta) return new Date(epoch).toISOString();
    epoch += delta;
  }
  throw new Error('Это время недоступно в выбранном часовом поясе. Выберите другое.');
}

export function mergeMessages<T extends {id: string; createdAt: string}>(previous: T[], incoming: T[]) {
  const byId = new Map(previous.map(item => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(-100);
}
