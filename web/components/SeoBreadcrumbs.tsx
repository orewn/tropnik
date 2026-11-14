import type {SeoPage} from '@/lib/seo';

export function SeoBreadcrumbs({breadcrumbs}: Pick<SeoPage, 'breadcrumbs'>) {
  return <nav className="seo-breadcrumbs" aria-label="Хлебные крошки">
    <ol>{breadcrumbs.map((item, index) => <li key={item.url}>
      {index === breadcrumbs.length - 1
        ? <span aria-current="page">{item.name}</span>
        : <a href={item.url}>{item.name}</a>}
    </li>)}</ol>
  </nav>;
}
