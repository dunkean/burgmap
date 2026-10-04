/** Native civic programmes retained when a village becomes one served town. */
import type { Polygon, Polyline } from '../core/geom';
import type { UrbanLine, UrbanParcel, UrbanBuilding, UrbanTree } from '../types';
import { area, inscribed, pointInRing, distToRing } from '../geo/poly';
import { disk } from '../geo/offset';
import { registerBuilders, type CompoundCtx, type CompoundOut } from './compounds';
import { openRing, hut, fitIn, rect } from './camps/kit';
import { bestRect } from './persian';

const empty = (lot: Polygon, use: string): CompoundOut => ({ parcels: [{ poly: lot, use }], buildings: [], lines: [], water: [], landmarks: [] });

/** The central livestock enclosure remains useful open ground, with a gate and grain pits beside it. */
function cattleKraal(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = empty(lot, 'compound:cattle-kraal'), ins = inscribed(lot, [], 0.5), r = ins.r - 2;
  if (r < 5) return out;
  const fence = disk(ins.c, r, 48), gate = { x: ins.c.x + Math.cos(cx.angle) * r, y: ins.c.y + Math.sin(cx.angle) * r };
  for (const path of openRing(fence, [{ p: gate, width: 3.5 }])) out.lines.push({ kind: 'kraal-fence', path, width: 1.1 });
  const pr = cx.rng.fork('grain-pits');
  for (let i = 0; i < 3; i++) {
    const a = cx.angle + pr.range(-0.5, 0.5), d = r * pr.range(0.45, 0.7), c = { x: ins.c.x + Math.cos(a) * d, y: ins.c.y + Math.sin(a) * d };
    const p = fitIn(lot, (q, s) => hut(q, 1.15 * s, 8), out.buildings.map((b) => b.poly), { margin: 2, gap: 1.2, minScale: 0.95, cands: [c] });
    if (p) out.buildings.push({ poly: p, kind: 'pit', parcel: 0, arch: 'grain-pit', roof: 'none', material: 'earth', storeys: 0 });
  }
  out.landmarks.push({ kind: 'cattle-kraal', poly: fence });
  return out;
}

/** A chief's hall and the gathering yard before it; the existing town paths serve the whole claimed lot. */
function chiefHall(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = empty(lot, 'compound:chieftain-hall');
  const f = bestRect(lot, cx.angle, 17, 6, 1.5);
  if (!f || f.hu < 7 || f.hv < 3) return out;
  out.buildings.push({ poly: f.r, kind: 'landmark', parcel: 0, arch: 'chieftain-hall', roof: 'gable', material: 'timber', storeys: 1, orientation: cx.angle });
  out.landmarks.push({ kind: 'chieftain-hall', poly: f.r });
  const store = fitIn(lot, (c, s) => rect(c, cx.angle, 6 * s, 5 * s), [f.r], { margin: 1, gap: 2, minScale: 0.9, nc: 24 });
  if (store) out.buildings.push({ poly: store, kind: 'shed', parcel: 0, arch: 'raised-granary', roof: 'gable', material: 'timber', storeys: 1 });
  return out;
}

/** Public plaza with a genuine great kiva and smaller chambers, leaving circulation round each one. */
function kivaPlaza(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = empty(lot, 'place'), ins = inscribed(lot, [], 0.5);
  const radius = Math.min(12, ins.r * 0.55);
  if (radius < 4) return out;
  const great = hut(ins.c, radius, 32);
  out.buildings.push({ poly: great, kind: 'landmark', parcel: 0, arch: 'great-kiva', roof: 'flat', material: 'stone', storeys: 1 });
  out.landmarks.push({ kind: 'great-kiva', poly: great });
  for (let i = 0; i < 2; i++) {
    const kiva = fitIn(lot, (c, s) => hut(c, 3.5 * s, 20), out.buildings.map((b) => b.poly), { margin: 1.5, gap: 2.5, minScale: 0.8, nc: 24 });
    if (kiva) out.buildings.push({ poly: kiva, kind: 'landmark', parcel: 0, arch: 'kiva', roof: 'flat', material: 'stone', storeys: 1 });
  }
  // The recessed bench ring is an architectural line inside the great chamber, not an extra building.
  const bench = hut(ins.c, radius * 0.82, 32);
  out.lines.push({ kind: 'pyramid-step', path: bench.concat([bench[0]]), width: 0.4 });
  void cx;
  return out;
}

