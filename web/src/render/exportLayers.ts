/** Export-only visibility. Omitted flags preserve the normal complete map. */
export interface ExportLayers {
  background: boolean;
  terrain: boolean;
  water: boolean;
  landuse: boolean;
  city: boolean;
  streets: boolean;
  roads: boolean;
  labels: boolean;
  decor: boolean;
}

export const EXPORT_LAYER_NAMES: readonly (keyof ExportLayers)[] = [
  'background', 'terrain', 'water', 'landuse', 'city', 'streets', 'roads', 'labels', 'decor',
];

export function exportLayerPreset(preset: 'all' | 'city' | 'terrain' | 'roads'): ExportLayers {
  return Object.fromEntries(EXPORT_LAYER_NAMES.map((key) => [key,
    preset === 'all' || (preset === 'city' && (key === 'city' || key === 'streets'))
    || (preset === 'terrain' && key === 'terrain') || (preset === 'roads' && (key === 'roads' || key === 'streets')),
  ])) as unknown as ExportLayers;
}
