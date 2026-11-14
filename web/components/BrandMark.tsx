/** A summit and a switchback. Kept identical in the favicon and app icons. */
export function BrandMark({size = 40}: {size?: number}) {
  return <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <path d="M6 31 20 7 34 31" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M12 31h11a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h4" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}
