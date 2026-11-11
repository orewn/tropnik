import {CustomMapEngine, inRussiaCoverage} from './custom-map-entry';
import type {CustomMapCamera} from '../../web/lib/custom-map-camera';
import type {CustomMapMarker} from '../../web/lib/custom-map-engine';
import {NativeMapRouteLoader, type NativeMapRoute} from './native-map-route';
import {encodeDiagnosticMessage, prepareOutsideLabelEvidence, type OutsideLabelEvidence} from './native-map-diagnostics';

// Only a native-owned, exact-origin transferred port can command this view.
// No JavascriptInterface, DOM storage, service worker or account bridge exists.
const ORIGIN = 'https://map.tropnik.invalid';
const element = document.getElementById('map')!;
let port: MessagePort | undefined, generation = 0, sequence = 0;
let engine: CustomMapEngine | undefined, debug = false;
const routeLoader = new NativeMapRouteLoader(ORIGIN, (geometry, id) => engine?.setRoute(geometry, id));
let error = '', frame = 0, initialized = false, sentSourceFrame = false;
let position: [number, number] | null = null;
let markerCoordinates = new Map<string, [number, number]>();
let labelFixture: {longitude: number; latitude: number} | undefined;
let fixtureVersion = 0, fixtureEvidence: {key: string; value: OutsideLabelEvidence} | undefined, preparingEvidence = '';

