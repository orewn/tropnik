import {CustomMapEngine, inRussiaCoverage} from './custom-map-entry';
import type {CustomMapCamera} from '../../web/lib/custom-map-camera';
import type {CustomMapMarker} from '../../web/lib/custom-map-engine';
import {NativeMapRouteLoader, type NativeMapRoute} from './native-map-route';
import {NativeMapCatalogue} from './native-map-catalogue';
import {NativeMapModeController} from './native-map-mode';
import {TrailOverlayLoader} from '../../web/lib/map-trail-overlay';
import {encodeDiagnosticMessage, prepareOutsideLabelEvidence, type OutsideLabelEvidence} from './native-map-diagnostics';

// Only a native-owned, exact-origin transferred port can command this view.
// No JavascriptInterface, DOM storage, service worker or account bridge exists.
const ORIGIN = 'https://map.tropnik.invalid';
const element = document.getElementById('map')!;
let port: MessagePort | undefined, generation = 0, sequence = 0;
let engine: CustomMapEngine | undefined, debug = false;
const catalogue = new NativeMapCatalogue(ORIGIN);
const routeLoader = new NativeMapRouteLoader(ORIGIN, (geometry, id, coastal) => engine?.setRoute(geometry, id, coastal), fetch,
  (bytes, geometry, id) => catalogue.verifyRoute(bytes, geometry, id));
let trailOverlay: TrailOverlayLoader | undefined, preparingOverlay: Promise<void> | undefined;
let visibleTrailIds: string[] = [], selectedRouteId: string | undefined, paths = true;
let routeCommandVersion = 0;
let modeController: NativeMapModeController | undefined;
let error = '', frame = 0, initialized = false, sentSourceFrame = false;
let position: [number, number] | null = null;
let markerCoordinates = new Map<string, [number, number]>();
let labelFixture: {longitude: number; latitude: number} | undefined;
let fixtureVersion = 0, fixtureEvidence: {key: string; value: OutsideLabelEvidence} | undefined, preparingEvidence = '';
let painted: {frame: number; camera: CustomMapCamera; pitch: number; size: {width: number; height: number}} | undefined;
const trustedInput: Record<string, unknown>[] = [];
let inputSequence = 0;

function inputTarget(target: EventTarget | null) {
  const node = target as Element | null;
  const marker = typeof node?.closest === 'function' ? node.closest<HTMLButtonElement>('[data-map-marker-id]') : null;
  return {tag: node?.tagName?.toLowerCase() || '', markerId: marker?.dataset.mapMarkerId || '', groupKey: marker?.dataset.mapGroupKey || marker?.dataset.mapMarkerId || ''};
}

function installInputDiagnostics() {
  // This port is enabled only by the DEBUG native host. Observe the browser's
  // real trusted stream without synthesizing, cancelling or retargeting input.
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click', 'contextmenu']) element.addEventListener(type, event => {
    if (!debug || !event.isTrusted) return;
    const pointer = event as PointerEvent;
    const receipt = {sequence: ++inputSequence, type, trusted: true, timeStamp: event.timeStamp, receivedAt: performance.now(),
      x: pointer.clientX, y: pointer.clientY, pointerId: pointer.pointerId, pointerType: pointer.pointerType,
      target: inputTarget(event.target), frame, camera: engine?.getCamera()};
    if (trustedInput.length === 16) trustedInput.shift();
    trustedInput.push(receipt);send('debugReceipt', {phase: 'trusted-input', ...receipt});
  }, {capture: true, passive: true});
}

