export class StaticPageNotFound extends Error {}
export function notFound(): never {throw new StaticPageNotFound('Страница не найдена');}
export function useRouter() {
  return {
    push(href: string) {window.location.assign(href);},
    replace(href: string) {window.location.replace(href);},
    refresh() {window.location.reload();},
    back() {window.history.back();},
    forward() {window.history.forward();},
    prefetch() {return Promise.resolve();},
  };
}
