import { zlibSync } from 'fflate';
import type { World } from '../gen/types';
import { Palette, hexToRgb } from './styles';

// ---------- PNG encoder ----------
let crcTable: Uint32Array | null = null;
function crc32(buf: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** Encode 8-bit RGB (channels=3) or RGBA (channels=4) pixels as PNG. */
export function encodePng(pixels: Uint8Array | Uint8ClampedArray, w: number, h: number, channels: 3 | 4 = 3): Uint8Array {
  const stride = w * channels;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const ro = y * (stride + 1);
    raw[ro] = 1; // Sub filter
    const po = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[po + x - channels] : 0;
      raw[ro + 1 + x] = (pixels[po + x] - left) & 255;
    }
  }
  const idat = zlibSync(raw, { level: 6 });
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = channels === 3 ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toBase64(b: Uint8Array): string {
  const parts: string[] = [];
  const n = b.length;
  let s = '';
  for (let i = 0; i < n; i += 3) {
    const a = b[i], c = i + 1 < n ? b[i + 1] : 0, d = i + 2 < n ? b[i + 2] : 0;
    s += B64[a >> 2] + B64[((a & 3) << 4) | (c >> 4)] + (i + 1 < n ? B64[((c & 15) << 2) | (d >> 6)] : '=') + (i + 2 < n ? B64[d & 63] : '=');
    if (s.length > 8192) { parts.push(s); s = ''; }
  }
  parts.push(s);
  return parts.join('');
}
export const pngDataUrl = (png: Uint8Array): string => 'data:image/png;base64,' + toBase64(png);

