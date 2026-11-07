export function MapResourceHints() {
  return <>
    <link rel="preconnect" href="https://tiles.openfreemap.org" crossOrigin="anonymous"/>
    <link rel="preconnect" href="https://tiles.mapterhorn.com" crossOrigin="anonymous"/>
    <link rel="preload" href="/data/russia-display-area.geojson" as="fetch" crossOrigin="anonymous"/>
    <link rel="preload" href="/maps/tropa-style.json" as="fetch" crossOrigin="anonymous"/>
  </>;
}
