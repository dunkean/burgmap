import { panelSvg, type MapInformation, type Panel } from '../render/legend';

/** Reuse the renderer's symbols and wording outside the map on compact screens. */
export function mapInformationHtml(info: MapInformation): string {
  const svg = (panel: Panel, label: string, cls: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}" viewBox="-8 -8 ${panel.w + 16} ${panel.h + 16}">${panelSvg(panel, 0, 0, 1, info.fontFamily, cls)}</svg>`;
  return svg(info.cartouche, 'Map title and population', 'map-info-title')
    + svg(info.legend, 'Map legend', 'map-info-legend');
}
