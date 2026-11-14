import {Header} from '@/components/Header';
import {Footer} from '@/components/Footer';
import {SeoBreadcrumbs} from '@/components/SeoBreadcrumbs';
import {ArrowRight} from '@/components/TropnikIcons';
import {regions, trails} from '@/lib/content';
import {getPublishedTrails} from '@/lib/server';
import {catalogueSeo, canonicalUrl, serializeJsonLd} from '@/lib/seo';
import {getSeoContext, seoMetadata} from '@/lib/seo-metadata';

export const metadata = seoMetadata(catalogueSeo(trails, regions, getSeoContext()));

export default async function RouteCataloguePage() {
  const published = await getPublishedTrails();
  const catalogue = [...new Map([...trails, ...published].map(trail => [trail.id, trail])).values()];
  const context = getSeoContext();
  const seo = catalogueSeo(catalogue, regions, context);
  return <><Header/><main id="main" className="seo-catalogue-main">
    <SeoBreadcrumbs breadcrumbs={seo.breadcrumbs}/>
    <header className="seo-catalogue-heading">
      <span className="eyebrow">Каталог Тропиныча</span>
      <h1 className="heading-3">{seo.heading}</h1>
      <p className="body-3">{seo.description}</p>
      <p className="body-6">Здесь собраны карточки с подробным описанием. Все найденные линии троп доступны на карте, в том числе те, для которых сведений пока мало.</p>
      <a className="button secondary" href={canonicalUrl('/', context)}>Выбрать маршрут на карте <ArrowRight size={18}/></a>
    </header>
    <section aria-label="Маршруты с описаниями">
      <ul className="seo-route-list">{seo.links.map(item => <li key={item.url}>
        <a href={item.url}>
          <h2 className="title-2">{item.name}</h2>
          {item.description && <p className="body-6">{item.description}</p>}
          <span className="button-sm">Карта и описание <ArrowRight size={18}/></span>
        </a>
      </li>)}</ul>
    </section>
    <p className="seo-catalogue-note body-6">{seo.limitations.join(' ')}</p>
    {process.env.NEXT_PUBLIC_STATIC_EXPORT !== 'true' && <script type="application/ld+json" dangerouslySetInnerHTML={{__html: serializeJsonLd(seo.structuredData)}}/>}
  </main><Footer/></>;
}