function send(type: string, payload: unknown = {}) {port?.postMessage(JSON.stringify({version: 1, generation, type, payload}));}
function refreshOverlay() {
  const map = engine;if (!map?.getState().ready) return;
  if (trailOverlay) trailOverlay.update({ids: paths && !labelFixture ? visibleTrailIds : [], selectedId: selectedRouteId, bounds: [...map.getBounds()], zoom: map.getCamera().zoom});
  else if (visibleTrailIds.length && paths && !preparingOverlay) {
    preparingOverlay = catalogue.manifest().then(manifest => {
      if (engine !== map) return;
      send('overlayError', {message: ''});
      trailOverlay = new TrailOverlayLoader({url: manifest.overlay.url, sha256: manifest.overlay.sha256,
        load: (url, priority, signal) => catalogue.load(url, priority, signal),
        onChange: entries => {if (engine === map) map.setTrailOverlay(entries);},
        onError: message => {if (engine === map) send('overlayError', {message});}});
      refreshOverlay();
    }).catch(caught => {if (engine === map && caught?.name !== 'AbortError') send('overlayError', {message: 'Линии троп не загрузились. Повторите загрузку карты.'});})
      .finally(() => {preparingOverlay = undefined;});
  }
}
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
  const camera = map?.getCamera(), pitch = map?.getPitch(), size = map?.getSize(), bounds = element.getBoundingClientRect();
  const moving = element.dataset.mapMoving === 'true';
  const ready = !!map?.getState().ready && sentSourceFrame;
  // Camera setters commit their target before RAF draws the marker DOM. Input
  // may use these coordinates only after the matching frame has really drawn.
  const inputReady = ready && !!painted && !!camera && !!size && !moving &&
    camera.center[0] === painted.camera.center[0] && camera.center[1] === painted.camera.center[1] &&
    camera.zoom === painted.camera.zoom && (camera.bearingDegrees || 0) === (painted.camera.bearingDegrees || 0) &&
    pitch === painted.pitch && size.width === painted.size.width && size.height === painted.size.height &&
    size.width === element.clientWidth && size.height === element.clientHeight;
  return {ready, frame, error, camera, pitch, moving, inputReady, painted, state: map?.getState(), rendered,
    catalogue: {visibleIds: visibleTrailIds, selectedId: selectedRouteId, paths, loader: trailOverlay?.inspect()},
    requestedMode: modeController?.requested, online: modeController?.online,
    centerTrailHit: debug && map && size ? map.pickTrail({x: size.width / 2, y: size.height / 2}, 8) : undefined,
    size, viewportSize: {width: element.clientWidth, height: element.clientHeight},
    viewportBounds: {x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height}, routeId: element.dataset.mapDrawnRoute || '', coverage: map?.getCoverage()?.status,
    trustedInput: [...trustedInput],
    markers: [...element.querySelectorAll<HTMLButtonElement>('[data-map-marker-id]')].map(button => {
      const r = button.getBoundingClientRect(), base = element.getBoundingClientRect();
      const hidden = button.hidden || getComputedStyle(button).display === 'none';
      const hit = hidden ? null : document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {id: button.dataset.mapMarkerId, groupKey: button.dataset.mapGroupKey || button.dataset.mapMarkerId, hidden,
        x: r.x - base.x + r.width / 2, y: r.y - base.y + r.height / 2, width: r.width, height: r.height,
        hitAtMarker: inputTarget(hit)};
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
  refreshOverlay();
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
    case 'route': {
      if (!Number.isSafeInteger(payload.version) || Number(payload.version) <= routeCommandVersion) break;
      routeCommandVersion = Number(payload.version);
      selectedRouteId = typeof payload.id === 'string' ? payload.id : undefined;
      refreshOverlay();await routeLoader.update(payload as NativeMapRoute);break;
    }
    case 'catalogue': {
      const ids = payload.ids;
      if (!Array.isArray(ids) || ids.length > 100000 || ids.some(id => typeof id !== 'string' || !/^[a-z0-9-]{1,128}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('Invalid map catalogue filter');
      visibleTrailIds = [...ids];refreshOverlay();break;
    }
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
    case 'layers': {
      if (payload.paths !== undefined) paths = payload.paths === true;
      engine.setLayers({...(payload.relief === undefined ? {} : {relief: payload.relief === true}), paths});refreshOverlay();break;
    }
    case 'mode': modeController?.select(payload.mode);break;
    case 'retry': engine.retry();trailOverlay?.retry();refreshOverlay();break;
    case 'pitch': engine.setPitch(payload.tilted === true ? 40 : 0);break;
    case 'eco': engine.setEco(payload.enabled === true);document.body.dataset.mapEco = String(payload.enabled === true);break;
    case 'active': engine.setActive(payload.active === true);break;
    case 'network': {
      // The native broker independently enforces this policy for every request.
      modeController?.network(payload.enabled === true);if (payload.enabled === true) trailOverlay?.retry();break;
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
    case 'destroy': routeLoader.dispose();trailOverlay?.destroy();catalogue.dispose();engine.destroy();engine = undefined;modeController = undefined;port?.close();port = undefined;break;
    default: throw new Error('Unknown map command');
  }
}
window.addEventListener('message', event => {
  if (initialized || location.origin !== ORIGIN || event.ports.length !== 1) return;
  let hello: {type?: string;version?: number;generation?: number;debug?: boolean};
  try {hello = JSON.parse(String(event.data));} catch {return;}
  if (hello.type !== 'tropnik-map-port' || hello.version !== 1 || !Number.isSafeInteger(hello.generation) || hello.generation! <= 0) return;
  initialized = true;generation = hello.generation!;debug = hello.debug === true;port = event.ports[0];
  if (debug) installInputDiagnostics();
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
      onReady: () => {document.documentElement.dataset.mapState = 'ready';send('ready');refreshOverlay();},
      onFrame: camera => {
        frame++;element.dataset.mapDetail = engine && engine.getCamera().zoom >= 10 ? 'close' : 'wide';
        if (debug && engine) painted = {frame, camera: {...camera, center: [...camera.center]}, pitch: engine.getPitch(), size: {...engine.getSize()}};
        const sourceTiles = engine?.getState().residentTiles || 0;
        if (!sentSourceFrame && sourceTiles > 0) {sentSourceFrame = true;send('frame', {frame, sourceTiles});}
        prepareFixtureFrame();
      },
      onSettled: value => {if (value.zoom < 10 && engine && engine.getPitch() > 0) engine.setPitch(0);send('camera', {camera: value, pitch: engine?.getPitch() || 0});refreshOverlay();},
      onMarker: id => {const coordinate = markerCoordinates.get(id), coverage = engine?.getCoverage();if (coordinate && coverage && inRussiaCoverage(coordinate[0], coordinate[1], coverage.area)) send('marker', {id});},
      onClick: point => {const id = engine?.pickTrail(point, 8);if (id && (id === selectedRouteId || visibleTrailIds.includes(id))) send('trail', {id});},
      onOverlayError: message => send('rasterError', {message}),
      onState: state => send('state', {...state, requestedMode: modeController?.requested || 'detail', online: modeController?.online || false})});
    modeController = new NativeMapModeController(engine);
    document.documentElement.dataset.mapState = 'loading';
  } catch {failure('Карта не открылась. Карточки и источники доступны.');}
});
window.addEventListener('error', () => failure('Карта не открылась. Карточки и источники доступны.'));
window.addEventListener('unhandledrejection', event => {if (event.reason?.name !== 'AbortError') failure('Карта не смогла загрузить данные. Сохранённые карточки доступны.');});
