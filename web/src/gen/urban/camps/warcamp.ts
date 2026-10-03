/**
 * Orcish war camp grown into a town: chaotic sprawl inside rings of sharpened-stake palisades. The camp grew by
 * bursts, each burst walled with a new palisade thrown round it anyhow (lobed, off-centre, never a circle); beyond
 * the last palisade a shanty belt of huts sprawls unfenced along the roads. Inside, yards of every size are packed
 * with huts, long huts, sheds and pits; crooked lanes wander between them and pass the palisades by a few gates
 * only. At the centre: the arena and the warlord's hall on its mound, totems round the open ground.
 *
 * Partition: Voronoi yards (unrelaxed seeds: irregular) clipped to the camp; the lanes are a random spanning tree
 * (with a few loops) of the yard edges; each palisade runs along yard edges — the boundary of the yards inside it —
 * so it never crosses a lot; lanes cross it only at its gates.
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import { Delaunay } from 'd3-delaunay';
import { area, orientPos, pointInRing, inscribed, bboxOf, distToRing } from '../../geo/poly';
import { intersectionS } from '../../geo/bool';
import type { CampCtx } from './index';
import { CampOut, emptyCamp, street, carveBlocks, pathRibbons, cutByCells, FrontIndex, hut, rect, fitIn, hachures, at, snapRing, openRing } from './kit';
import { Noise2D } from '../../core/noise';

interface Edge { a: number; b: number; cells: number[]; inQ: boolean }

export function warCamp(cc: CampCtx, c: Vec2, pop: number, rng: Rng): CampOut {
  const out = emptyCamp();
  const ctx = cc.ctx;
  const sk = Math.sqrt(cc.sprawl);
  // ---- the growth rings: lobed polar outlines round c, each enclosing the last
  // (~230 inhabitants per ha gross; yards of ~30 m holding a knot of huts each)
  const nRings = pop < 500 ? 1 : pop < 6000 ? 2 : 3;
  const belt = pop >= 400;
  const cellA = 850 * cc.sprawl;
  const Rc = Math.min(48, 16 + pop / 130);
  const Rtot = Math.sqrt(((pop / 230) * 1e4 * cc.sprawl) / Math.PI + Rc * Rc);
  const sr = rng.fork('rings');
  const nz = new Noise2D(sr.fork('n'));
  const growDir = cc.main ? cc.roadAngle : sr.range(0, 2 * Math.PI);
  const radii: ((t: number) => number)[] = [];
  const levels = nRings + (belt ? 1 : 0);
  for (let k = 0; k < levels; k++) {
    // (bands of roughly equal area: the burst that built each ring housed a similar host)
    const base = Math.sqrt(Rc * Rc + (Rtot * Rtot - Rc * Rc) * ((k + 1) / levels));
    const ph = sr.range(0, 10), amp = sr.range(0.14, 0.26), lob = sr.int(2, 4), push = sr.range(0.08, 0.22);
    const prev = k ? radii[k - 1] : null;
    radii.push((t: number) => {
      const w = 1 + amp * nz.noise(Math.cos(t) * lob * 0.5 + ph, Math.sin(t) * lob * 0.5 + ph) + push * Math.cos(t - growDir);
      const r = base * w;
      return prev ? Math.max(r, prev(t) + 16 * sk) : Math.max(r, Rc + 14);
    });
  }
  const rOuter = radii[levels - 1];
  const level = (p: Vec2): number => {
    const t = Math.atan2(p.y - c.y, p.x - c.x), d = dist(p, c);
    if (d < Rc) return -1;
    for (let k = 0; k < levels; k++) if (d < radii[k](t)) return k;
    return levels;
  };
  // ---- seeds (jittered, unrelaxed: irregular yards), the centre cell
  const yr = rng.fork('seeds');
  const step = Math.sqrt(cellA);
  const seeds: Vec2[] = [c];
  const span = Rtot * 1.6;
  for (let y = -span; y <= span; y += step) for (let x = -span; x <= span; x += step) {
    const p = { x: c.x + x + yr.range(-0.48, 0.48) * step, y: c.y + y + yr.range(-0.48, 0.48) * step };
    if (dist(p, c) < Rc * 1.05) continue;
    const t = Math.atan2(p.y - c.y, p.x - c.x);
    if (dist(p, c) > rOuter(t) || ctx.isWater(p)) continue;
    if (p.x < 15 || p.y < 15 || p.x > ctx.mapSize - 15 || p.y > ctx.mapSize - 15) continue;
    seeds.push(p);
  }
  // the centre: a ring of seeds round it so the central cell is a round open ground of radius ~Rc
  for (let k = 0; k < 10; k++) seeds.push(at(c, (k / 10) * 2 * Math.PI + 0.3, Rc * 1.7));
  const bb = bboxOf(seeds);
  const box: [number, number, number, number] = [bb.x0 - 80, bb.y0 - 80, bb.x1 + 80, bb.y1 + 80];
  const vor = Delaunay.from(seeds.map((p) => [p.x, p.y] as [number, number])).voronoi(box);
  const mm = (v: number) => Math.round(v * 1000) / 1000;
  const cells: Polygon[] = seeds.map((_, i) => orientPos((vor.cellPolygon(i) ?? []).slice(0, -1).map(([x, y]) => ({ x: mm(x), y: mm(y) }))));
  const lev = seeds.map((p, i) => (i === 0 ? -1 : level(p)));
  // ---- the quarter: the outer outline (the yards are clipped to it by the block cuts)
  const quarter = snapRing(orientPos(Array.from({ length: 120 }, (_, k) => { const t = (k / 120) * 2 * Math.PI; return at(c, t, rOuter(t)); })));
  const keep = cells.map((p, i) => p.length >= 3 && lev[i] < levels && pointInRing(quarter, seeds[i]));
  out.quarters.push(quarter);
  out.outline.push(quarter);
  // ---- the edge graph
  const nodes: Vec2[] = [];
  const nodeKey = new Map<string, number>();
  const nodeOf = (p: Vec2): number => { const k = Math.round(p.x * 100) + ',' + Math.round(p.y * 100); let i = nodeKey.get(k); if (i === undefined) { i = nodes.length; nodes.push(p); nodeKey.set(k, i); } return i; };
  const edges: Edge[] = [];
  const edgeKey = new Map<string, number>();
  cells.forEach((poly, ci) => {
    if (!keep[ci]) return;
    for (let k = 0; k < poly.length; k++) {
      const a = nodeOf(poly[k]), b = nodeOf(poly[(k + 1) % poly.length]);
      if (a === b) continue;
      const key = Math.min(a, b) + ':' + Math.max(a, b);
      const ei = edgeKey.get(key);
      if (ei !== undefined) { edges[ei].cells.push(ci); continue; }
      edgeKey.set(key, edges.length);
      const pa = nodes[a], pb = nodes[b];
      // (an edge at the rim may reach a few metres past the outline: the lane leads out into the fields)
      const near = (q: Vec2) => pointInRing(quarter, q) || distToRing(quarter, q) < 8;
      const mq = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      edges.push({ a, b, cells: [ci], inQ: near(pa) && near(pb) && pointInRing(quarter, mq) && !ctx.isWater(mq) });
    }
  });
  // the level (ring) of each node: the set of the levels of the cells round it
  const nodeLevels: Set<number>[] = nodes.map(() => new Set());
  for (const e of edges) for (const ci of e.cells) { nodeLevels[e.a].add(lev[ci]); nodeLevels[e.b].add(lev[ci]); }
  const onFence = (n: number): number => {
    // the palisade between level k and k + 1 (k < nRings) passes through this node: returns k, else -2
    const ls = [...nodeLevels[n]];
    for (let k = -1; k < nRings; k++) if (ls.some((l) => l <= k) && ls.some((l) => l > k)) return k;
    return -2;
  };
  // gates: per palisade (and round the centre) 2–4 of its edges, spread apart, the first toward the main road; the
  // lane passes the stakes there (the palisade is open over that edge)
  const gr = rng.fork('gates');
  const fenceOf = (e: Edge): number => {
    if (e.cells.length !== 2 || !e.inQ || !e.cells.every((ci) => keep[ci])) return -2;
    const l0 = Math.min(lev[e.cells[0]], lev[e.cells[1]]), l1 = Math.max(lev[e.cells[0]], lev[e.cells[1]]);
    return l1 === l0 + 1 ? l0 : -2;
  };
  const gateEdges = new Set<number>();
  for (let k = 0; k < nRings; k++) {
    const cand = edges.map((_, i) => i).filter((i) => fenceOf(edges[i]) === k && dist(nodes[edges[i].a], nodes[edges[i].b]) > 4);
    if (!cand.length) continue;
    const n = k < 0 ? 3 : gr.int(2, 4);
    const chosen: number[] = [];
    const a0 = growDir + gr.range(-0.5, 0.5);
    const mid = (i: number): Vec2 => ({ x: (nodes[edges[i].a].x + nodes[edges[i].b].x) / 2, y: (nodes[edges[i].a].y + nodes[edges[i].b].y) / 2 });
    for (let j = 0; j < n; j++) {
      const ta = a0 + (j * 2 * Math.PI) / n + gr.range(-0.6, 0.6);
      let best = -1, bs = Infinity;
      for (const i of cand) {
        const m = mid(i);
        const t = Math.atan2(m.y - c.y, m.x - c.x);
        const dd = Math.abs(Math.atan2(Math.sin(t - ta), Math.cos(t - ta)));
        if (dd < bs && chosen.every((o) => dist(mid(o), m) > 25)) { bs = dd; best = i; }
      }
      if (best >= 0) chosen.push(best);
    }
    for (const g of chosen) gateEdges.add(g);
  }
  const gates = new Set<number>();
  for (const ei of gateEdges) { gates.add(edges[ei].a); gates.add(edges[ei].b); }
  // usable lane edges: between two kept cells of the same level (never along a palisade), not through the centre,
  // their nodes off the palisades unless they are gates
  const inside = (e: Edge) => e.inQ && e.cells.length === 2 && e.cells.every((ci) => keep[ci]);
  // (a lane may end against a palisade, from its inner side only: it never crosses it but at a gate)
  const innerOf = (n: number): number => Math.min(...nodeLevels[n]);
  const usable = edges.map((e, i) => gateEdges.has(i) || (inside(e) && lev[e.cells[0]] === lev[e.cells[1]] && lev[e.cells[0]] >= 0 && [e.a, e.b].every((n) => onFence(n) === -2 || gates.has(n) || innerOf(n) === lev[e.cells[0]] || (innerOf(n) < 0 && lev[e.cells[0]] === 0))));
  // ---- lanes: a random spanning tree of the usable edges (Kruskal), a few loops, leaves pruned now and then
  const er = rng.fork('lanes');
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const order = edges.map((_, i) => i).filter((i) => usable[i]).map((i) => ({ i, w: er.float() })).sort((x, y) => x.w - y.w);
  const tree = new Set<number>();
  for (const { i } of order) { const e = edges[i]; const ra = find(e.a), rb = find(e.b); if (ra !== rb) { parent[ra] = rb; tree.add(i); } else if (er.chance(0.12)) tree.add(i); }
  // the bursts of the camp that the gates left apart are joined to the main network by the shortest run of yard
  // edges (a fence edge on the way is a further gate), the largest pieces first
  {
    const iadj: number[][] = nodes.map(() => []);
    edges.forEach((e, i) => { if (inside(e) && !e.cells.some((ci) => lev[ci] < 0)) { iadj[e.a].push(i); iadj[e.b].push(i); } });
    for (let pass = 0; pass < 60; pass++) {
      const size = new Map<number, number>();
      for (const ei of tree) { const r = find(edges[ei].a); size.set(r, (size.get(r) ?? 0) + 1); }
      if (size.size <= 1) break;
      const sorted = [...size].sort((x, y) => y[1] - x[1]);
      const rootC = sorted[0][0];
      const frag = sorted[1][0];
      // BFS from the fragment's nodes to the root component
      const prev = new Int32Array(nodes.length).fill(-2);
      const q: number[] = [];
      for (const ei of tree) for (const n of [edges[ei].a, edges[ei].b]) if (find(n) === frag && prev[n] === -2) { prev[n] = -1; q.push(n); }
      let hit = -1;
      for (let h = 0; h < q.length && hit < 0; h++) {
        const u = q[h];
        for (const ei of iadj[u]) {
          const e = edges[ei], w = e.a === u ? e.b : e.a;
          if (prev[w] !== -2) continue;
          prev[w] = ei;
          if (tree.size && find(w) === rootC && [...tree].some((t) => edges[t].a === w || edges[t].b === w)) { hit = w; break; }
          q.push(w);
        }
      }
      if (hit < 0) {
        // (an isolated piece: dropped)
        for (const ei of [...tree]) if (find(edges[ei].a) === frag) tree.delete(ei);
        parent[frag] = frag;
        continue;
      }
      let u = hit;
      while (prev[u] >= 0) {
        const ei = prev[u];
        const e = edges[ei];
        tree.add(ei);
        if (fenceOf(e) >= -1) gateEdges.add(ei);
        parent[find(e.a)] = find(e.b);
        u = e.a === u ? e.b : e.a;
      }
      parent[find(frag)] = find(rootC);
    }
  }
  // the component through the outermost gates (the camp is entered from outside)
  const comp = new Map<number, number>();
  for (const ei of tree) { const r = find(edges[ei].a); comp.set(r, (comp.get(r) ?? 0) + 1); }
  let root = -1, rn = -1;
  for (const [r, n] of comp) if (n > rn) { rn = n; root = r; }
  for (const ei of [...tree]) if (find(edges[ei].a) !== root) tree.delete(ei);
  // prune some dead-end leaves (alleys stop short)
  for (let pass = 0; pass < 2; pass++) {
    const deg = new Int32Array(nodes.length);
    for (const ei of tree) { deg[edges[ei].a]++; deg[edges[ei].b]++; }
    for (const ei of [...tree]) { const e = edges[ei]; if ((deg[e.a] === 1 || deg[e.b] === 1) && !gateEdges.has(ei) && !gates.has(e.a) && !gates.has(e.b) && er.chance(0.3)) tree.delete(ei); }
  }
  // the open ground at the centre is ringed by a lane (the yards round it front it)
  edges.forEach((e, i) => { if (e.inQ && e.cells.includes(0) && e.cells.length === 2 && keep[e.cells[0]] && keep[e.cells[1]]) tree.add(i); });
  // every yard fronts a lane: a yard without one gets its usable edge nearest the network (a loop or an alley)
  {
    const inTree = new Set<number>();
    for (const ei of tree) { inTree.add(edges[ei].a); inTree.add(edges[ei].b); }
    const has = new Set<number>();
    for (const ei of tree) for (const ci of edges[ei].cells) has.add(ci);
    for (let ci = 0; ci < cells.length; ci++) {
      if (!keep[ci] || has.has(ci) || lev[ci] < 0) continue;
      let best = -1;
      for (let ei = 0; ei < edges.length; ei++) {
        if (!usable[ei] || !edges[ei].cells.includes(ci)) continue;
        if (inTree.has(edges[ei].a) || inTree.has(edges[ei].b)) { best = ei; break; }
      }
      if (best >= 0) { tree.add(best); for (const c2 of edges[best].cells) has.add(c2); inTree.add(edges[best].a); inTree.add(edges[best].b); }
    }
  }
  // ---- streets: chains of tree edges joined at degree-2 nodes
  const adj: number[][] = nodes.map(() => []);
  for (const ei of tree) { adj[edges[ei].a].push(ei); adj[edges[ei].b].push(ei); }
  const used = new Set<number>();
  const lanes: Polyline[] = [];
  for (const ei of tree) {
    if (used.has(ei)) continue;
    used.add(ei);
    const e = edges[ei];
    const chain: number[] = [e.a, e.b];
    for (const dir of [0, 1]) {
      let n = dir ? chain[chain.length - 1] : chain[0];
      for (;;) {
        if (adj[n].length !== 2 || gates.has(n)) break;
        const nx = adj[n].find((x) => !used.has(x));
        if (nx === undefined) break;
        used.add(nx);
        const f = edges[nx];
        n = f.a === n ? f.b : f.a;
        if (dir) chain.push(n); else chain.unshift(n);
      }
    }
    lanes.push(chain.map((i) => nodes[i]));
  }
  const streets = lanes.map((pl) => street(pl, er.range(2.8, 3.6), 3, 'lane'));
  // the way in: from the outermost palisade gate nearest the main road out through the belt
  let outerGates = [...gateEdges].filter((ei) => fenceOf(edges[ei]) === nRings - 1).map((ei) => edges[ei].a);
  if (!belt) {
    // (no belt: the outermost palisade is the camp outline; the way in reaches the lane node nearest the road side)
    const tgt = at(c, growDir, rOuter(growDir));
    const tn = new Set<number>();
    for (const ei of tree) { tn.add(edges[ei].a); tn.add(edges[ei].b); }
    let best = -1;
    for (const n of tn) if (best < 0 || dist(nodes[n], tgt) < dist(nodes[best], tgt)) best = n;
    outerGates = best >= 0 ? [best] : [];
  }
  let entry: Vec2 | null = null;
  if (outerGates.length) {
    const tgt = at(c, growDir, Rtot * 3);
    const g = outerGates.reduce((a, b) => (dist(nodes[a], tgt) < dist(nodes[b], tgt) ? a : b));
    entry = nodes[g];
    const t = Math.atan2(entry.y - c.y, entry.x - c.x);
    const exit = at(c, t, rOuter(t) * 1.25 + 10);
    streets.push(street([exit, entry], 5, 1, 'radial'));
  }
  out.streets.push(...streets);
  const rib = pathRibbons(streets);
  const front = new FrontIndex(out.streets);
  // ---- blocks and lots (yards = cells ∩ blocks); huts packed anyhow
  const blocks = carveBlocks(quarter, rib, ctx.water);
  // (every cell: the ones whose seed lies just outside the outline still hold a sliver of a block)
  const cellList = cells.map((poly, i) => ({ poly, tag: i })).filter((x) => x.poly.length >= 3);
  let centreBi = -1;
  const hr = rng.fork('huts');
  blocks.forEach((blk) => {
    const bi = out.blocks.length;
    if (pointInRing(blk, c)) {
      centreBi = bi;
      out.blocks.push({ poly: blk, kind: 'compound', compound: 'warlord-mound', quarter: 0 });
      return;
    }
    out.blocks.push({ poly: blk, kind: 'block', quarter: 0 });
    for (const pc of cutByCells(blk, cellList)) {
      const pi = out.parcels.length;
      const fr = front.frontage(pc.poly);
      if (pc.tag === 0 || !keep[pc.tag] || fr.len < 3.2 || area(pc.poly) < 30) { out.parcels.push({ poly: pc.poly, use: 'green', block: bi }); continue; }
      out.parcels.push({ poly: pc.poly, use: 'plot', block: bi });
      const L = lev[pc.tag];
      const shanty = belt && L === levels - 1;
      const placed: Polygon[] = [];
      const A = area(pc.poly);
      const n = Math.max(1, Math.min(12, Math.round((A / (shanty ? 120 : 85)) * hr.range(0.75, 1.25))));
      const ins = inscribed(pc.poly, [], 0.5);
      const rnd = (): Vec2 => ({ x: ins.c.x + hr.range(-1, 1) * ins.r * 1.5, y: ins.c.y + hr.range(-1, 1) * ins.r * 1.5 });
      for (let j = 0; j < n * 2 + 2 && placed.length < n; j++) {
        const kind = hr.float();
        const q = j === 0 && fr.mid ? { x: (fr.mid.x * 2 + ins.c.x) / 3, y: (fr.mid.y * 2 + ins.c.y) / 3 } : rnd();
        const rr = hr.range(2.4, 4), L = hr.range(6.5, 11), W = hr.range(3.6, 4.8), a = hr.range(0, 3.2), sm = hr.range(1.4, 1.9);
        const g = fitIn(pc.poly, (q2, s) => (kind < 0.5 ? hut(q2, rr * s, 7, a) : kind < 0.8 ? rect(q2, a, L * s, W * s) : hut(q2, sm * Math.max(0.9, s), 6)), placed, { margin: 1, gap: 0.7, minScale: 0.7, cands: [q, rnd(), rnd(), rnd()] });
        // (crossing rectangles share no vertex: the exact overlap test)
        if (!g || placed.some((o) => intersectionS(o, g).some((ph) => area(ph.outer) > 0.05))) continue;
        placed.push(g);
        const arch = kind < 0.5 ? 'orc-hut' : kind < 0.8 ? 'orc-longhut' : hr.pick(['smoke-pit', 'war-pen', 'hide-shed']);
        out.buildings.push({ poly: g, kind: kind < 0.8 ? 'house' : 'outbuilding', parcel: pi, arch: shanty && kind < 0.5 ? 'orc-shack' : arch, roof: 'conical', storeys: 1, material: 'hide' });
      }
    }
  });
  // ---- the centre: the arena and the warlord's hall on its mound, totems
  if (centreBi >= 0) {
    const b = out.blocks[centreBi].poly;
    out.parcels.push({ poly: b, use: 'place', block: centreBi });
    const pi = out.parcels.length - 1;
    const ins = inscribed(b, [], 1);
    const R0 = ins.r;
    const ac = at(ins.c, growDir, R0 * 0.38);
    const ar = Math.max(7, R0 * 0.38);
    const arena = orientPos(Array.from({ length: 28 }, (_, k) => at(ac, (k / 28) * 2 * Math.PI, ar)));
    if (arena.every((q) => pointInRing(b, q))) {
      out.lines.push({ kind: 'palisade', path: arena.concat([arena[0]]), width: 1.2 });
      const st = orientPos(Array.from({ length: 28 }, (_, k) => at(ac, (k / 28) * 2 * Math.PI, ar + 2.2)));
      out.lines.push({ kind: 'stands', path: st.concat([st[0]]), width: 2.4 });
      out.landmarks.push({ kind: 'arena', poly: arena });
    }
    const mc = at(ins.c, growDir + Math.PI, R0 * 0.42);
    const mr = Math.max(7, R0 * 0.32);
    const mound = orientPos(Array.from({ length: 24 }, (_, k) => at(mc, (k / 24) * 2 * Math.PI, mr)));
    if (mound.every((q) => pointInRing(b, q))) {
      out.lines.push(...hachures(mound, 2, 2.6, -1));
      const hall = fitIn(b, (q, s) => rect(q, growDir + Math.PI / 2, mr * 1.3 * s, mr * 0.7 * s), [], { margin: 2, gap: 0, minScale: 0.6, cands: [mc] });
      if (hall) { out.buildings.push({ poly: hall, kind: 'landmark', parcel: pi, arch: 'warlord-hall', roof: 'gable', storeys: 1, material: 'timber' }); out.landmarks.push({ kind: 'warlord-hall', poly: hall }); }
    }
    const tr = rng.fork('totems');
    for (let k = 0; k < 6; k++) {
      const q = at(ins.c, tr.range(0, 2 * Math.PI), R0 * tr.range(0.55, 0.85));
      const tq = rect(q, tr.range(0, 3), 2.3, 2.3);
      if (tq.every((x) => pointInRing(b, x)) && !out.buildings.some((o) => o.parcel === pi && (o.poly.some((x) => pointInRing(tq, x)) || tq.some((y) => pointInRing(o.poly, y))))) out.buildings.push({ poly: tq, kind: 'landmark', parcel: pi, arch: 'totem', roof: 'none', storeys: 1, material: 'wood' });
    }
    out.sites.push({ id: 'warlord', kind: 'warlord-hall', role: 'power', lot: b, anchor: ins.c });
    out.squares.push(b);
  }
  // ---- the palisades: along the yard edges between the levels, open at the gates, stakes pointing out
  if (!belt) {
    const gp = entry ? [{ p: entry, width: 6 }] : [];
    // (the outline ring: open where the way in crosses it)
    const t = entry ? Math.atan2(entry.y - c.y, entry.x - c.x) : 0;
    const cross = entry ? [{ p: at(c, t, rOuter(t)), width: 7 }] : [];
    for (const pl of openRing(quarter, cross.length ? cross : gp)) out.lines.push({ kind: 'palisade', path: pl, width: 1.3 });
  }
  for (let k = 0; k < Math.min(nRings, levels - 1); k++) {
    const segs: [Vec2, Vec2][] = [];
    for (const [ei, e] of edges.entries()) {
      if (gateEdges.has(ei) && tree.has(ei)) continue;
      if (e.cells.length === 2) { if ((lev[e.cells[0]] <= k) === (lev[e.cells[1]] <= k)) continue; }
      else if (!(lev[e.cells[0]] <= k)) continue;
      if (!e.inQ || !e.cells.every((ci) => keep[ci])) continue;
      segs.push([nodes[e.a], nodes[e.b]]);
    }
    // chain the segments into polylines, cut open round the gates (and wherever a lane crosses)
    const gp: Vec2[] = [];
    {
      const sides = new Map<number, number>();
      for (const ei of tree) {
        const e = edges[ei];
        const lv = Math.min(...e.cells.map((ci) => lev[ci]));
        const lv2 = Math.max(...e.cells.map((ci) => lev[ci]));
        const bit = (lv2 <= k ? 1 : 0) | (lv > k ? 2 : 0) | (lv <= k && lv2 > k ? 3 : 0);
        for (const n of [e.a, e.b]) sides.set(n, (sides.get(n) ?? 0) | bit);
      }
      for (const [n, b] of sides) if (b === 3) gp.push(nodes[n]);
    }
    if (entry && k === nRings - 1) gp.push(entry);
    const open = (p: Vec2) => gp.some((g) => dist(g, p) < 3.4);
    for (const [a, b] of segs) {
      const L = dist(a, b);
      const n = Math.max(1, Math.ceil(L / 1));
      let run: Vec2[] = [];
      const flush = () => { if (run.length >= 2) out.lines.push({ kind: 'palisade', path: run, width: 1.3 }); run = []; };
      for (let j = 0; j <= n; j++) { const q = { x: a.x + ((b.x - a.x) * j) / n, y: a.y + ((b.y - a.y) * j) / n }; if (open(q)) flush(); else run.push(q); }
      flush();
    }
  }
  out.sites.push({ id: 'warcamp', kind: 'war-camp', role: 'power', lot: quarter, anchor: c, tags: { palisades: String(nRings) } });
  return out;
}
