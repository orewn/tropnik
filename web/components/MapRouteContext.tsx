import {MapIcon} from './MapIcon';

/** Occupies the existing map-context slot, so detail never adds another overlay. */
export function MapRouteContext({title}: {title: string}) {
  return <div className="map-context map-route-context" aria-label={`Выбранная тропа: ${title}`}>
    <MapIcon name="map" size={24}/>
    <div className="map-route-context-copy">
      <small>Выбранная тропа</small>
      <strong title={title}>{title}</strong>
    </div>
  </div>;
}
