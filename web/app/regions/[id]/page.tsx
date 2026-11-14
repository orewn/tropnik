import {ArrowRight} from '@/components/TropnikIcons';
import {getPublishedTrails} from '@/lib/server';
import {notFound} from 'next/navigation';
import type {Metadata} from 'next';
import {Header} from '@/components/Header';
import {Footer} from '@/components/Footer';
import {Explore} from '@/components/Explore';
import {SeoBreadcrumbs} from '@/components/SeoBreadcrumbs';
import {regionById, trails} from '@/lib/content';
import {regionSeo, canonicalUrl, serializeJsonLd} from '@/lib/seo';
import {getSeoContext, seoMetadata} from '@/lib/seo-metadata';

export async function generateMetadata({params}: {params: Promise<{id: string}>}): Promise<Metadata> {
  const {id} = await params;
  const region = regionById(id);
  if (!region) return {title: 'Направление не найдено', robots: {index: false, follow: true}};
  const published = await getPublishedTrails();
  const catalogue = [...new Map([...trails, ...published].map(trail => [trail.id, trail])).values()];
  return seoMetadata(regionSeo(region, catalogue, getSeoContext()));
}

export default async function RegionPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  const region = regionById(id);
  if (!region) notFound();
  const published = await getPublishedTrails();
  const catalogue = [...new Map([...trails, ...published].map(trail => [trail.id, trail])).values()];
  const context = getSeoContext();
  const seo = regionSeo(region, catalogue, context);
  return <><Header/><main id="main">
    <Explore initialRegion={region.id} initialPublished={published}/>
    <article className="region-article seo-article">
      <SeoBreadcrumbs breadcrumbs={seo.breadcrumbs}/>
      <span className="eyebrow">О направлении</span>
      <h2 className="heading-4">{seo.heading}</h2>
      <p className="body-3">{region.description}</p>
      <h3 className="heading-6">Как выбрать маршрут</h3>
      <p className="body-3">Сравнивайте длину, набор высоты, покрытие и технические участки. Смотрите дату сведений. Если сложность ещё не подтверждена, отсутствие оценки не означает лёгкую прогулку.</p>
      <h3 className="heading-6">Маршруты с описаниями</h3>
      {seo.links.length ? <ul className="seo-route-list">{seo.links.map(item => <li key={item.url}>
        <a href={item.url}><strong className="title-2">{item.name}</strong>{item.description && <p className="body-6">{item.description}</p>}<span className="button-sm">Открыть маршрут <ArrowRight size={18}/></span></a>
      </li>)}</ul> : <p>Подробные описания этого направления пока готовятся. Доступные линии троп можно изучить на карте.</p>}
      <div className="section-actions"><a className="button secondary" href={canonicalUrl('/routes/', context)}>Все маршруты России <ArrowRight size={18}/></a></div>
    </article>
    {process.env.NEXT_PUBLIC_STATIC_EXPORT !== 'true' && <script type="application/ld+json" dangerouslySetInnerHTML={{__html: serializeJsonLd(seo.structuredData)}}/>}
  </main><Footer/></>;
}
