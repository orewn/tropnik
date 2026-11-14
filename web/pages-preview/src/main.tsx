import {StrictMode, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import build from 'virtual:pages-build';
import {resolvePage} from './routing';
import {BRAND} from '../../lib/brand';
import {ServiceWorker} from '../../components/ServiceWorker';
import 'virtual:pages-layout-styles';
import './preview.css';

const loaders = {
  home: () => import('../../app/page'),
  routes: () => import('../../app/routes/page'),
  region: () => import('../../app/regions/[id]/page'),
  route: () => import('../../app/routes/[id]/page'),
  about: () => import('../../app/about/page'), safety: () => import('../../app/safety/page'),
  'safety/registration': () => import('../../app/safety/registration/page'),
  sources: () => import('../../app/sources/page'), privacy: () => import('../../app/privacy/page'),
  terms: () => import('../../app/terms/page'), offline: () => import('../../app/offline/page'),
  trips: () => import('../../app/trips/page'), community: () => import('../../app/community/page'),
  guides: () => import('../../app/guides/page'), account: () => import('../../app/account/page'),
  'account/action': () => import('../../app/account/action/page'),
  search: () => import('../../app/search/page'),
  planner: () => import('../../app/planner/page'),
  moderation: () => import('../../app/moderation/page'),
  android: () => build.hasApk ? import('../../app/android/page') : import('./android-unavailable'),
  preview: () => import('./preview-info'), missing: () => import('../../app/not-found'),
};

async function start() {
  const page = resolvePage(window.location.pathname);
  const key = (page?.kind || 'missing') as keyof typeof loaders;
  const pageModule = await (loaders[key] || loaders.missing)();
  // The reused app pages are pure server page functions. Resolve their async data boundary once,
  // then mount the original client components normally; no Next server is shipped or required.
  const renderPage = pageModule.default as (props: {params: Promise<{id?: string}>; searchParams: Promise<Record<string, string>>}) => ReactNode | Promise<ReactNode>;
  const content = await renderPage({params: Promise.resolve({id: page?.id}), searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(location.search)))});
  // The generated HTML owns the page-specific search and sharing metadata.
  // Do not replace it with the compact routing label after client startup.
  if (!page) document.title = `Страница не найдена · ${BRAND.name}`;
  // Use the same load/idle scheduling and update lifecycle as the main app.
  // Installing the offline shell must not compete with the first map paint.
  createRoot(document.getElementById('root')!).render(<StrictMode><a className="skip-link" href="#main">Перейти к содержимому</a>{content}<ServiceWorker/></StrictMode>);
}

void start().catch(error => {
  console.error('Static preview failed to start', error);
  // The first-response article is useful on its own. A failed lazy chunk must
  // not erase its description, source links or catalogue navigation.
  if (document.getElementById('static-load-notice')) return;
  const notice = document.createElement('aside');
  notice.id = 'static-load-notice';
  notice.className = 'pages-preview-load-notice';
  notice.setAttribute('role', 'status');
  const message = document.createElement('p');
  message.textContent = 'Интерактивная часть не загрузилась. Описание и ссылки остаются доступными.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button secondary';
  retry.textContent = 'Повторить загрузку';
  retry.addEventListener('click', () => window.location.reload());
  notice.appendChild(message);
  notice.appendChild(retry);
  const root = document.getElementById('root');
  root?.parentNode?.insertBefore(notice, root);
});
