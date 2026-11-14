import type {MetadataRoute} from 'next';
import {regions, trails} from '@/lib/content';
import {getPublishedTrails} from '@/lib/server';
import {catalogueSeo, homeSeo, infoSeo, regionSeo, routeSeo} from '@/lib/seo';
import {getSeoContext} from '@/lib/seo-metadata';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const context = getSeoContext();
  if (!context.publicIndexing) return [];
  const published = await getPublishedTrails();
  const catalogue = [...new Map([...trails, ...published].map(trail => [trail.id, trail])).values()];
  // Search eligibility describes useful public content, independently of whether
  // a guided departure is published. A source-review date is not page lastmod.
  const pages = [
    homeSeo(context, regions, catalogue), catalogueSeo(catalogue, regions, context),
    infoSeo('about', 'О проекте', context),
    ...regions.map(region => regionSeo(region, catalogue, context)),
    ...catalogue.map(trail => routeSeo(trail, regions, context)),
  ];
  return [...new Set(pages.filter(page => page.indexable).map(page => page.canonical))].map(url => ({url}));
}
