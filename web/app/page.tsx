import {Header} from '@/components/Header';
import {Explore} from '@/components/Explore';
import {Footer} from '@/components/Footer';
import {HomeEditorial} from '@/components/HomeEditorial';
import {getPublishedTrails} from '@/lib/server';
import {regions, trails} from '@/lib/content';
import {homeSeo, serializeJsonLd} from '@/lib/seo';
import {getSeoContext, seoMetadata} from '@/lib/seo-metadata';

export const metadata = seoMetadata(homeSeo(getSeoContext(), regions, trails));

export default async function Home({searchParams}: {searchParams: Promise<{region?: string; route?: string}>}) {
  const params = await searchParams;
  const published = await getPublishedTrails();
  const catalogue = [...new Map([...trails, ...published].map(trail => [trail.id, trail])).values()];
  const seo = homeSeo(getSeoContext(), regions, catalogue);
  return <>
    <Header/>
    <main id="main">
      <Explore initialPublished={published} initialRegion={params.region} initialTrail={params.route}/>
      <HomeEditorial/>
      {process.env.NEXT_PUBLIC_STATIC_EXPORT !== 'true' && <script type="application/ld+json" dangerouslySetInnerHTML={{__html: serializeJsonLd(seo.structuredData)}}/>}
    </main>
    <Footer/>
  </>;
}
