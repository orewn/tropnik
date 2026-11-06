import {StrictMode, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import build from 'virtual:pages-build';
import {resolvePage} from './routing';
import 'virtual:pages-layout-styles';
import './preview.css';

const loaders = {
  home: () => import('../../app/page'),
  region: () => import('../../app/regions/[id]/page'),
  route: () => import('../../app/routes/[id]/page'),
  about: () => import('../../app/about/page'), safety: () => import('../../app/safety/page'),
  sources: () => import('../../app/sources/page'), privacy: () => import('../../app/privacy/page'),
  terms: () => import('../../app/terms/page'), offline: () => import('../../app/offline/page'),
  trips: () => import('../../app/trips/page'), community: () => import('../../app/community/page'),
  guides: () => import('../../app/guides/page'), account: () => import('../../app/account/page'),
  'account/action': () => import('../../app/account/action/page'),
  search: () => import('../../app/search/page'),
  moderation: () => import('../../app/moderation/page'),
  android: () => build.hasApk ? import('../../app/android/page') : import('./android-unavailable'),
  preview: () => import('./preview-info'), missing: () => import('../../app/not-found'),
};

async function start() {
  const page = resolvePage(window.location.pathname);
  const key = (page?.kind || 'missing') as keyof typeof loaders;
  const module = await (loaders[key] || loaders.missing)();
  // The reused app pages are pure server page functions. Resolve their async data boundary once,
  // then mount the original client components normally; no Next server is shipped or required.
  const renderPage = module.default as (props: {params: Promise<{id?: string}>; searchParams: Promise<Record<string, string>>}) => ReactNode | Promise<ReactNode>;
  let content: ReactNode;
  try {content = await renderPage({params: Promise.resolve({id: page?.id}), searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(location.search)))});}
  catch (error) {console.error('Static page unavailable', error); content = (await loaders.missing()).default();}
  document.title = `${page?.title || 'Страница не найдена'} · Тропник`;
  createRoot(document.getElementById('root')!).render(<StrictMode><a className="skip-link" href="#main">Перейти к содержимому</a>{content}</StrictMode>);
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register(`${build.base}sw.js`, {scope: build.base}).catch(error => console.info('Offline shell not installed', error));
}

void start().catch(error => {
  console.error('Static preview failed to start', error);
  createRoot(document.getElementById('root')!).render(<><main id="main" className="pages-preview-boot"><h1>Не удалось открыть страницу</h1><p>Обновите страницу при устойчивой связи. Сохранённые данные можно открыть в автономном режиме.</p><a href={`${build.base}offline-viewer.html`}>Открыть автономную карту</a></main></>);
});
