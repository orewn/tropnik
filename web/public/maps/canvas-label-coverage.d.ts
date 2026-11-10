import type {LabelRule, LeafletLayerOptions, View, leafletLayer} from 'protomaps-leaflet';

export function canvasLabelsInCoverage(rules: readonly LabelRule[], area: unknown): LabelRule[];
export function createCanvasLabelLayer(
  protomaps: {leafletLayer: typeof leafletLayer},
  ground: {views: Map<string, View>},
  rules: readonly LabelRule[],
  area: unknown,
  options?: LeafletLayerOptions,
): ReturnType<typeof leafletLayer>;
