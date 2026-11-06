export class StaticPageNotFound extends Error {}
export function notFound(): never {throw new StaticPageNotFound('Страница не найдена');}