// ---------- Terrain raster ----------
function hash2(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface RasterResult { png: Uint8Array; w: number; h: number; /** Raw 8-bit RGB pixels (w*h*3), used by the canvas renderer. */ rgb?: Uint8Array }
export interface TerrainPixels { w: number; h: number; rgb: Uint8Array }

/** Hillshaded, hypsometric-tinted land image covering the whole map. */
export function renderTerrainPixels(world: World, pal: Palette): TerrainPixels {
  const hg = world.terrain.height;
  const n = hg.w;
  const up = pal.hatch > 0 ? Math.min(4, 1700 / n) : n >= 400 ? 1.5 : 2;
  const W = Math.round(n * up);
  const H = W;
  const hs = new Float32Array(W * H);
  const wt = world.terrain;
  let landMax = 1;
  {
    const vals: number[] = [];
    for (let i = 0; i < hg.data.length; i += 7) if (wt.water[i] !== 1) vals.push(hg.data[i]);
    vals.sort((a, b) => a - b);
    landMax = vals.length ? Math.max(1, vals[Math.floor(vals.length * 0.99)]) : 1;
  }
  for (let y = 0; y < H; y++) {
    const fy = Math.min(n - 1.0001, Math.max(0, (y + 0.5) / up - 0.5));
    const y0 = Math.floor(fy), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(n - 1.0001, Math.max(0, (x + 0.5) / up - 0.5));
      const x0 = Math.floor(fx), tx = fx - x0;
      const a = hg.data[y0 * n + x0], b = hg.data[y0 * n + x0 + 1], c = hg.data[(y0 + 1) * n + x0], d = hg.data[(y0 + 1) * n + x0 + 1];
      hs[y * W + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  const pxM = world.mapSize / W;
  const slopes: number[] = [];
  for (let y = 1; y < H - 1; y += 3) for (let x = 1; x < W - 1; x += 3) {
    if (hs[y * W + x] <= 0) continue;
    const gx = (hs[y * W + x + 1] - hs[y * W + x - 1]) / (2 * pxM), gy = (hs[(y + 1) * W + x] - hs[(y - 1) * W + x]) / (2 * pxM);
    slopes.push(Math.hypot(gx, gy));
  }
  slopes.sort((a, b) => a - b);
  const p90 = slopes[Math.floor(slopes.length * 0.9)] || 0.01;
  const exag = Math.max(1.2, Math.min(6, 0.3 / p90));

  const stops = pal.hypso.map(([t, hex]) => ({ t, c: hexToRgb(hex) }));
  const colorAt = (t: number): [number, number, number] => {
    if (t <= stops[0].t) return stops[0].c;
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i].t) {
        const a = stops[i - 1], b = stops[i];
        const u = (t - a.t) / (b.t - a.t);
        return [a.c[0] + (b.c[0] - a.c[0]) * u, a.c[1] + (b.c[1] - a.c[1]) * u, a.c[2] + (b.c[2] - a.c[2]) * u];
      }
    }
    return stops[stops.length - 1].c;
  };
  const paper = hexToRgb(pal.paper);
  const inkRgb = hexToRgb(pal.ink);
  const HP = 6; // hatch period in raster px
  const out = new Uint8Array(W * H * 3);
  const L = { x: -0.5, y: -0.5, z: 0.7071 };
  const L2 = { x: 0.2, y: -0.75, z: 0.63 };
  const flat = 0.7071;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const hv = hs[i];
      const o = i * 3;
      if (hv <= 0) { out[o] = paper[0]; out[o + 1] = paper[1]; out[o + 2] = paper[2]; continue; }
      const xl = x > 0 ? x - 1 : x, xr = x < W - 1 ? x + 1 : x, yu = y > 0 ? y - 1 : y, yd = y < H - 1 ? y + 1 : y;
      const gx = ((hs[y * W + xr] - hs[y * W + xl]) / ((xr - xl) * pxM)) * exag;
      const gy = ((hs[yd * W + x] - hs[yu * W + x]) / ((yd - yu) * pxM)) * exag;
      const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
      const nx = -gx * inv, ny = -gy * inv, nz = inv;
      const s1 = nx * L.x + ny * L.y + nz * L.z;
      const s2 = nx * L2.x + ny * L2.y + nz * L2.z;
      const sh = 0.75 * s1 + 0.25 * s2;
      const dd = sh - flat;
      let f = 1 + pal.shade * (dd > 0 ? 1.0 : 0.8) * dd * 1.15;
      f = f < 0.58 ? 0.58 : f > 1.25 ? 1.25 : f;
      const t = Math.min(1, hv / landMax);
      const c = colorAt(Math.pow(t, 0.85));
      const g = pal.grain ? 1 + (hash2(x, y) - 0.5) * 2 * pal.grain : 1;
      let k = f * g;
      let a = 0;
      if (pal.hatch > 0) {
        // engraved look: the flat tone barely follows the light, the shadow side is hatched (cross-hatched when deep)
        k = 1 + (f - 1) * 0.3;
        const dn = Math.max(0, 1 - f) / 0.2;
        if (dn > 0.22) {
          const th = 0.8 + Math.min(1, dn) * 1.9;
          if (((x + y) % HP) < th) a = Math.min(1, (dn - 0.22) * 2.2);
          if (dn > 0.8 && ((((x - y) % HP) + HP) % HP) < th * 0.8) a = Math.max(a, Math.min(1, (dn - 0.8) * 3));
        }
        a *= pal.hatch * 0.85;
        k *= g;
      }
      out[o] = Math.max(0, Math.min(255, (c[0] * k) * (1 - a) + inkRgb[0] * a));
      out[o + 1] = Math.max(0, Math.min(255, (c[1] * k) * (1 - a) + inkRgb[1] * a));
      out[o + 2] = Math.max(0, Math.min(255, (c[2] * k) * (1 - a) + inkRgb[2] * a));
    }
  }
  return { w: W, h: H, rgb: out };
}

/** Export encoding is deliberately separate from the interactive pixel path. */
export function renderTerrainRaster(world: World, pal: Palette): RasterResult {
  const pixels = renderTerrainPixels(world, pal);
  return { ...pixels, png: encodePng(pixels.rgb, pixels.w, pixels.h, 3) };
}