function send(type: string, payload: unknown = {}) {port?.postMessage(JSON.stringify({version: 1, generation, type, payload}));}
function failure(message: string) {error = message;document.documentElement.dataset.mapState = 'failed';send('error', {message});}
function camera(value: unknown): CustomMapCamera {
  const c = value as CustomMapCamera;
  if (!c || !Array.isArray(c.center) || c.center.length !== 2 || !c.center.every(Number.isFinite) || Math.abs(c.center[0]) > 720 || Math.abs(c.center[1]) > 85.052 || !Number.isFinite(c.zoom) || c.zoom < 0 || c.zoom > 17 || (c.bearingDegrees !== undefined && !Number.isFinite(c.bearingDegrees))) throw new Error('Invalid map camera');
  return {center: [c.center[0], c.center[1]], zoom: c.zoom, bearingDegrees: c.bearingDegrees || 0};
}
function snapshot() {
  const map = engine;
  const {labels, ...rendered} = map?.inspect() || {};
  const evidence = fixtureEvidence?.key === labelEvidenceKey() ? fixtureEvidence.value : undefined;
  return {ready: !!map?.getState().ready && sentSourceFrame, frame, error, camera: map?.getCamera(), pitch: map?.getPitch(), moving: element.dataset.mapMoving === 'true', state: map?.getState(), rendered,
    size: map?.getSize(), routeId: element.dataset.mapDrawnRoute || '', coverage: map?.getCoverage()?.status,
    markers: [...element.querySelectorAll<HTMLButtonElement>('[data-map-marker-id]')].map(button => {
      const r = button.getBoundingClientRect(), base = element.getBoundingClientRect();
      return {id: button.dataset.mapMarkerId, groupKey: button.dataset.mapGroupKey || button.dataset.mapMarkerId, hidden: button.hidden || getComputedStyle(button).display === 'none',
        x: r.x - base.x + r.width / 2, y: r.y - base.y + r.height / 2, width: r.width, height: r.height};
    }), labels, outsideLabelProbes: evidence?.probes || [], labelEvidence: evidence && {examined: evidence.examined, limited: evidence.limited},
    labelFixture: labelFixture && {...labelFixture, status: evidence ? 'ready' : 'preparing', point: map?.project([labelFixture.longitude, labelFixture.latitude])}};
}
function labelEvidenceKey() {
  if (!labelFixture || !engine) return '';
  const map = engine, domestic = map?.getLabelDiagnostics().find(label => label.id === 'domestic' && label.visible);
  return labelFixture && map?.getCoverage()?.status.ready && domestic?.rect
    ? JSON.stringify([fixtureVersion, map.getCamera(), map.getPitch(), map.getSize(), map.getCoverage()?.status.revision, domestic.rect]) : '';
}
function prepareFixtureFrame() {
  if (!debug || !labelFixture) return;
  const map = engine, key = labelEvidenceKey(), version = fixtureVersion;
  if (!debug || !map || !key || key === fixtureEvidence?.key || key === preparingEvidence || !labelFixture) return;
  const domestic = map.getLabelDiagnostics().find(label => label.id === 'domestic' && label.visible)!, area = map.getCoverage()!.area;
  const boundary = map.project([labelFixture.longitude, labelFixture.latitude]);
  preparingEvidence = key;const startedAt = performance.now();
  void prepareOutsideLabelEvidence(domestic.rect!, boundary.x, point => map.unproject(point), coordinate => inRussiaCoverage(coordinate[0], coordinate[1], area),
    () => engine === map && fixtureVersion === version && labelEvidenceKey() === key).then(value => {
      if (engine !== map || labelEvidenceKey() !== key) return;
      fixtureEvidence = {key, value};
      send('fixture', {status: 'ready', frame, version, examined: value.examined, probes: value.probes.length, limited: value.limited, preparationMs: performance.now() - startedAt});
    }, caught => {
      if (caught?.name !== 'AbortError') send('fixture', {status: 'error', version, message: 'Label evidence could not be prepared'});
    }).finally(() => {if (preparingEvidence === key) preparingEvidence = '';});
}
async function installLabelFixture() {
  if (!debug || !engine?.getCoverage()) throw new Error('Debug map fixture is unavailable');
  const coverage = engine.getCoverage()!;
  fixtureVersion++;fixtureEvidence = undefined;labelFixture = undefined;
  send('fixture', {status: 'preparing', version: fixtureVersion});
  engine.setCamera({center: [132, 43.1], zoom: 10}, false);
  if (!coverage.status.ready) await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {unsubscribe();reject(new Error('Coverage fixture did not settle'));}, 10000);
    const unsubscribe = coverage.subscribe(() => {if (coverage.status.ready) {clearTimeout(timer);unsubscribe();resolve();}});
  });
  await document.fonts.ready;
  // Use the actual reviewed Russia coast. Source annotations pass through the
  // same anchor admission, collision and whole-text draw as decoded MVT labels.
  const latitude = 43.1;
  const inside = (longitude: number) => inRussiaCoverage(longitude, latitude, coverage.area);
  let west = 131.85, east = 132.15, found = false, nearest = Infinity;
  for (let longitude = 131.85; longitude < 132.15; longitude += .01) {
    if (inside(longitude) && !inside(longitude + .01) && Math.abs(longitude - 132) < nearest) {west = longitude;east = longitude + .01;nearest = Math.abs(longitude - 132);found = true;}
  }
  if (!found) throw new Error('Reviewed coast could not be resolved');
  for (let i = 0; i < 32; i++) {const middle = (west + east) / 2;if (inside(middle)) west = middle;else east = middle;}
  const longitude = (west + east) / 2;
  labelFixture = {longitude, latitude};
  engine.setMarkers([]);engine.setRoute(undefined);engine.setPitch(0);engine.setMode('detail');engine.setLayers({paths: false, boundaries: false, relief: false});
  engine.setCamera({center: [longitude, latitude], zoom: 10}, false);
  engine.setLabels([
    {id: 'domestic', coordinate: [longitude - .0005, latitude], label: 'ПРИМОРСК', kind: 'place', rank: 0, color: '#102018'},
    {id: 'foreign', coordinate: [longitude + .02, latitude], label: 'ЗАРУБЕЖНЫЙ', kind: 'place', rank: 0, color: '#102018'},
  ]);
}
async function command(type: string, payload: Record<string, unknown>) {
  if (!engine) throw new Error('Map has not initialized');
  switch (type) {
    case 'camera': engine.setCamera(camera(payload.camera), payload.animate === true);break;
    case 'fit': {
      const bounds = payload.bounds as number[], padding = Number(payload.padding || 0);
      if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] > bounds[2] || bounds[1] > bounds[3] || Math.abs(bounds[1]) > 85.052 || Math.abs(bounds[3]) > 85.052 || !Number.isFinite(padding) || padding < 0 || padding > 300) throw new Error('Invalid map bounds');
      engine.fit(bounds as [number, number, number, number], {top: padding, right: padding, bottom: padding, left: padding}, Number(payload.maxZoom || 17), payload.animate !== false);break;
    }
    case 'markers': {
      const markers = payload.markers as CustomMapMarker[];
      if (!Array.isArray(markers) || markers.length > 1024 || markers.some(m => typeof m.id !== 'string' || m.id.length > 160 || typeof m.label !== 'string' || m.label.length > 400 || !['direction', 'trail', 'plan'].includes(m.kind) || !Array.isArray(m.coordinate) || m.coordinate.length !== 2 || !m.coordinate.every(Number.isFinite))) throw new Error('Invalid map markers');
      markerCoordinates = new Map(markers.map(marker => [marker.id, marker.coordinate]));
      engine.setMarkers(markers);engine.setPosition(position);break;
    }
    case 'route': await routeLoader.update(payload as NativeMapRoute);break;
    case 'position': {
      const coordinate = payload.coordinate as [number, number] | null;
      if (coordinate !== null && (!Array.isArray(coordinate) || coordinate.length !== 2 || !coordinate.every(Number.isFinite))) throw new Error('Invalid position');
      const inside = coordinate !== null && !!engine.getCoverage() && inRussiaCoverage(coordinate[0], coordinate[1], engine.getCoverage()!.area);
      position = inside ? coordinate : null;engine.setPosition(position);send('position', {inside, measuredAt: payload.measuredAt});
      if (inside && payload.recenter === true) engine.setCamera({center: coordinate!, zoom: 11}, true);break;
    }
    case 'region': if (!Array.isArray(payload.shapes) || payload.shapes.some(s => typeof s !== 'string' || s.length > 160)) throw new Error('Invalid region');else engine.setRegion(payload.shapes as string[]);break;
    case 'zoom': {const delta = Number(payload.delta);if (!Number.isFinite(delta) || Math.abs(delta) > 1) throw new Error('Invalid zoom');engine.zoomBy(delta);break;}
    case 'north': engine.north();break;
    case 'layers': engine.setLayers({relief: payload.relief === true});break;
    case 'pitch': engine.setPitch(payload.tilted === true ? 40 : 0);break;
    case 'eco': engine.setEco(payload.enabled === true);document.body.dataset.mapEco = String(payload.enabled === true);break;
    case 'active': engine.setActive(payload.active === true);break;
    case 'network': {
      // The native broker independently enforces this policy for every request.
      // Switching modes invalidates source requests without discarding the view.
      engine.setMode('overview');engine.setMode('detail');break;
    }
    case 'snapshot': {
      if (!debug || !Number.isSafeInteger(payload.requestId)) throw new Error('Debug command disabled');
      const startedAt = performance.now();send('debugReceipt', {phase: 'snapshot-start', requestId: payload.requestId, startedAt, frame});
      const value = {...snapshot(), requestId: payload.requestId, timing: {startedAt, preparedAt: performance.now()}};
      const encoded = encodeDiagnosticMessage({version: 1, generation, type: 'snapshot', payload: value});
      if (encoded.encoded) {port?.postMessage(encoded.encoded);send('debugReceipt', {phase: 'snapshot-sent', requestId: payload.requestId, finishedAt: performance.now(), chars: encoded.chars, utf8Bytes: encoded.utf8Bytes});}
      else send('debugReceipt', {phase: 'snapshot-rejected', requestId: payload.requestId, reason: 'message-budget', chars: encoded.chars, utf8Bytes: encoded.utf8Bytes});
      break;
    }
    case 'labelFixture': if (!debug) throw new Error('Debug command disabled');await installLabelFixture();break;
    case 'destroy': routeLoader.dispose();engine.destroy();engine = undefined;port?.close();port = undefined;break;
    default: throw new Error('Unknown map command');
  }
}
window.addEventListener('message', event => {
  if (initialized || location.origin !== ORIGIN || event.ports.length !== 1) return;
  let hello: {type?: string;version?: number;generation?: number;debug?: boolean};
  try {hello = JSON.parse(String(event.data));} catch {return;}
  if (hello.type !== 'tropnik-map-port' || hello.version !== 1 || !Number.isSafeInteger(hello.generation) || hello.generation! <= 0) return;
  initialized = true;generation = hello.generation!;debug = hello.debug === true;port = event.ports[0];
  port.onmessage = event => {
    try {
      const data = JSON.parse(String(event.data));
      if (data.version !== 1 || data.generation !== generation || !Number.isSafeInteger(data.sequence) || data.sequence <= sequence || typeof data.type !== 'string' || !data.payload || typeof data.payload !== 'object') return;
      sequence = data.sequence;const seq = sequence;
      void command(data.type, data.payload).then(() => send('ack', {sequence: seq}), caught => {
        if (caught?.name !== 'AbortError') send('commandError', {sequence: seq, command: data.type, ...(debug ? {detail: String(caught?.message || caught).slice(0, 240)} : {}), message: data.type === 'route' ? 'Линия маршрута не загрузилась. Карточка и обзорная карта доступны.' : 'Карта не смогла выполнить действие.'});
      });
    } catch {failure('Не удалось обработать состояние карты.');}
  };
  port.start();
  try {
    engine = new CustomMapEngine(element, {camera: {center: [105, 62], zoom: 0}, maxZoom: 17,
      onReady: () => {document.documentElement.dataset.mapState = 'ready';send('ready');},
      onFrame: () => {
        frame++;element.dataset.mapDetail = engine && engine.getCamera().zoom >= 10 ? 'close' : 'wide';
        const sourceTiles = engine?.getState().residentTiles || 0;
        if (!sentSourceFrame && sourceTiles > 0) {sentSourceFrame = true;send('frame', {frame, sourceTiles});}
        prepareFixtureFrame();
      },
      onSettled: value => {if (value.zoom < 10 && engine && engine.getPitch() > 0) engine.setPitch(0);send('camera', {camera: value, pitch: engine?.getPitch() || 0});},
      onMarker: id => {const coordinate = markerCoordinates.get(id), coverage = engine?.getCoverage();if (coordinate && coverage && inRussiaCoverage(coordinate[0], coordinate[1], coverage.area)) send('marker', {id});},onState: state => send('state', state)});
    document.documentElement.dataset.mapState = 'loading';
  } catch {failure('Карта не открылась. Карточки и источники доступны.');}
});
window.addEventListener('error', () => failure('Карта не открылась. Карточки и источники доступны.'));
window.addEventListener('unhandledrejection', event => {if (event.reason?.name !== 'AbortError') failure('Карта не смогла загрузить данные. Сохранённые карточки доступны.');});
