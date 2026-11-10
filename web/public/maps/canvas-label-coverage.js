import {inRussiaCoverage} from './russia-viewport.js';

function coveredAnchor(anchor, zoom, area) {
  if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || !Number.isFinite(zoom)) return false;
  // Protomaps Labeler passes anchors after transformGeom(origin, scale), in
  // global CSS pixels at layout.zoom. Device pixel ratio and source overzoom
  // have already been accounted for; neither belongs in this conversion.
  const world = 256 * 2 ** zoom;
  if (!Number.isFinite(world) || world <= 0 || anchor.y < 0 || anchor.y > world) return false;
  const longitude = anchor.x / world * 360 - 180;
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * anchor.y / world))) * 180 / Math.PI;
  return inRussiaCoverage(longitude, latitude, area);
}

/** Geographic eligibility is checked before Labeler inserts collision boxes.
 * Keep the entire accepted label, including its halo, above the geographic
 * mask. Do not clip glyphs or infer nationality from the label's language. */
export function canvasLabelsInCoverage(rules, area) {
  return rules.map(rule => {
    const symbolizer = rule.symbolizer;
    return {...rule, symbolizer: {
      place(layout, geom, feature) {
        const candidates = symbolizer.place(layout, geom, feature);
        if (!candidates) return undefined;
        const current = typeof area === 'function' ? area() : area;
        const accepted = candidates.filter(label => coveredAnchor(label.anchor, layout.zoom, current));
        return accepted.length ? accepted : undefined;
      },
    }};
  });
}

/** A transparent label renderer shares the ground renderer's exact Views.
 * Protomaps 5.1 exposes views on the layer; each View owns a TileCache whose
 * inflight map coalesces concurrent requests before decoding the vector tile.
 * sources:{} prevents constructing an unused second network source. */
export function createCanvasLabelLayer(p, ground, rules, area, options = {}) {
  const labels = p.leafletLayer({
    ...options, pane: options.pane || 'russia-labels', sources: {},
    paintRules: [], labelRules: canvasLabelsInCoverage(rules, area),
    backgroundColor: undefined, attribution: '',
  });
  labels.views = ground.views;
  return labels;
}
