import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { sampleGrid } from '../src/gen/core/grid';
import type { Polygon } from '../src/gen/core/geom';
import type { UrbanCtx } from '../src/gen/urban/context';
import { finishEdgeRoofs, roofEnvelope, type EdgeRoofPartition } from '../src/gen/urban/edgeRoofs';
import { Streets, LAB_OPEN, LAB_WALL } from '../src/gen/urban/streets';
import { blockReach, makeStreetAt } from '../src/gen/urban/access';
import { area, bboxOf, isSimple, obb } from '../src/gen/geo/poly';
import { tryDifference, tryIntersection, mpArea, type MultiPoly } from '../src/gen/geo/bool';

// Exact complete open42 state captured at the original finisher's RETURN, including all obstacles.
// This post-pass transaction witness is not an initial pipeline input or a whole-generation proof.
// Uncompressed archival SHA256: 199190932740a0bf761871abaf6db8f8fa0f00df59aefaa51eab97795a98c493.
const raw = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/edge-roof-open42-finish.json.gz', import.meta.url))).toString());
const OWNER = 428, DONOR = 426, ROOF = 798, COUPLED = 790, BLOCK = 47, QUARTER = 8;
function fixture(): EdgeRoofPartition {
  const data = structuredClone(raw), ctx = data.ctx;
  const slope = { ...ctx.slope, data: Float32Array.from(ctx.slope.data) };
  const idx = (p: { x: number; y: number }) => Math.min(ctx.n - 1, Math.max(0, Math.floor(p.y / ctx.cell))) * ctx.n
    + Math.min(ctx.n - 1, Math.max(0, Math.floor(p.x / ctx.cell)));
  const streets = new Streets(); streets.list = data.streets;
  return { ...data, streets, allowGrowth: true,
    eligible: (parcel) => (parcel === OWNER || parcel === DONOR) && data.eligible[parcel],
    ctx: { ...ctx, isWater: (p) => ctx.waterMask[idx(p)] !== 0,
      slopeAt: (p) => sampleGrid(slope, p.x, p.y) } as UrbanCtx };
}
const pieces = (poly: Polygon): MultiPoly => [{ outer: poly, holes: [] }];
const assertEqualLand = (actual: MultiPoly, expected: MultiPoly) => {
  const lost = tryDifference(expected, actual), added = tryDifference(actual, expected);
  expect(lost.failed || added.failed).toBe(false);
  expect(mpArea(lost.pieces)).toBeLessThanOrEqual(1e-6);
  expect(mpArea(added.pieces)).toBeLessThanOrEqual(1e-6);
};
const reach = (input: EdgeRoofPartition) => {
  const peers = input.buildings.filter((b) => b.parcel !== undefined && input.parcels[b.parcel].block === BLOCK);
  const streetAt = makeStreetAt(input.streets.list.filter((s) => s.ribbon).map((s) => ({ path: s.path, widths: s.widths, width: s.widths[0] })),
    input.parcels.filter((p) => ['place', 'market', 'quay', 'green'].includes(String(p.use))).map((p) => p.poly));
  return blockReach(input.blocks[BLOCK].poly, peers.map((b) => b.poly), streetAt);
};

