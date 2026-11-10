import {russiaCamera,russiaPadding} from '@/public/maps/russia-viewport.js';
import {loadMapCoverage} from '@/public/maps/map-coverage-lod.js';

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
  return loadMapCoverage({canonicalMask});
}
