import build from 'virtual:pages-build';

/** The same pure module is executed by the browser and by production-output verification. */
export function resolvePage(pathname: string) {
  let decoded: string;
  try {decoded = decodeURI(pathname);} catch {return undefined;}
  if (decoded === build.base.slice(0, -1)) return build.pages.find(page => page.path === '/');
  if (!decoded.startsWith(build.base)) return undefined;
  const suffix = decoded.slice(build.base.length).replace(/(?:\/)?index\.html$/, '').replace(/\/+$/, '');
  const route = suffix ? '/' + suffix : '/';
  return build.pages.find(page => page.path === route);
}
