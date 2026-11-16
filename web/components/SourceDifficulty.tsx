import {ArrowSquareOut} from '@/components/TropnikIcons';
import type {Trail} from '@/lib/content';
import {sourceDifficultyLabel} from '@/lib/source-difficulty';
export function SourceDifficulty({trail}:{trail:Trail}) {
  if (!trail.sourceTechnicalDifficulty) return null;
  const {label, sac} = sourceDifficultyLabel(trail.sourceTechnicalDifficulty, trail.sourceKind);
  return <div className="source-difficulty">
    <strong>По источнику: {label}</strong>
    <p>Оценка относится к описанию пути. Учитывайте свою подготовку, погоду и текущие условия.</p>
    {sac && <a href="https://wiki.openstreetmap.org/wiki/Key:sac_scale" target="_blank" rel="noreferrer">Подробнее о сложности <ArrowSquareOut size={18}/></a>}
  </div>;
}
