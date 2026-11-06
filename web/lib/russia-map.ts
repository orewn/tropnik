import {russiaCamera,russiaPadding, RUSSIA_AREA_URL,RUSSIA_MASK_URL,RUSSIA_CANONICAL_MASK_URL} from '@/public/maps/russia-viewport.js';
import {loadPublicJSON} from './map-preload';

export function russiaView(element: HTMLElement, tileSize = 512) {
  const rect=element.getBoundingClientRect();
  const panel=element.closest('.explore-layout')?.querySelector('.explore-panel')?.getBoundingClientRect();
  const overlap=panel&&panel.right>rect.left&&panel.left<rect.right&&panel.top<rect.bottom&&panel.bottom>rect.top;
  const covered=overlap?Math.max(0,rect.bottom-Math.max(rect.top,panel.top)):0;
  element.parentElement?.style.setProperty('--map-bottom-inset',`${covered}px`);
  const padding=russiaPadding(rect.width,rect.height,covered);
  return {camera:russiaCamera(rect.width,rect.height,padding,tileSize),padding};
}

export async function loadRussiaGeometry(canonicalMask = false) {
  const [area,mask]=await Promise.all([
    loadPublicJSON<GeoJSON.FeatureCollection>(RUSSIA_AREA_URL),
    loadPublicJSON<GeoJSON.FeatureCollection>(canonicalMask?RUSSIA_CANONICAL_MASK_URL:RUSSIA_MASK_URL),
  ]);
  return {area,mask};
}