// Keep the complete actual block/owners/peer roofs, in a small surrounding quarter with a distant
// independent clipped dwelling. Its ordinary V4 growth must replace quarter.lp before roof 798's
// unresolved transaction. The full untouched archival post-pass scene remains the primary regression.
function earlierGrowthFixture(closed = false, targetEligible = true) {
  const scene = fixture(), quarter = structuredClone(scene.quarters[QUARTER]);
  const parcelIds = scene.parcels.flatMap((p, i) => p.block === BLOCK ? [i] : []);
  const localParcel = new Map(parcelIds.map((id, i) => [id, i]));
  const target = scene.buildings[ROOF];
  const buildings = scene.buildings.filter((b) => b.parcel !== undefined && localParcel.has(b.parcel))
    .map((b) => ({ ...b, parcel: localParcel.get(b.parcel!)! }));
  const targetIndex = 1 + buildings.findIndex((b) => b.poly === target.poly);
  const parcels = parcelIds.map((id) => ({ ...scene.parcels[id], block: 0 }));
  quarter.lp = { pts: [{ x: 1000, y: 1053 }, { x: 1100, y: 1049.06 },
    { x: 1199.58, y: 1159.29 }, { x: 1220.17, y: 1171.06 },
    { x: 1300, y: 1250 }, { x: 1000, y: 1250 }], lab: Array(6).fill(LAB_OPEN) };
  if (closed) {
    // Preserve the full old roof's OPEN cut contact, but make a second actual edge of the proposed
    // exterior addition a WALL. An open-contact-only guard would incorrectly authorize this roof.
    quarter.lp.pts.splice(3, 0, structuredClone(target.poly[1]), { x: 1209, y: 1164 });
    quarter.lp.lab.splice(3, 0, LAB_WALL, LAB_OPEN);
  }
  const top = (x: number) => 1053 + (x - 1000) * (1049.06 - 1053) / 100;
  const plot = [{ x: 1080, y: top(1080) }, { x: 1090, y: top(1090) },
    { x: 1090, y: 1080 }, { x: 1080, y: 1080 }];
  const early = { ...structuredClone(target), parcel: parcels.length, kind: 'house',
    poly: [plot[0], plot[1], { x: 1090, y: 1060 }, { x: 1080, y: 1060 }] };
  parcels.push({ ...structuredClone(scene.parcels[OWNER]), block: 1, poly: plot,
    front: [{ x: 1090, y: 1080 }, { x: 1080, y: 1080 }] });
  scene.streets.add([{ x: 1070, y: 1083 }, { x: 1100, y: 1083 }], 6, 1, 'radial', 2);
  const input: EdgeRoofPartition = { ...scene, quarters: [quarter],
    blocks: [{ ...scene.blocks[BLOCK], quarter: 0 }, { poly: plot, quarter: 0 }],
    parcels, buildings: [early, ...buildings], gardens: [], streetSpace: [[]], footprint: pieces(quarter.lp.pts),
    phases: [{ id: 2, region: pieces(quarter.lp.pts), band: pieces(quarter.lp.pts) }],
    protectedLand: pieces([{ x: 1070, y: 1080 }, { x: 1100, y: 1080 }, { x: 1100, y: 1086 }, { x: 1070, y: 1086 }]),
    ctx: { ...scene.ctx, water: [], isWater: () => false, slopeAt: () => 0.03 },
    eligible: (id) => id === early.parcel || (targetEligible && (id === localParcel.get(OWNER) || id === localParcel.get(DONOR))) };
  return { input, targetIndex };
}
const partitionState = (input: EdgeRoofPartition) => JSON.stringify([input.buildings, input.parcels,
  input.blocks, input.quarters, input.footprint, input.phases, input.streetSpace, input.gardens]);

