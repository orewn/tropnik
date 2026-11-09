/** Shared priorities for labels already supplied by the geographic tile data. */
export const priorityCityNames = ['Москва','Санкт-Петербург','Петропавловск-Камчатский','Владивосток','Хабаровск','Анадырь','Мурманск','Калининград','Архангельск','Магадан','Южно-Сахалинск','Якутск','Салехард','Новосибирск','Красноярск','Екатеринбург','Иркутск','Казань','Сочи'];
const priorityCities = new Set(priorityCityNames);
export function isPriorityCity(props) {
  return props?.class === 'city' && priorityCities.has(props['name:ru'] ?? props.name ?? props['name:latin'] ?? '');
}
export function priorityCityFontSize(zoom) {
  if (zoom <= 3) return 13;
  if (zoom < 6) return 13 + (zoom - 3) * 4 / 3;
  if (zoom < 10) return 17 + (zoom - 6) * 3 / 4;
  return 20;
}
