import type {MetadataRoute} from 'next';
import {canonicalUrl} from '@/lib/seo';
import {getSeoContext} from '@/lib/seo-metadata';

export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const context = getSeoContext();
  if (!context.publicIndexing) return {rules: {userAgent: '*', disallow: '/'}};
  const base = new URL(context.siteUrl).pathname.replace(/\/$/, '');
  // Crawlers must be able to read page-level noindex on personal tools.
  // API access control is enforced independently of this crawl policy.
  return {
    rules: {userAgent: '*', allow: base + '/', disallow: base + '/api/'},
    sitemap: canonicalUrl('/sitemap.xml', {...context, trailingSlash: false}),
  };
}