function soloFixture(index: number) {
  const input = fixture(), owner = input.buildings[index].parcel!;
  input.eligible = (pi) => pi === owner && raw.eligible[pi];
  return { input, owner, block: input.parcels[owner].block };
}
function assertSoloExterior(index: number) {
  const { input, owner, block } = soloFixture(index), quarter = input.blocks[block].quarter;
  const before = structuredClone({ buildings: input.buildings, parcels: input.parcels, blocks: input.blocks,
    quarters: input.quarters, footprint: input.footprint, phases: input.phases, gardens: input.gardens,
    streetSpace: input.streetSpace, water: input.ctx.water, protectedLand: input.protectedLand });
  const result = finishEdgeRoofs(input), roof = input.buildings[index].poly;
  expect(result.grown).toBe(1); expect(result.fitted).toBe(0);
  expect(roof).toHaveLength(4); expect(isSimple(roof)).toBe(true);
  const sides = roof.map((a, i) => Math.hypot(a.x - roof[(i + 1) % 4].x, a.y - roof[(i + 1) % 4].y));
  expect(Math.min(...sides)).toBeGreaterThanOrEqual(4.5);
  expect(Math.max(...sides) / Math.min(...sides)).toBeLessThanOrEqual(3);
  expect(area(roof)).toBeLessThanOrEqual(2 * area(before.buildings[index].poly));
  const lostRoof = tryDifference(before.buildings[index].poly, roof);
  expect(lostRoof.failed).toBe(false); expect(mpArea(lostRoof.pieces)).toBeLessThanOrEqual(1e-6);
  expect(input.buildings).toHaveLength(before.buildings.length); expect(input.parcels).toHaveLength(before.parcels.length);
  input.buildings.forEach((b, i) => {
    const { poly: _p, ...metadata } = b, { poly: _q, ...old } = before.buildings[i];
    expect(metadata).toEqual(old); if (i !== index) expect(b.poly).toEqual(before.buildings[i].poly);
  });
  input.parcels.forEach((p, i) => {
    const { poly: _p, ...metadata } = p, { poly: _q, ...old } = before.parcels[i];
    expect(metadata).toEqual(old); if (i !== owner) expect(p.poly).toEqual(before.parcels[i].poly);
  });
  for (const [actual, old] of [[pieces(input.parcels[owner].poly), pieces(before.parcels[owner].poly)],
    [pieces(input.blocks[block].poly), pieces(before.blocks[block].poly)],
    [pieces(input.quarters[quarter].lp.pts), pieces(before.quarters[quarter].lp.pts)],
    [input.footprint, before.footprint]] as [MultiPoly, MultiPoly][]) assertEqualLand(actual, [...old, ...pieces(roof)]);
  input.phases!.forEach((phase, i) => {
    const old = before.phases![i], ownPhase = input.quarters[quarter].phase;
    assertEqualLand(phase.region, phase.id >= ownPhase ? [...old.region, ...pieces(roof)] : old.region);
    assertEqualLand(phase.band, phase.id === ownPhase ? [...old.band, ...pieces(roof)] : old.band);
  });
  const roofOutsideOwner = tryDifference(roof, input.parcels[owner].poly);
  const peerHit = tryIntersection(roof, input.buildings.filter((_, i) => i !== index).flatMap((b) => pieces(b.poly)));
  expect(roofOutsideOwner.failed || peerHit.failed).toBe(false);
  expect(mpArea(roofOutsideOwner.pieces)).toBeLessThanOrEqual(1e-6);
  expect(mpArea(peerHit.pieces)).toBeLessThanOrEqual(1e-6);
  for (const obstacle of [input.protectedLand, input.ctx.water]) {
    const hit = tryIntersection(roof, obstacle); expect(hit.failed).toBe(false);
    expect(mpArea(hit.pieces)).toBeLessThanOrEqual(1e-6);
  }
  const gardens = tryDifference(before.gardens.flatMap(pieces), roof);
  expect(gardens.failed).toBe(false); assertEqualLand(input.gardens.flatMap(pieces), gardens.pieces);
  const peerOwners = input.parcels.filter((_, i) => i !== owner).flatMap((p) => pieces(p.poly));
  const oldOwnerHit = tryIntersection(before.parcels[owner].poly, peerOwners), newOwnerHit = tryIntersection(input.parcels[owner].poly, peerOwners);
  const introduced = tryDifference(newOwnerHit.pieces, oldOwnerHit.pieces);
  expect(oldOwnerHit.failed || newOwnerHit.failed || introduced.failed).toBe(false);
  expect(mpArea(introduced.pieces)).toBeLessThanOrEqual(1e-6);
  const peers = input.buildings.flatMap((b, i) => b.parcel !== undefined && input.parcels[b.parcel].block === block ? [i] : []);
  const streetAt = makeStreetAt(input.streets.list.filter((s) => s.ribbon).map((s) => ({ path: s.path, widths: s.widths, width: s.widths[0] })),
    input.parcels.filter((p) => ['place', 'market', 'quay', 'green'].includes(String(p.use))).map((p) => p.poly));
  const beforeReach = blockReach(before.blocks[block].poly, peers.map((i) => before.buildings[i].poly), streetAt);
  const afterReach = blockReach(input.blocks[block].poly, peers.map((i) => input.buildings[i].poly), streetAt);
  expect(afterReach.every((v, j) => v || (!beforeReach[j] && peers[j] !== index))).toBe(true);
  return { input, before, roof };
}

