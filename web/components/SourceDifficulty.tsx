import {ArrowSquareOut} from '@/components/TropnikIcons';
import type {Trail} from '@/lib/content';
const labels:Record<string,string>={hiking:'T1 · пешеходная тропа',mountain_hiking:'T2 · горная тропа',demanding_mountain_hiking:'T3 · сложная горная тропа',alpine_hiking:'T4 · альпийский маршрут',demanding_alpine_hiking:'T5 · сложный альпийский маршрут',difficult_alpine_hiking:'T6 · особо сложный альпийский маршрут'};
export function SourceDifficulty({trail}:{trail:Trail}) {
  if (!trail.sourceTechnicalDifficulty) return null;
  const sac = trail.sourceKind === 'database' && labels[trail.sourceTechnicalDifficulty];
  return <div className="source-difficulty">
    <strong>По источнику: {sac || trail.sourceTechnicalDifficulty}</strong>
    <p>Оценка относится к описанию пути. Учитывайте свою подготовку, погоду и текущие условия.</p>
    {sac && <a href="https://wiki.openstreetmap.org/wiki/Key:sac_scale" target="_blank" rel="noreferrer">Подробнее о сложности <ArrowSquareOut size={18}/></a>}
  </div>;
}
