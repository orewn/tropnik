import {notFound} from 'next/navigation';

const profiles = {
  small: [320, 640], phone: [390, 844], large: [412, 915],
  landscape: [844, 390], tablet: [768, 1024], desktop: [1280, 800],
} as const;

/** Internal same-origin frames allow visual QA without changing the user's browser settings. */
export default async function QAMobile({searchParams}: {searchParams: Promise<{profile?: string; page?: string}>}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const params = await searchParams;
  const profile = Object.hasOwn(profiles, params.profile || '') ? params.profile as keyof typeof profiles : 'phone';
  const [width, height] = profiles[profile];
  const pages = ['/', '/search', '/planner', '/safety/registration', '/offline', '/trips', '/community', '/guides'];
  const page = pages.includes(params.page || '') ? params.page! : '/';
  return <main style={{display:'grid',justifyItems:'center',alignContent:'start',gap:16,padding:16,background:'#d3d8c7',minHeight:'100vh'}}>
    <nav aria-label="Профиль проверки" style={{display:'flex',flexWrap:'wrap',gap:16}}>{Object.entries(profiles).map(([key, [w, h]]) => <a key={key} href={`/qa-mobile?profile=${key}&page=${encodeURIComponent(page)}`} aria-current={profile===key?'page':undefined}>{w} × {h}</a>)}</nav>
    <iframe src={page} title={`Проверка интерфейса · ${width} × ${height}`} style={{width,height,maxWidth:'none',border:'1px solid #b7c5a5',borderRadius:16,boxShadow:'0 16px 64px #244d3c25'}}/>
  </main>;
}