describe('whole exterior roofs on their other actual side', () => {
  it('repairs actual post-pass426 on its third side without borrowing a neighbour plot', () => {
    const { roof } = assertSoloExterior(426);
    expect(area(roof)).toBeGreaterThan(60);
  });
  it('repairs actual post-pass823 with a strictly under-cap third-side envelope beyond its tiny fixed lot', () => {
    const old = raw.buildings[823].poly as Polygon;
    expect(area(roofEnvelope(old, [old[2], old[0]]))).toBeGreaterThan(2 * area(old));
    const { roof } = assertSoloExterior(823);
    expect(area(roof)).toBeGreaterThan(56);
  });
  it('rejects823 atomically when the actual boundary crossed by its third-side envelope is closed', () => {
    const { input, block } = soloFixture(823), quarter = input.quarters[input.blocks[block].quarter];
    // Actual original quarter9 return boundary crossed by the viable third-side proposal.
    const edge = quarter.lp.pts.findIndex((p) => p.x === 1164.61 && p.y === 1528.51);
    expect(edge).toBeGreaterThanOrEqual(0); quarter.lp.lab[edge] = LAB_WALL;
    const before = partitionState(input), result = finishEdgeRoofs(input);
    expect(result.grown).toBe(0); expect(partitionState(input)).toBe(before);
  });
  it('rejects823 atomically when its third-side exterior envelope occupies protected ground', () => {
    const { input } = soloFixture(823), old = input.buildings[823].poly;
    input.protectedLand.push(...pieces(roofEnvelope(old, [old[2], old[0]])));
    const before = partitionState(input), result = finishEdgeRoofs(input);
    expect(result.grown).toBe(0); expect(partitionState(input)).toBe(before);
  });
  it('keeps the complete original post-pass mask and the existing coupled798 repair while adding426/823', () => {
    const input = fixture(), before = structuredClone(input.buildings);
    input.eligible = (pi) => raw.eligible[pi];
    const result = finishEdgeRoofs(input);
    // New bounded concave-hull proposals may improve other clipped roofs in
    // this complete mask. Preserve the original four witnessed transactions
    // and audit every additional accepted roof instead of freezing their count.
    expect(result.grown).toBeGreaterThanOrEqual(3);
    const changed = input.buildings.flatMap((b, i) => JSON.stringify(b.poly) !== JSON.stringify(before[i].poly) ? [i] : []);
    for (const i of [426, 790, 798, 823]) expect(changed).toContain(i);
    for (const i of changed.filter((i) => ![426, 790, 798, 823].includes(i))) {
      const roof = input.buildings[i], previous = before[i].poly, owner = input.parcels[roof.parcel!];
      const lost = tryDifference(previous, roof.poly), outside = tryDifference(roof.poly, owner.poly);
      expect(lost.failed || outside.failed).toBe(false);
      expect(mpArea(lost.pieces)).toBeLessThanOrEqual(1e-6);
      expect(mpArea(outside.pieces)).toBeLessThanOrEqual(1e-6);
      expect(result.changedBlocks.has(owner.block)).toBe(true);
    }
    for (const i of [426, 798, 823]) expect(input.buildings[i].poly).toHaveLength(4);
    expect(input.buildings[797]).toEqual(before[797]);
    const dx = input.buildings[790].poly[0].x - before[790].poly[0].x;
    const dy = input.buildings[790].poly[0].y - before[790].poly[0].y;
    expect(Math.hypot(dx, dy)).toBeGreaterThan(0); expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(0.001);
    input.buildings.forEach((b, i) => {
      const { poly: _p, ...metadata } = b, { poly: _q, ...old } = before[i]; expect(metadata).toEqual(old);
    });
  });
});

