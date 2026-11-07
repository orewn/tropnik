import {Header} from '@/components/Header';
import {Explore} from '@/components/Explore';
import {Footer} from '@/components/Footer';
import {HomeEditorial} from '@/components/HomeEditorial';
import {getPublishedTrails} from '@/lib/server';

export default async function Home({searchParams}: {searchParams: Promise<{region?: string; route?: string}>}) {
  const params = await searchParams;
  const published = await getPublishedTrails();
  return <>
    <Header/>
    <main id="main">
      <Explore initialPublished={published} initialRegion={params.region} initialTrail={params.route}/>
      <HomeEditorial/>
    </main>
    <Footer/>
  </>;
}
