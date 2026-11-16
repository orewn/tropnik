/** Display-only labels. Preserve the source value in catalogue/provenance data. */
const sacLabels: Record<string, string> = {
  "hiking": "T1 · пешеходная тропа",
  "mountain_hiking": "T2 · горная тропа",
  "demanding_mountain_hiking": "T3 · сложная горная тропа",
  "alpine_hiking": "T4 · альпийский маршрут",
  "demanding_alpine_hiking": "T5 · сложный альпийский маршрут",
  "difficult_alpine_hiking": "T6 · особо сложный альпийский маршрут"
};

// These descriptions are reviewed catalogue copy, not a script/language guess.
const reviewedDescriptions = new Set([
  "Средняя — по описанию ББТ",
  "Категория 1 в описании экскурсии; требуется выносливость",
  "Средняя — по описанию экскурсии",
  "Некатегорийный — по паспорту парка",
  "Перевал: 1А летом, 1Б зимой",
  "В описании ТИЦ: без крутых затяжных подъёмов",
  "Требуется хорошая физическая подготовка",
  "Некатегорийный маршрут",
  "По описанию парка специальная подготовка не требуется",
  "По описанию парка специальная подготовка не требуется; есть крутой подъём",
  "Оборудованный деревянным настилом маршрут",
  "Средняя — оценка создателей тропы",
  "для подготовленных туристов",
  "простой",
  "требует минимальной физической подготовки"
]);

export function sourceDifficultyLabel(value: unknown, sourceKind?: string): {label: string; sac: boolean} {
  const text = typeof value === 'string' ? value.trim() : '';
  if (sourceKind === 'database' && Object.prototype.hasOwnProperty.call(sacLabels, text)) return {label: sacLabels[text], sac: true};
  if (reviewedDescriptions.has(text)) return {label: text, sac: false};
  return {label: 'Оценку сложности нужно уточнить по первоисточнику', sac: false};
}
