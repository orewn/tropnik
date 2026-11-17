/** Header links remain usable without the map workspace. An already mounted
 * workspace can consume the intent without replacing its renderer or camera. */
export const MOBILE_NAVIGATION_EVENT = 'tropnik:mobile-navigation';
export const MOBILE_NAVIGATION_STATE_EVENT = 'tropnik:mobile-navigation-state';
export const MAP_OVERLAY_EVENT = 'tropnik:map-overlay';
export type MobileDestination = 'map' | 'saved';

export function requestMobileDestination(destination: MobileDestination): boolean {
  return !window.dispatchEvent(new CustomEvent(MOBILE_NAVIGATION_EVENT, {cancelable: true, detail: destination}));
}

export function announceMobileDestination(destination: MobileDestination): void {
  window.dispatchEvent(new CustomEvent(MOBILE_NAVIGATION_STATE_EVENT, {detail: destination}));
}

export function closeMapOverlays(): void {
  window.dispatchEvent(new Event(MAP_OVERLAY_EVENT));
}
