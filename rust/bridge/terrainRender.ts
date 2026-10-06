import type { World } from '../../web/src/gen/types';
import { marchingSquares } from '../../web/src/gen/terrain/contour';
import { slopeGrid } from '../../web/src/gen/core/grid';
import { contourSet, CONTOUR_INTERVAL } from '../../web/src/render/contours';
import { CANVAS_MAP_STROKES, mapStrokeWidth } from '../../web/src/render/strokes';
import { encodePng, pngDataUrl, renderTerrainPixels } from '../../web/src/render/raster';
import { PALETTES } from '../../web/src/render/styles';
import type { TerrainData, TerrainSettings } from './terrain';

export type TerrainStyle = 'parchment' | 'atlas' | 'topographic' | 'copernicus';
export interface TerrainScene { svg: string; imageUrl: string; contourStep: number }
let coastClipId = 0;

/** Close land outside the tile, including mainland edges and holes, then smooth
 * the sub-cell contour. SVG antialiases this boundary at the actual screen zoom. */
export function terrainLandClip(terrain: TerrainData): string {
  const n = terrain.resolution, cell = terrain.width / n, size = n + 4;
  const field = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = Math.max(0, Math.min(n - 1, x - 2)), sy = Math.max(0, Math.min(n - 1, y - 2));
    const h = terrain.height[sy * n + sx];
    field[y * size + x] = x === 0 || y === 0 || x === size - 1 || y === size - 1 ? -Math.max(1, Math.abs(h)) : h;
  }
  const paths = marchingSquares(field, size, size, 0, cell, -1.5 * cell, -1.5 * cell);
  return paths.map(path => {
    const points = path.pts;
    if (!path.closed || points.length < 3) return '';
    const middle = (i: number, j: number): string => `${((points[i].x + points[j].x) / 2).toFixed(3)},${((points[i].y + points[j].y) / 2).toFixed(3)}`;
    return `M${middle(points.length - 1, 0)}` + points.map((point, i) => `Q${point.x.toFixed(3)},${point.y.toFixed(3)} ${middle(i, (i + 1) % points.length)}`).join('') + 'Z';
  }).join('');
}

function coastImage(terrain: TerrainData, imageUrl: string, sea: string): string {
  const width = terrain.width, id = `terrain-land-${++coastClipId}`;
  return `<defs><clipPath id="${id}"><path d="${terrainLandClip(terrain)}" clip-rule="evenodd"/></clipPath></defs>${sea}<image width="${width}" height="${width}" href="${imageUrl}" clip-path="url(#${id})"/>`;
}

// Extend land color slightly past its geometric edge so clipped raster filtering
// cannot paint a paper/sea fringe over the antialiased vector shoreline.
function extendLandColors(rgb: Uint8Array, terrain: TerrainData): void {
  const n = terrain.resolution, original = rgb.slice();
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    if (terrain.height[i] > 0) continue;
    let nearest = -1, distance = Infinity;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy, d = dx * dx + dy * dy;
      if (xx < 0 || yy < 0 || xx >= n || yy >= n || d >= distance) continue;
      const index = yy * n + xx;
      if (terrain.height[index] > 0) { nearest = index; distance = d; }
    }
    if (nearest >= 0) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = original[nearest * 3 + c];
  }
}

/** Match the working application's Canvas stroke weights at the current zoom. */
export function terrainContourWidths(style: TerrainStyle, scale: number): { thin: number; index: number } {
  const pal = PALETTES[style === 'copernicus' ? 'parchment' : style];
  return {
    thin: mapStrokeWidth(CANVAS_MAP_STROKES.contour, scale) * scale,
    index: mapStrokeWidth(CANVAS_MAP_STROKES.contourIndex, scale, pal.contourIndexW / 1.6) * scale,
  };
}

// Low to high elevation; interpolate RGB directly, without lighting or contours.
const elevationColors = [
  [0, 32, 96], [0, 160, 70], [255, 230, 0], [235, 35, 20],
  [128, 128, 128], [255, 255, 255],
] as const;

