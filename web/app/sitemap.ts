import type {MetadataRoute} from 'next';
import {getOrigin, isPublicIndexingEnabled, regions} from '@/lib/content';
import {getPublishedTrails} from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!isPublicIndexingEnabled()) return [];
  const origin = getOrigin();
  const published = (await getPublishedTrails()).filter(trail => trail.publicationStatus === 'published');

  // A dated seasonal closure or guide requirement does not remove a useful,
  // published route page from search. Reference and private pages stay excluded.
  // checkedAt is a source review date, not a reliable page-modification timestamp.
  return [
    {url: origin},
    {url: origin + '/about'},
    {url: origin + '/safety'},
    {url: origin + '/sources'},
    ...regions.filter(region => published.some(trail => trail.regionId === region.id))
      .map(region => ({url: origin + '/regions/' + region.id})),
    ...published.map(trail => ({url: origin + '/routes/' + trail.id})),
  ];
}
