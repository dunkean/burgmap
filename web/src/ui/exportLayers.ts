import { EXPORT_LAYER_NAMES, exportLayerPreset, type ExportLayers } from '../render/exportLayers';

const LABELS: Record<keyof ExportLayers, string> = {
  background: 'Paper background', terrain: 'Relief & contours', water: 'Water',
  landuse: 'Vegetation & fields', city: 'Buildings & town grounds', streets: 'Town streets & bridges',
  roads: 'Regional roads & bridges', labels: 'Names', decor: 'Frame, title & legend',
};

/** These controls only affect downloads; they never trigger generation or change the viewer. */
export function createExportLayerControls(root: HTMLElement): () => ExportLayers {
  const checks = new Map<keyof ExportLayers, HTMLInputElement>();
  const preset = root.querySelector<HTMLSelectElement>('select')!;
  const grid = root.querySelector<HTMLElement>('.g2')!;
  for (const key of EXPORT_LAYER_NAMES) {
    const label = document.createElement('label'); label.className = 'check';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = true;
    input.id = 'exportLayer-' + key;
    label.append(input, document.createTextNode(LABELS[key])); grid.append(label); checks.set(key, input);
    input.addEventListener('change', () => { preset.value = 'custom'; });
  }
  preset.addEventListener('change', () => {
    if (preset.value === 'custom') return;
    const layers = exportLayerPreset(preset.value as 'all' | 'city' | 'terrain' | 'roads');
    for (const [key, input] of checks) input.checked = layers[key];
  });
  return () => Object.fromEntries([...checks].map(([key, input]) => [key, input.checked])) as unknown as ExportLayers;
}