export function registerPrimitiveFeatures(): void {
  registerBuilders({ 'cattle-kraal': cattleKraal, 'chieftain-hall': chiefHall, 'kiva-plaza': kivaPlaza });
}

/** Banks and their timber/thorn faces follow the actual dry enclosure pieces and retain every gate opening. */
export function primitiveBoundaryLines(culture: string, path: Polyline): UrbanLine[] {
  const bank = ['norse-ringfort', 'barbarian-celtic', 'celtic-oppidum'].includes(culture);
  return [ ...(bank ? [{ kind: 'rampart', path, width: culture === 'norse-ringfort' ? 13 : 7 }] : []),
    { kind: culture === 'kraal' ? 'thorn-fence' : 'palisade', path, width: culture === 'kraal' ? 2.2 : 1.2 } ];
}

/** Native gardens retain living hedges with gates at their real plot frontage, rather than sealed lot lines. */
export function primitiveGardenLines(culture: string, parcels: UrbanParcel[]): UrbanLine[] {
  const out: UrbanLine[] = [];
  if (culture !== 'halfling' && culture !== 'barbarian') return out;
  const drawn = new Set<string>();
  const key = (p: { x: number; y: number }) => p.x.toFixed(3) + ',' + p.y.toFixed(3);
  const kind = culture === 'halfling' ? 'garden-hedge' : 'yard-fence', width = culture === 'halfling' ? 1.2 : 0.45;
  for (const p of parcels) {
    if (p.use !== 'plot' || !p.front || area(p.poly) < 40) continue;
    const gate = { x: (p.front[0].x + p.front[1].x) / 2, y: (p.front[0].y + p.front[1].y) / 2 };
    for (const path of openRing(p.poly, [{ p: gate, width: 3.2 }])) {
      let run: Polyline = [];
      for (let i = 1; i < path.length; i++) {
        const a = key(path[i - 1]), b = key(path[i]), segment = a < b ? a + ':' + b : b + ':' + a;
        if (drawn.has(segment)) { if (run.length > 1) out.push({ kind, path: run, width }); run = []; }
        else { if (!run.length) run.push(path[i - 1]); run.push(path[i]); drawn.add(segment); }
      }
      if (run.length > 1) out.push({ kind, path: run, width });
    }
  }
  return out;
}

/** Fruit and party trees in the actual garden gaps, with their canopy wholly inside the lot and off roofs. */
export function halflingGardenTrees(parcels: UrbanParcel[], buildings: UrbanBuilding[]): UrbanTree[] {
  const out: UrbanTree[] = [];
  const homes = new Map<number, Polygon[]>();
  for (const b of buildings) if (b.parcel !== undefined) homes.set(b.parcel, [...(homes.get(b.parcel) ?? []), b.poly]);
  parcels.forEach((p, pi) => {
    if (p.use !== 'plot' || !p.front) return;
    const ins = inscribed(p.poly, [], 1), r = 2;
    for (const corner of p.poly) {
      const c = { x: corner.x * 0.65 + ins.c.x * 0.35, y: corner.y * 0.65 + ins.c.y * 0.35 };
      if (!pointInRing(p.poly, c) || distToRing(p.poly, c) < r + 0.2) continue;
      if ((homes.get(pi) ?? []).some((b) => pointInRing(b, c) || distToRing(b, c) < r + 0.5)) continue;
      out.push({ ...c, r });
      break;
    }
  });
  return out;
}