function renderElevation(terrain: TerrainData, frame: boolean): TerrainScene {
  const n = terrain.resolution, width = terrain.width;
  const rgb = new Uint8Array(n * n * 3);
  const coastal = terrain.globalMinHeight < 0;
  const landMin = coastal ? 0 : terrain.globalMinHeight;
  const range = Math.max(1e-6, terrain.globalMaxHeight - landMin);
  for (let i = 0; i < terrain.height.length; i++) {
    // Use the engine's global range so camera regions retain the same colors.
    if (coastal && terrain.height[i] <= 0) {
      const depth = Math.max(0, Math.min(1, terrain.height[i] / terrain.globalMinHeight));
      rgb[i * 3] = Math.round(35 - 27 * depth); rgb[i * 3 + 1] = Math.round(125 - 85 * depth); rgb[i * 3 + 2] = Math.round(175 - 79 * depth);
      continue;
    }
    const t = Math.max(0, Math.min(1, (terrain.height[i] - landMin) / range));
    const position = (coastal ? 1 : 0) + t * (elevationColors.length - (coastal ? 2 : 1));
    const index = Math.min(elevationColors.length - 2, Math.floor(position));
    const a = elevationColors[index], b = elevationColors[index + 1], u = position - index;
    for (let channel = 0; channel < 3; channel++) rgb[i * 3 + channel] = Math.round(a[channel] + (b[channel] - a[channel]) * u);
  }
  let sea = '';
  if (coastal) {
    const water = rgb.slice();
    for (let i = 0; i < terrain.height.length; i++) if (terrain.height[i] > 0) water.set([35, 125, 175], i * 3);
    sea = `<image width="${width}" height="${width}" href="${pngDataUrl(encodePng(water, n, n))}"/>`;
    extendLandColors(rgb, terrain);
  }
  const imageUrl = pngDataUrl(encodePng(rgb, n, n));
  let svg = coastal ? coastImage(terrain, imageUrl, sea) : `<image width="${width}" height="${width}" href="${imageUrl}"/>`;
  if (frame) svg += `<rect width="${width}" height="${width}" fill="none" stroke="#333333" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`;
  return { svg, imageUrl, contourStep: 0 };
}

/** Transitional renderer adapter. Rust never depends on the legacy World schema. */
export function renderRustTerrain(terrain: TerrainData, style: TerrainStyle, frame = true, settings: Pick<TerrainSettings, 'relief' | 'width'> = { relief: 'mountains', width: terrain.width }): TerrainScene {
  if (style === 'copernicus') return renderElevation(terrain, frame);
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
    heightRange: { min: Math.max(0, terrain.globalMinHeight), max: terrain.globalMaxHeight }, exaggeration: 2,
    grainCoordinates: { x: terrain.x, y: terrain.y, cell: terrain.motifSize / 512 },
  });
  const coastal = terrain.globalMinHeight < 0 && !cavern;
  if (coastal) extendLandColors(pixels.rgb, terrain);
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
  // Wider mountain spacing avoids tinting steep slopes with dense ink.
  // Keep the shared smoothing and small/near-flat loop filtering.
  const relief = settings.relief === 'flat' || settings.relief === 'hills' || settings.relief === 'valley' ? settings.relief : 'mountains';
  const step = CONTOUR_INTERVAL[relief] * (relief === 'mountains' ? 2 : 1);
  const height = legacyRasterInput.terrain.height;
  const contours = cavern ? { thin: [], index: [] } : contourSet({
    terrain: { height, slope: slopeGrid(height) }, options: { relief },
  } as unknown as World, settings.width / 1600, step);
  const pathData = (paths: typeof contours.thin): string => paths.map(path => path.pts.map((point, i) => `${i ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join('') + (path.closed ? 'Z' : '')).join('');
  const thin = pathData(contours.thin), index = pathData(contours.index);
  const weights = terrainContourWidths(style, 1e-6);
  let svg = `<rect width="${width}" height="${width}" fill="${pal.paper}"/>`;
  svg += coastal ? coastImage(terrain, background, `<rect width="${width}" height="${width}" fill="${pal.seaFill}"/>`) : `<image width="${width}" height="${width}" href="${background}"/>`;
  if (!cavern) svg += `<g class="layer-contours" fill="none" stroke="${pal.contour}" stroke-linejoin="round" stroke-linecap="round"><path d="${thin}" style="stroke-width:var(--terrain-contour-width,${weights.thin}px)" vector-effect="non-scaling-stroke" opacity="${pal.contourOpacity * 0.5}"/><path d="${index}" style="stroke-width:var(--terrain-contour-index-width,${weights.index}px)" vector-effect="non-scaling-stroke" opacity="${pal.contourOpacity * 0.75}"/></g>`;
  if (frame) svg += `<rect x="0" y="0" width="${width}" height="${width}" fill="none" stroke="${pal.frame}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`;
  return { svg, imageUrl: background, contourStep: cavern ? 0 : step };
}
