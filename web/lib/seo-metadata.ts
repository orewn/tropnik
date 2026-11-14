import type {Metadata} from 'next';
import {getOrigin, isPublicIndexingEnabled} from './content';
import type {SeoContext, SeoPage} from './seo';

export function getSeoContext(): SeoContext {
  return {siteUrl: getOrigin(), publicIndexing: isPublicIndexingEnabled(), trailingSlash: true};
}

/** Keep Next and the static export on the same page identity and indexing policy. */
export function seoMetadata(page: SeoPage): Metadata {
  return {
    title: {absolute: page.title},
    description: page.description,
    alternates: {canonical: page.canonical},
    robots: {index: page.indexable, follow: true},
    openGraph: {
      type: 'website', locale: 'ru_RU', siteName: page.siteName,
      title: page.title, description: page.description, url: page.canonical,
      images: [{url: page.image, width: 1200, height: 630, alt: page.siteName}],
    },
    twitter: {
      card: 'summary_large_image', title: page.title, description: page.description,
      images: [page.image],
    },
  };
}
