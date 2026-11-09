import type {Metadata} from 'next';
import {HikePlanner} from '@/components/HikePlanner';

export const metadata: Metadata = {
  title: 'Конструктор похода',
  description: 'Соберите поход из участков соседних и пересекающихся троп: выберите начало, стыки, промежуточные точки и дни. Сохраните план и GPX.',
};

export default async function PlannerPage({searchParams}: {searchParams: Promise<{route?: string}>}) {
  const params = await searchParams;
  return <HikePlanner initialTrailId={params.route}/>;
}
