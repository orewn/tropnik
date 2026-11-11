export function MapResourceHints() {
  return <>
    <link rel="preconnect" href="https://tiles.openfreemap.org" crossOrigin="anonymous"/>
    <link rel="preconnect" href="https://tiles.mapterhorn.com" crossOrigin="anonymous"/>
    <link rel="preload" href="/data/map-coverage/manifest.json" as="fetch" crossOrigin="anonymous"/>
  </>;
}
