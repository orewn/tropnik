/** Editorial themes only. These do not classify difficulty, access, or guide eligibility. */
export type EventCategoryId = 'walk' | 'trek' | 'summit' | 'pass' | 'lake' | 'waterfall' | 'forest' | 'coast' | 'volcano' | 'camp' | 'meetup' | 'training';
export type EventCategoryTone = 'forest' | 'water' | 'earth' | 'stone';
export type EventCategory = Readonly<{id: EventCategoryId; label: string; shortLabel: string; description: string; tone: EventCategoryTone}>;
export const eventCategories: readonly EventCategory[] = [
  {id: 'walk', label: 'Прогулки', shortLabel: 'Прогулка', description: 'Прогулочные и познавательные маршруты.', tone: 'forest'},
  {id: 'trek', label: 'Пешие маршруты', shortLabel: 'Пешком', description: 'Переходы по природным тропам.', tone: 'forest'},
  {id: 'summit', label: 'Вершины', shortLabel: 'Вершины', description: 'Горные вершины в описании маршрута.', tone: 'stone'},
  {id: 'pass', label: 'Перевалы', shortLabel: 'Перевалы', description: 'Пути через горные перевалы.', tone: 'stone'},
  {id: 'lake', label: 'Озёра', shortLabel: 'Озёра', description: 'Маршруты у озёр и к озёрам.', tone: 'water'},
  {id: 'waterfall', label: 'Водопады', shortLabel: 'Водопады', description: 'Тропы к водопадам и каскадам.', tone: 'water'},
  {id: 'forest', label: 'Леса и рощи', shortLabel: 'Лес', description: 'Лесные участки, рощи и тайга.', tone: 'forest'},
  {id: 'coast', label: 'Побережье', shortLabel: 'Побережье', description: 'Морские берега, мысы и прибрежные тропы.', tone: 'water'},
  {id: 'volcano', label: 'Вулканы', shortLabel: 'Вулканы', description: 'Вулканические ландшафты и кальдеры.', tone: 'earth'},
  {id: 'camp', label: 'Лагеря и стоянки', shortLabel: 'Лагерь', description: 'Лагерные остановки и маршруты с ночёвками.', tone: 'earth'},
  {id: 'meetup', label: 'Встречи', shortLabel: 'Встреча', description: 'Объявленные встречи сообщества.', tone: 'forest'},
  {id: 'training', label: 'Обучение', shortLabel: 'Обучение', description: 'Занятия и практические навыки на природе.', tone: 'earth'},
];
export const eventCategoryById = Object.fromEntries(eventCategories.map(category => [category.id, category])) as Record<EventCategoryId, EventCategory>;
export type RouteCategoryInput = Readonly<{title?: string; description?: string; subtitle?: string}>;
const normalise = (value: string | undefined) => (value || '').normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е');
const natureRules: readonly [EventCategoryId, RegExp][] = [
  ['volcano', /вулкан|кальдер|фумарол|сольфатар|лавов/],
  ['waterfall', /водопад|каскад/],
  ['lake', /озер|оз[её]р|оз\.\s|lake/],
  ['pass', /перевал/],
  ['summit', /вершин|восхожд|(?:^|[\s«—–])пик(?:[\s»—–]|$)|гора(?:[\s»—–]|$)|гору(?:[\s»—–]|$)/],
  ['coast', /побереж|прибреж|морск|(?:^|[^а-я])мыс(?:а|е|у|ом|ов|ы)?(?:[^а-я]|$)|берег(?:у|а|ом)?\s+(?:моря|океана)/],
  ['forest', /лесн|через лес|по лесу|лес и|роща|рощи|роще|тайг|таеж/],
];
/** Up to three source-derived themes. Never reads difficulty, distance, permits or operational notes.
 * Strong title matches come first. Text about possible views does not imply a summit ascent.
 * Meetup/training are only selected when explicitly named in a title; they do not create events.
 */
export function deriveRouteCategories(route: RouteCategoryInput | null | undefined): EventCategoryId[] {
  if (!route) return [];
  const title = normalise(route.title), description = normalise(route.description);
  if (!title.trim() && !description.trim()) return [];
  const result: EventCategoryId[] = [];
  const add = (category: EventCategoryId) => { if (!result.includes(category)) result.push(category); };
  if (/(?:^|[\s«])(?:обучение|тренировка|занятие|практикум|мастер-класс|школа)(?:[\s»:]|$)/.test(title)) add('training');
  if (/(?:^|[\s«])(?:встреча|встречи|слет|сходка)(?:[\s»:]|$)/.test(title)) add('meetup');
  for (const [category, pattern] of natureRules) if (pattern.test(title)) add(category);
  for (const [category, pattern] of natureRules) {
    // Descriptive summit views and nearby passes are not an itinerary through them.
    if (category !== 'summit' && category !== 'pass' && pattern.test(description)) add(category);
  }
  const campText = [title, ...description.split(/[.!?;\n]/)].filter(part => !/(?:без|нет|не предусмотр|не включ|не разреш|запрещ|исключ)/.test(part)).join(' ');
  if (/ночев|ночлег|палаточн|лагер|стоянк/.test(campText)) add('camp');
  if (!result.length) add(/прогул|экскурси|экотроп/.test(title + ' ' + description) ? 'walk' : 'trek');
  return result.slice(0, 3);
}
