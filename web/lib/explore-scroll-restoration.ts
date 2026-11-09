type ScrollEnvironment = Pick<Window, 'history' | 'addEventListener' | 'removeEventListener'>;

/** Explore owns its same-document map navigation. A persisted document offset
 * must not move the map and its Back button behind the sticky site header.
 * Acquire before entries are created: Chromium snapshots the destination's
 * restoration mode before popstate. Full-page/BFCache navigation releases this
 * ownership; ordinary wheel/touch scrolling is never intercepted. */
export function bindExploreScrollRestoration(environment: ScrollEnvironment = window): () => void {
  const {history} = environment;
  let previous = history.scrollRestoration;
  let owned = false;
  let disposed = false;
  const acquire = () => {
    if (disposed || owned) return;
    previous = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    owned = true;
  };
  const release = () => {
    if (!owned) return;
    owned = false;
    if (history.scrollRestoration === 'manual') history.scrollRestoration = previous;
  };
  acquire();
  environment.addEventListener('pagehide', release);
  environment.addEventListener('pageshow', acquire);
  return () => {
    if (disposed) return;
    disposed = true;
    environment.removeEventListener('pagehide', release);
    environment.removeEventListener('pageshow', acquire);
    release();
  };
}
