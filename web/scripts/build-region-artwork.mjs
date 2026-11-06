#!/usr/bin/env node
/** Build small, source-backed regional silhouettes without downloading data. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'public/data/regions.geojson');
const outputPath = path.join(root, 'lib/region-artwork.generated.json');
const sourceBytes = fs.readFileSync(sourcePath);
const source = JSON.parse(sourceBytes);
const size = 1024, padding = 64;
const fail = message => {throw new Error(message);};

// Read the actual catalogue rather than maintaining a second mapping of places.
const catalogue = ts.createSourceFile('content.ts', fs.readFileSync(path.join(root, 'lib/content.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
let declaration;
for (const statement of catalogue.statements) {
  if (!ts.isVariableStatement(statement)) continue;
  declaration ??= statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === 'regions');
}
if (!declaration?.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) fail('The region catalogue must be a literal array');
const definitions = declaration.initializer.elements.map(element => {
  if (!ts.isObjectLiteralExpression(element)) fail('Invalid region definition');
  const property = name => element.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(catalogue) === name)?.initializer;
  const id = property('id'), aliases = property('shapeNames');
  if (!id || !ts.isStringLiteral(id) || !aliases || !ts.isArrayLiteralExpression(aliases) || !aliases.elements.every(ts.isStringLiteral)) fail('Region id and shapeNames must be literal strings');
  return {id: id.text, shapeNames: aliases.elements.map(item => item.text)};
});
if (new Set(definitions.map(item => item.id)).size !== definitions.length) fail('Duplicate region ids');
if (source.type !== 'FeatureCollection' || !Array.isArray(source.features)) fail('Expected the local region FeatureCollection');

const area = ring => Math.abs(ring.reduce((sum, point, i) => {
  const next = ring[(i + 1) % ring.length];
  return sum + point[0] * next[1] - next[0] * point[1];
}, 0)) / 2;
const shapes = {};
for (const definition of definitions) {
  const features = source.features.filter(feature => definition.shapeNames.includes(feature.properties?.shapeName));
  if (!features.length) {
    // No outline is invented for a place absent from this historical dataset.
    shapes[definition.id] = {status: 'unavailable', shapeNames: [], parts: []};
    continue;
  }
  const parts = features.map(feature => {
    const geometry = feature.geometry;
    if (!['Polygon', 'MultiPolygon'].includes(geometry?.type)) fail('Unsupported regional geometry');
    return {name: feature.properties.shapeName, sourceId: feature.properties.shapeID,
      polygons: geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates};
  });
  const points = parts.flatMap(part => part.polygons.flat(2));
  if (!points.length || points.some(point => !Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90)) fail('Invalid source coordinates');
  const west = Math.min(...points.map(point => point[0])), east = Math.max(...points.map(point => point[0]));
  const south = Math.min(...points.map(point => point[1])), north = Math.max(...points.map(point => point[1]));
  if (east - west > 180 || west === east || south === north) fail('This artwork projection requires a nondegenerate region without a dateline crossing');
  const latitude = (south + north) / 2, cosine = Math.cos(latitude * Math.PI / 180);
  const width = (east - west) * cosine, height = north - south, scale = (size - 2 * padding) / Math.max(width, height);
  const left = (size - width * scale) / 2, top = (size - height * scale) / 2;
  const project = point => [left + (point[0] - west) * cosine * scale, top + (north - point[1]) * scale];
  let sourceArea = 0, retainedArea = 0, quantizedArea = 0, sourceRings = 0, outputRings = 0, omittedSubpixelRings = 0;
  const outputParts = parts.map(part => {
    const paths = [];
    for (const polygon of part.polygons) {
      let exteriorKept = false;
      for (let index = 0; index < polygon.length; index++) {
        const ring = polygon[index];
        if (ring.length < 4 || ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) fail('Source rings must be closed');
        const projected = ring.slice(0, -1).map(project), ringArea = area(projected), sign = index === 0 ? 1 : -1;
        sourceArea += sign * ringArea; sourceRings++;
        const rounded = projected.map(point => point.map(Math.round)).filter((point, i, all) => i === 0 || point[0] !== all[i - 1][0] || point[1] !== all[i - 1][1]);
        if (rounded.length > 1 && rounded[0][0] === rounded.at(-1)[0] && rounded[0][1] === rounded.at(-1)[1]) rounded.pop();
        const roundedArea = rounded.length >= 3 ? area(rounded) : 0;
        if (roundedArea === 0 || (index > 0 && !exteriorKept)) {
          if (ringArea >= 4) fail(`A significant source ring collapsed for ${part.name}`);
          omittedSubpixelRings++;
          continue;
        }
        if (index === 0) exteriorKept = true;
        if (rounded.some(point => point.some(value => !Number.isInteger(value) || value < padding || value > size - padding))) fail('Projected silhouette exceeds its viewport');
        retainedArea += sign * ringArea; quantizedArea += sign * roundedArea; outputRings++;
        paths.push('M' + rounded.map(point => point.join(' ')).join('L') + 'Z');
      }
    }
    if (!paths.length) fail(`No source outline survived for ${part.name}`);
    return {name: part.name, sourceId: part.sourceId, path: paths.join('')};
  });
  const areaError = Math.abs(quantizedArea - sourceArea) / sourceArea;
  if (!Number.isFinite(areaError) || areaError > .005 || retainedArea / sourceArea < .999) fail(`Regional silhouette lost significant area: ${definition.id}`);
  shapes[definition.id] = {status: 'available', shapeNames: features.map(feature => feature.properties.shapeName), parts: outputParts,
    verification: {sourceRings, outputRings, omittedSubpixelRings, retainedSourceAreaFraction: Number((retainedArea / sourceArea).toFixed(8)), projectedAreaRelativeError: Number(areaError.toFixed(8)),
      projection: 'Local equirectangular, north up; longitude scaled at the bounds midpoint latitude', midpointLatitude: latitude, sourceBounds: [west, south, east, north],
      maximumCoordinateRoundingSvgUnits: .5}};
}

const result = {schemaVersion: 1, source: {path: '/data/regions.geojson', sha256: createHash('sha256').update(sourceBytes).digest('hex')},
  viewBox: `0 0 ${size} ${size}`, artwork: shapes};
const bytes = JSON.stringify(result) + '\n';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(outputPath, 'utf8') !== bytes) fail('Region artwork is missing or stale; run build-region-artwork.mjs');
} else {
  fs.writeFileSync(outputPath, bytes);
}
console.log(JSON.stringify({checkOnly: process.argv.includes('--check'), bytes: Buffer.byteLength(bytes), sourceSha256: result.source.sha256,
  regions: Object.fromEntries(Object.entries(shapes).map(([id, entry]) => [id, {status: entry.status, sourceShapes: entry.shapeNames, ...entry.verification}]))}, null, 2));
