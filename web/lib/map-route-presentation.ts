/** Display-only route treatment. It never simplifies, joins or reorders tracks. */
export const ROUTE_PRESENTATION = Object.freeze({
  ink: '#244D3C',
  paper: '#FFFEFA',
  accent: '#A56736',
  closeZoom: 10,
});

export function routeStrokeWidth(zoom: number): number {
  const value = Number.isFinite(zoom) ? zoom : 10;
  return 3 + Math.max(0, Math.min(1, (value - 8) / 6)) * 2;
}

export function territoryDetailOpacity(zoom: number): number {
  const value = Number.isFinite(zoom) ? zoom : 2;
  return 1 - Math.max(0, Math.min(1, (value - 7) / 4)) * .78;
}

export type RouteEdge = {
  coordinate: [longitude: number, latitude: number];
  kind: 'first' | 'last' | 'shared';
  label: string;
};

/** A multi-part source does not establish a start, finish or traversal order.
 * Only one non-degenerate source line receives edge labels, with at most two
 * tiny markers regardless of vertex count. These are not recommended trailheads. */
export function routeLineEdges(data: GeoJSON.GeoJSON): RouteEdge[] {
  let line: GeoJSON.Position[] | undefined;
  let parts = 0;
  const add = (coordinates: GeoJSON.Position[]) => {
    if (coordinates.length < 2) return;
    parts++;
    if (parts === 1) line = coordinates;
  };
  const visit = (value: GeoJSON.GeoJSON | null): void => {
    if (!value || parts > 1) return;
    if (value.type === 'FeatureCollection') for (const feature of value.features) visit(feature);
    else if (value.type === 'Feature') visit(value.geometry);
    else if (value.type === 'GeometryCollection') for (const geometry of value.geometries) visit(geometry);
    else if (value.type === 'LineString') add(value.coordinates);
    else if (value.type === 'MultiLineString') for (const coordinates of value.coordinates) {
      add(coordinates);
      if (parts > 1) break;
    }
  };
  visit(data);
  if (parts !== 1 || !line) return [];
  const first = line[0], last = line[line.length - 1];
  const same = (a: GeoJSON.Position, b: GeoJSON.Position) =>
    Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(((a[0] - b[0]) % 360 + 540) % 360 - 180) < 1e-9;
  if (!line.some(point => !same(first, point))) return [];
  const firstCoordinate: [number, number] = [first[0], first[1]];
  if (same(first, last)) return [{coordinate: firstCoordinate, kind: 'shared', label: 'Совпадающие края исходной линии'}];
  return [
    {coordinate: firstCoordinate, kind: 'first', label: 'Край А исходной линии'},
    {coordinate: [last[0], last[1]], kind: 'last', label: 'Край Б исходной линии'},
  ];
}

/** Two passive DOM marks at most. They cannot consume a map drag or click. */
export function createRouteEdgeElement(edge: RouteEdge): HTMLDivElement {
  const element = document.createElement('div');
  element.className = `route-edge-marker route-edge-marker--${edge.kind}`;
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', edge.label);
  const badge = document.createElement('span');
  badge.className = 'route-edge-badge';
  badge.textContent = edge.kind === 'last' ? 'Б' : 'А';
  badge.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'route-edge-label';
  label.textContent = edge.kind === 'shared' ? 'А · Б' : edge.kind === 'last' ? 'Точка Б' : 'Точка А';
  label.setAttribute('aria-hidden', 'true');
  element.appendChild(badge);
  element.appendChild(label);
  return element;
}
