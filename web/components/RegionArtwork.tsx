import artwork from '@/lib/region-artwork.generated.json';
import {MapIcon} from './MapIcon';
import {territoryArtwork, territoryForShape} from '@/lib/territories';
import {regionById} from '@/lib/content';

type Outline = {status: string; shapeNames: string[]; parts: {name: string; sourceId: string; path: string}[]};
const outlines = artwork.artwork as Record<string, Outline>;

/** Decorative silhouettes come only from the checked local geographic dataset. */
export function RegionArtwork({regionId}: {regionId: string}) {
  const region = regionById(regionId);
  const administrative = region?.shapeNames.length === 1 ? territoryForShape(region.shapeNames[0]) : undefined;
  const territory = territoryArtwork.get(administrative?.id || regionId);
  if (territory) return <svg className="region-artwork" viewBox="0 0 100 100" aria-hidden="true" focusable="false" data-artwork="source-outline" data-region={regionId}><path d={territory} className="region-artwork-shape" fillRule="evenodd" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/></svg>;
  const outline = outlines[regionId];
  if (outline?.status !== 'available' || !outline.parts.length) {
    return <span className="region-artwork region-artwork-symbol" aria-hidden="true" data-artwork="direction-symbol"><MapIcon name="compass"/></span>;
  }
  return <svg className="region-artwork" viewBox={artwork.viewBox} aria-hidden="true" focusable="false" data-artwork="source-outline" data-region={regionId}>
    {outline.parts.map(part => <path key={part.sourceId} d={part.path} className="region-artwork-shape" fillRule="evenodd" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>) }
  </svg>;
}