describe('whole exterior roof with an adjacent garden owner', () => {
  it('repairs actual post-pass roof 798 and rigidly shifts donor790 out of the inherited seam in one transaction', () => {
    const input = fixture();
    const before = structuredClone({ buildings: input.buildings, parcels: input.parcels, blocks: input.blocks,
      quarters: input.quarters, footprint: input.footprint, phases: input.phases, streetSpace: input.streetSpace,
      streets: input.streets.list, protectedLand: input.protectedLand, water: input.ctx.water });
    // The observed global-coordinate shoelace ceiling fails by one floating-point area quantum.
    expect(area(roofEnvelope(before.buildings[ROOF].poly, before.parcels[OWNER].front!)))
      .toBeGreaterThan(2 * area(before.buildings[ROOF].poly));
    const beforeReach = reach(input), result = finishEdgeRoofs(input), roof = input.buildings[ROOF].poly;
    expect(result.grown).toBeGreaterThan(0);
    expect(result.changedBlocks.has(BLOCK)).toBe(true);
    expect(roof).toHaveLength(4);
    expect(isSimple(roof)).toBe(true);
    const sides = roof.map((a, i) => Math.hypot(a.x - roof[(i + 1) % 4].x, a.y - roof[(i + 1) % 4].y));
    expect(Math.min(...sides)).toBeGreaterThanOrEqual(4.5);
    expect(Math.max(...sides) / Math.min(...sides)).toBeLessThanOrEqual(3);
    expect(area(roof)).toBeCloseTo(32.9282808244, 6);
    expect(area(roof)).toBeLessThanOrEqual(2 * area(before.buildings[ROOF].poly));
    expect(input.buildings).toHaveLength(before.buildings.length);
    expect(input.parcels).toHaveLength(before.parcels.length);
    input.buildings.forEach((b, i) => {
      const { poly: _poly, ...metadata } = b, { poly: _old, ...oldMetadata } = before.buildings[i];
      expect(metadata).toEqual(oldMetadata);
      if (i !== ROOF && i !== COUPLED) expect(b.poly).toEqual(before.buildings[i].poly);
    });
    const shifted = input.buildings[COUPLED].poly, oldPeer = before.buildings[COUPLED].poly;
    const dx = shifted[0].x - oldPeer[0].x, dy = shifted[0].y - oldPeer[0].y;
    expect(Math.hypot(dx, dy)).toBeGreaterThan(0); expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(0.001);
    expect(shifted).toHaveLength(oldPeer.length); expect(area(shifted)).toBeCloseTo(area(oldPeer), 6);
    shifted.forEach((p, i) => {
      expect(p.x - oldPeer[i].x).toBeCloseTo(dx, 10); expect(p.y - oldPeer[i].y).toBeCloseTo(dy, 10);
      const j = (i + 1) % shifted.length;
      expect(Math.hypot(p.x - shifted[j].x, p.y - shifted[j].y))
        .toBeCloseTo(Math.hypot(oldPeer[i].x - oldPeer[j].x, oldPeer[i].y - oldPeer[j].y), 8);
    });
    // The neighbouring owner797 keeps its complete eight-vertex shape; the overlap is physically
    // removed by translation, rather than reassigned to a parcel beneath the other unchanged roof.
    expect(input.buildings[797].poly).toEqual(before.buildings[797].poly);
    const seam = tryIntersection(shifted, input.buildings[797].poly);
    expect(seam.failed).toBe(false); expect(mpArea(seam.pieces)).toBeLessThanOrEqual(1e-6);
    input.parcels.forEach((p, i) => {
      const { poly: _poly, ...metadata } = p, { poly: _old, ...oldMetadata } = before.parcels[i];
      expect(metadata).toEqual(oldMetadata);
      if (i !== OWNER && i !== DONOR) expect(p.poly).toEqual(before.parcels[i].poly);
    });
    const oldOwners = [OWNER, DONOR].flatMap((i) => pieces(before.parcels[i].poly));
    const newOwners = [OWNER, DONOR].flatMap((i) => pieces(input.parcels[i].poly));
    assertEqualLand(newOwners, [...oldOwners, ...pieces(roof)]);
    const overlap = tryIntersection(input.parcels[OWNER].poly, input.parcels[DONOR].poly);
    expect(overlap.failed).toBe(false); expect(mpArea(overlap.pieces)).toBeLessThanOrEqual(1e-6);
    for (const i of [OWNER, DONOR]) {
      expect(isSimple(input.parcels[i].poly)).toBe(true);
      expect(area(input.parcels[i].poly)).toBeGreaterThanOrEqual(20.25);
      for (const b of input.buildings.filter((b) => b.parcel === i)) {
        const lost = tryDifference(b.poly, input.parcels[i].poly);
        expect(lost.failed).toBe(false); expect(mpArea(lost.pieces)).toBeLessThanOrEqual(1e-6);
      }
    }
    input.blocks.forEach((b, i) => { if (i !== BLOCK) expect(b).toEqual(before.blocks[i]); });
    input.quarters.forEach((q, i) => { if (i !== QUARTER) expect(q).toEqual(before.quarters[i]); });
    assertEqualLand(pieces(input.blocks[BLOCK].poly), [...pieces(before.blocks[BLOCK].poly), ...pieces(roof)]);
    assertEqualLand(pieces(input.quarters[QUARTER].lp.pts), [...pieces(before.quarters[QUARTER].lp.pts), ...pieces(roof)]);
    assertEqualLand(input.footprint, [...before.footprint, ...pieces(roof)]);
    input.phases!.forEach((p, i) => {
      const old = before.phases![i];
      assertEqualLand(p.region, p.id >= input.quarters[QUARTER].phase ? [...old.region, ...pieces(roof)] : old.region);
      assertEqualLand(p.band, p.id === input.quarters[QUARTER].phase ? [...old.band, ...pieces(roof)] : old.band);
    });
    expect(input.streets.list).toEqual(before.streets);
    expect(input.protectedLand).toEqual(before.protectedLand); expect(input.ctx.water).toEqual(before.water);
    for (const index of [ROOF, COUPLED]) {
      const added = tryDifference(input.buildings[index].poly, before.buildings[index].poly);
      expect(added.failed).toBe(false);
      for (const obstacles of [before.protectedLand, before.water]) {
        const hit = tryIntersection(added.pieces, obstacles);
        expect(hit.failed).toBe(false); expect(mpArea(hit.pieces)).toBeLessThanOrEqual(1e-6);
      }
      const others = input.buildings.filter((_, i) => i !== index).flatMap((b) => pieces(b.poly));
      const peers = tryIntersection(input.buildings[index].poly, others);
      expect(peers.failed).toBe(false); expect(mpArea(peers.pieces)).toBeLessThanOrEqual(1e-6);
      const gardenHit = tryIntersection(input.buildings[index].poly, input.gardens.flatMap(pieces));
      expect(gardenHit.failed).toBe(false); expect(mpArea(gardenHit.pieces)).toBeLessThanOrEqual(1e-6);
    }
    const freed = tryDifference(oldPeer, shifted), uncovered = tryDifference(freed.pieces,
      input.gardens.flatMap(pieces), input.buildings.flatMap((b) => pieces(b.poly)));
    expect(freed.failed || uncovered.failed).toBe(false);
    expect(mpArea(uncovered.pieces)).toBeLessThanOrEqual(1e-6);
    expect(reach(input).every((v, i) => v || !beforeReach[i])).toBe(true);
    expect(beforeReach.every(Boolean)).toBe(true);
    expect(reach(input).every(Boolean)).toBe(true);
  }, 120000);

  it('does not allow the exterior transaction when growth is disabled or the real boundary is a standing wall', () => {
    for (const wall of [false, true]) {
      const input = fixture();
      if (wall) input.quarters.forEach((q) => { q.lp.lab = q.lp.lab.map((lab) => lab === LAB_OPEN ? LAB_WALL : lab); });
      else input.allowGrowth = false;
      const before = JSON.stringify([input.buildings, input.parcels, input.blocks, input.quarters, input.footprint, input.phases]);
      finishEdgeRoofs(input);
      expect(JSON.stringify([input.buildings, input.parcels, input.blocks, input.quarters, input.footprint, input.phases])).toBe(before);
    }
  }, 120000);

  it('rejects occupied physical land without publishing a partial ownership update', () => {
    const input = fixture(), roof = roofEnvelope(input.buildings[ROOF].poly, input.parcels[OWNER].front!);
    input.protectedLand.push(...pieces(roof));
    const before = JSON.stringify([input.buildings, input.parcels, input.blocks, input.quarters, input.footprint, input.phases, input.gardens]);
    finishEdgeRoofs(input);
    expect(JSON.stringify([input.buildings, input.parcels, input.blocks, input.quarters, input.footprint, input.phases, input.gardens])).toBe(before);
  }, 120000);

  it('uses the current labelled quarter after an earlier ordinary roof grows its boundary', () => {
    const { input, targetIndex } = earlierGrowthFixture(), oldQuarter = structuredClone(input.quarters[0].lp);
    const oldEarly = structuredClone(input.buildings[0].poly), oldTarget = structuredClone(input.buildings[targetIndex].poly);
    const expectedEarly = roofEnvelope(oldEarly, input.parcels[input.buildings[0].parcel!].front!);
    const result = finishEdgeRoofs(input);
    expect(result.grown).toBe(2);
    expect(input.buildings[0].poly).toEqual(expectedEarly);
    expect(input.quarters[0].lp).not.toEqual(oldQuarter);
    expect(input.buildings[targetIndex].poly).toHaveLength(4);
    assertEqualLand(pieces(input.quarters[0].lp.pts), [...pieces(oldQuarter.pts),
      ...pieces(expectedEarly), ...pieces(input.buildings[targetIndex].poly)]);
    const lost = tryDifference(oldTarget, input.buildings[targetIndex].poly);
    expect(lost.failed).toBe(false); expect(mpArea(lost.pieces)).toBeLessThanOrEqual(1e-6);
    expect(input.quarters[0].lp.lab).toHaveLength(input.quarters[0].lp.pts.length);
    expect(input.quarters[0].lp.lab.every((lab) => lab === LAB_OPEN)).toBe(true);
  }, 120000);

  it('keeps earlier growth but atomically refuses a later envelope crossing a current closed edge despite its open contact', () => {
    const { input, targetIndex } = earlierGrowthFixture(true), control = earlierGrowthFixture(true, false).input;
    const oldTarget = structuredClone(input.buildings[targetIndex].poly), oldEarly = structuredClone(input.buildings[0].poly);
    const controlResult = finishEdgeRoofs(control), result = finishEdgeRoofs(input);
    expect(controlResult.grown).toBe(1); expect(result.grown).toBe(1);
    expect(input.buildings[0].poly).not.toEqual(oldEarly);
    expect(input.buildings[targetIndex].poly).toEqual(oldTarget);
    expect(input.quarters[0].lp.lab).toContain(LAB_WALL);
    expect(partitionState(input)).toBe(partitionState(control));
  }, 120000);

  it('refuses a conflicting phase band without publishing any part of the exterior transaction', () => {
    const input = fixture(), oldRoof = input.buildings[ROOF].poly, frame = obb(oldRoof);
    const envelopes = [roofEnvelope(oldRoof, input.parcels[OWNER].front!),
      roofEnvelope(oldRoof, [frame.c, { x: frame.c.x + frame.u.x, y: frame.c.y + frame.u.y }])];
    const extras = envelopes.map((roof) => tryDifference(roof, input.quarters[QUARTER].lp.pts));
    for (const extra of extras) {
      expect(extra.failed).toBe(false); expect(mpArea(extra.pieces)).toBeGreaterThan(1e-6);
    }
    const band = extras.flatMap((extra) => extra.pieces);
    input.phases!.push({ id: 3, region: band, band });
    const before = partitionState(input), result = finishEdgeRoofs(input);
    expect(result.grown).toBe(0); expect(result.fitted).toBe(0);
    expect(partitionState(input)).toBe(before);
  }, 120000);

  it('refuses the complete coupled transaction when all neighbour translations occupy protected land', () => {
    const input = fixture(), old = input.buildings[COUPLED].poly, bounds = bboxOf(old);
    const outer = [{ x: bounds.x0 - 0.01, y: bounds.y0 - 0.01 }, { x: bounds.x1 + 0.01, y: bounds.y0 - 0.01 },
      { x: bounds.x1 + 0.01, y: bounds.y1 + 0.01 }, { x: bounds.x0 - 0.01, y: bounds.y1 + 0.01 }];
    const ring = tryDifference(outer, old);
    expect(ring.failed).toBe(false); input.protectedLand.push(...ring.pieces);
    const before = partitionState(input), result = finishEdgeRoofs(input);
    expect(result.grown).toBe(0); expect(result.fitted).toBe(0);
    expect(partitionState(input)).toBe(before);
  }, 120000);
});
