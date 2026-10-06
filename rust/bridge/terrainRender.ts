import type { World } from '../../web/src/gen/types';
import { marchingSquares } from '../../web/src/gen/terrain/contour';
import { encodePng, pngDataUrl, renderTerrainPixels } from '../../web/src/render/raster';
import { PALETTES } from '../../web/src/render/styles';
import type { TerrainData } from './terrain';

export type TerrainStyle = 'parchment' | 'atlas' | 'topographic';
export interface TerrainScene { svg: string; imageUrl: string; contourStep: number }

/** Transitional renderer adapter. Rust never depends on the legacy World schema. */
export function renderRustTerrain(terrain: TerrainData, style: TerrainStyle, frame = true): TerrainScene {
  const n = terrain.resolution, width = terrain.width, cell = width / n;
  const cavern = terrain.caveMask.length > 0;
  // Stable continuous shading, without engraved bands or high-frequency paper grain.
  const pal = { ...PALETTES[style], hatch: 0, grain: 0 };
  // The shared rasterizer only reads mapSize, terrain.height and terrain.water.
  const legacyRasterInput = {
    mapSize: width,
    terrain: { height: { w: n, h: n, cell, data: terrain.height }, water: new Uint8Array(n * n) },
  } as unknown as World;
  const pixels = renderTerrainPixels(legacyRasterInput, pal, {
    pixels: n, surface: terrain.height,
    normals: { x: terrain.normalX, y: terrain.normalY, z: terrain.normalZ },
    heightRange: { min: terrain.globalMinHeight, max: terrain.globalMaxHeight }, exaggeration: 2,
    grainCoordinates: { x: terrain.x, y: terrain.y, cell: terrain.motifSize / 512 },
  });
  if (cavern) {
    for (let i = 0; i < n * n; i++) if (terrain.caveMask[i]) {
      // Black rock with continuous inward-facing wall light; no stripes or grain.
      const nx = terrain.normalX[i], ny = terrain.normalY[i], nz = terrain.normalZ[i];
      const slope = Math.hypot(nx, ny);
      const shade = Math.max(0, Math.min(72, slope * (36 - 42 * nx - 42 * ny) + (1 - nz) * 12));
      pixels.rgb[i * 3] = shade; pixels.rgb[i * 3 + 1] = shade; pixels.rgb[i * 3 + 2] = shade;
    }
  }
  const background = pngDataUrl(encodePng(pixels.rgb, pixels.w, pixels.h));
  // The engine samples a continuous physical surface for each camera region.
  // Contours use those same samples; their levels remain fixed across cameras.
  const range = terrain.globalMaxHeight - terrain.globalMinHeight;
  const rawStep = Math.max(1, range / 24);
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].find(value => value * power >= rawStep)! * power;
  let thin = '', index = '';
  for (let level = Math.ceil(terrain.minHeight / step) * step; !cavern && level < terrain.maxHeight; level += step) {
    const paths = marchingSquares(terrain.height, n, n, level, cell, cell / 2, cell / 2);
    const d = paths.map(path => path.pts.length > 1 ? path.pts.map((point, i) => `${i ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join('') + (path.closed ? 'Z' : '') : '').join('');
    if (Math.round(level / step) % 5 === 0) index += d; else thin += d;
  }
  let svg = `<rect width="${width}" height="${width}" fill="${pal.paper}"/><image width="${width}" height="${width}" href="${background}"/>`;
  if (!cavern) svg += `<g fill="none" stroke="${pal.contour}" stroke-linejoin="round"><path d="${thin}" stroke-width="0.55" vector-effect="non-scaling-stroke" opacity="${pal.contourOpacity * 0.65}"/><path d="${index}" stroke-width="1.1" vector-effect="non-scaling-stroke" opacity="${pal.contourOpacity}"/></g>`;
  if (frame) svg += `<rect x="0" y="0" width="${width}" height="${width}" fill="none" stroke="${pal.frame}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`;
  return { svg, imageUrl: background, contourStep: cavern ? 0 : step };
}
