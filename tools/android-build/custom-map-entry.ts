// One renderer for the site, saved web viewer and Android. This entry only
// publishes the reviewed core; no platform owns a second camera or painter.
import {CustomMapEngine} from '../../web/lib/custom-map-engine';
import {inRussiaCoverage} from '../../web/public/maps/russia-viewport.js';
import {readRouteGeometry} from '../../web/lib/route-geometry';
import {verifyReviewedCoastalRoute} from '../../web/lib/reviewed-coastal-routes';
import '../../web/app/custom-map.css';
import '../../web/app/map-direction-marker.css';
import '../../web/app/map-detail.css';
import './custom-map-host.css';

const TropnikMapAPI = Object.freeze({version: 1, CustomMapEngine, inRussiaCoverage});
if (typeof window !== 'undefined') Object.defineProperty(window, 'TropnikMapAPI', {value: TropnikMapAPI, configurable: false});
export {CustomMapEngine, inRussiaCoverage, readRouteGeometry, verifyReviewedCoastalRoute, TropnikMapAPI};
