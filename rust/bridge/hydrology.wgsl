// Physical flood levels and routing potential are distinct: flats stay flat.
// Dispatch boundaries synchronize all tiles and each pointer-doubling pass.
struct Params { grid: vec4<u32>, physical: vec4<f32> }
struct Node {
  h: f32,
  priority: f32,
  flood: array<vec2<f32>, 2>,
  receiver: u32,
  pointer: array<u32, 2>,
  area: array<atomic<u32>, 2>,
}
struct Control {
  changes: array<atomic<u32>, 2>,
  errors: atomic<u32>,
  rootArea: atomic<u32>,
}
struct Output { filled: f32, receiver: u32, accumulation: f32, potential: f32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> height: array<f32>;
@group(0) @binding(2) var<storage, read> sea: array<u32>;
@group(0) @binding(3) var<storage, read_write> nodes: array<Node>;
@group(0) @binding(4) var<storage, read_write> control: Control;
@group(0) @binding(5) var<storage, read_write> output: array<Output>;

const OUTLET: u32 = 0xffffffffu;
const INF: f32 = 3.4e38;
const directions = array<vec2<i32>, 8>(
  vec2<i32>(1, 0), vec2<i32>(1, 1), vec2<i32>(0, 1), vec2<i32>(-1, 1),
  vec2<i32>(-1, 0), vec2<i32>(-1, -1), vec2<i32>(0, -1), vec2<i32>(1, -1));
const distances = array<f32, 8>(1.0, 1.41421356, 1.0, 1.41421356, 1.0, 1.41421356, 1.0, 1.41421356);

fn count() -> u32 { return p.grid.x * p.grid.x; }
fn edge(i: u32) -> bool {
  let n = p.grid.x;
  return i % n == 0u || i / n == 0u || i % n == n - 1u || i / n == n - 1u;
}
fn isSea(i: u32) -> bool { return p.grid.w != 0u && sea[i] != 0u; }
fn outlet(i: u32) -> bool { return edge(i) || isSea(i); }
fn neighbor(i: u32, d: u32) -> u32 {
  let n = i32(p.grid.x);
  let xy = vec2<i32>(i32(i) % n, i32(i) / n) + directions[d];
  if (any(xy < vec2<i32>(0)) || any(xy >= vec2<i32>(n))) { return OUTLET; }
  return u32(xy.y * n + xy.x);
}
fn lower(a: vec2<f32>, b: vec2<f32>) -> bool {
  return a.x < b.x || (a.x == b.x && a.y < b.y);
}
fn routingPriority(i: u32) -> f32 {
  var value = i ^ p.grid.y;
  value = (value ^ (value >> 16u)) * 0x7feb352du;
  value = (value ^ (value >> 15u)) * 0x846ca68bu;
  value ^= value >> 16u;
  return 0.5 + f32(value & 65535u) / 65535.0;
}
fn candidate(h: f32, otherH: f32, priority: f32, otherPriority: f32, other: vec2<f32>, d: u32) -> vec2<f32> {
  let level = max(h, other.x);
  // Prefer the bottom of a pond instead of shortest diagonal lattice routes.
  let depth = max(0.0, level - (h + otherH) * 0.5);
  let cost = (1.0 + 8.0 * exp(-depth / p.physical.z)) * (priority + otherPriority) * 0.5;
  let potential = select(other.y + distances[d] * cost, 0.0, h > other.x);
  return vec2<f32>(level, potential);
}

@compute @workgroup_size(1)
fn reset() {
  atomicStore(&control.changes[0], 1u);
  atomicStore(&control.changes[1], 1u);
  atomicStore(&control.errors, 0u);
  atomicStore(&control.rootArea, 0u);
}
@compute @workgroup_size(256)
fn initialize(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= count()) { return; }
  nodes[i].h = height[i];
  nodes[i].priority = routingPriority(i);
  let state = select(vec2<f32>(INF, 1e30), vec2<f32>(height[i], 0.0), outlet(i));
  nodes[i].flood[0] = state;
  nodes[i].flood[1] = state;
}
@compute @workgroup_size(1)
fn clearNext() { atomicStore(&control.changes[1u - p.grid.z], 0u); }

var<workgroup> tileA: array<vec2<f32>, 324>;
var<workgroup> tileB: array<vec2<f32>, 324>;
var<workgroup> tileH: array<f32, 324>;
var<workgroup> tilePriority: array<f32, 324>;
var<workgroup> tileChanged: atomic<u32>;
var<workgroup> tileActive: u32;

// Each 16² tile relaxes its interior with a fixed, one-cell halo.
@compute @workgroup_size(16, 16)
fn solveTile(@builtin(local_invocation_id) local: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
  let lane = local.y * 16u + local.x;
  let phase = p.grid.z;
  if (lane == 0u) { tileActive = atomicLoad(&control.changes[phase]); }
  if (workgroupUniformLoad(&tileActive) == 0u) { return; }
  let base = vec2<i32>(group.xy * 16u) - 1;
  let n = i32(p.grid.x);
  for (var k = lane; k < 324u; k += 256u) {
    let xy = base + vec2<i32>(i32(k % 18u), i32(k / 18u));
    var state = vec2<f32>(INF, 1e30);
    var h = INF;
    var priority = 1.0;
    if (all(xy >= vec2<i32>(0)) && all(xy < vec2<i32>(n))) {
      let j = u32(xy.y * n + xy.x);
      state = nodes[j].flood[phase];
      h = nodes[j].h;
      priority = nodes[j].priority;
    }
    tileA[k] = state;
    tileB[k] = state;
    tileH[k] = h;
    tilePriority[k] = priority;
  }
  workgroupBarrier();
  let xy = group.xy * 16u + local.xy;
  let valid = all(xy < vec2<u32>(p.grid.x));
  let i = xy.y * p.grid.x + xy.x;
  let k = (local.y + 1u) * 18u + local.x + 1u;
  let original = tileA[k];
  for (var step = 0u; step < 16u; step++) {
    if (lane == 0u) { atomicStore(&tileChanged, 0u); }
    workgroupBarrier();
    var value = tileA[k];
    if (valid && !outlet(i)) {
      for (var d = 0u; d < 8u; d++) {
        let j = u32(i32(k) + directions[d].y * 18 + directions[d].x);
        let next = candidate(tileH[k], tileH[j], tilePriority[k], tilePriority[j], tileA[j], d);
        if (lower(next, value)) { value = next; }
      }
    }
    if (any(value != tileA[k])) { atomicStore(&tileChanged, 1u); }
    tileB[k] = value;
    workgroupBarrier();
    tileA[k] = tileB[k];
    workgroupBarrier();
    if (lane == 0u) { tileActive = atomicLoad(&tileChanged); }
    if (workgroupUniformLoad(&tileActive) == 0u) { break; }
  }
  if (valid) {
    let value = tileA[k];
    nodes[i].flood[1u - phase] = value;
    if (any(value != original)) { atomicStore(&control.changes[1u - phase], 1u); }
  }
}

// Check the global fixed point and choose strictly decreasing receivers.
@compute @workgroup_size(256)
fn receivers(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= count()) { return; }
  let current = nodes[i].flood[0];
  var receiver = OUTLET;
  var bestSlope = -1.0;
  var bestPotential = -1.0;
  var bestHeight = INF;
  if (current.x >= 1e30 || current.y >= 1e30 || current.x < nodes[i].h) {
    atomicAdd(&control.errors, 1u);
  }
  if (!outlet(i)) {
    for (var d = 0u; d < 8u; d++) {
      let j = neighbor(i, d);
      if (j == OUTLET) { continue; }
      let other = nodes[j].flood[0];
      if (lower(candidate(nodes[i].h, nodes[j].h, nodes[i].priority, nodes[j].priority, other, d), current)) {
        atomicAdd(&control.errors, 1u);
      }
      if (!lower(other, current)) { continue; }
      let slope = (current.x - other.x) / distances[d];
      let potential = (current.y - other.y) / distances[d];
      if (slope > bestSlope || (slope == bestSlope && (potential > bestPotential || (potential == bestPotential && nodes[j].h < bestHeight)))) {
        receiver = j;
        bestSlope = slope;
        bestPotential = potential;
        bestHeight = nodes[j].h;
      }
    }
    if (receiver == OUTLET) { atomicAdd(&control.errors, 1u); }
  }
  nodes[i].receiver = receiver;
  nodes[i].pointer[0] = receiver;
  nodes[i].pointer[1] = receiver;
  let area = select(1u, 0u, isSea(i));
  atomicStore(&nodes[i].area[0], area);
  atomicStore(&nodes[i].area[1], area);
}

// Integer counts avoid nondeterministic FP32 atomic additions at confluences.
// At round k, each node holds upstream nodes within 2^k steps; adding that
// disjoint range at its 2^k downstream ancestor doubles the resolved range.
@compute @workgroup_size(256)
fn accumulateCopy(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= count()) { return; }
  let phase = p.grid.z;
  let next = 1u - phase;
  atomicStore(&nodes[i].area[next], atomicLoad(&nodes[i].area[phase]));
  let pointer = nodes[i].pointer[phase];
  var ancestor = OUTLET;
  if (pointer != OUTLET) { ancestor = nodes[pointer].pointer[phase]; }
  nodes[i].pointer[next] = ancestor;
}
@compute @workgroup_size(256)
fn accumulateScatter(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= count()) { return; }
  let phase = p.grid.z;
  let pointer = nodes[i].pointer[phase];
  if (pointer != OUTLET) { atomicAdd(&nodes[pointer].area[1u - phase], atomicLoad(&nodes[i].area[phase])); }
}
@compute @workgroup_size(256)
fn finish(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= count()) { return; }
  let area = atomicLoad(&nodes[i].area[p.grid.z]);
  if (nodes[i].pointer[p.grid.z] != OUTLET || area > count()) { atomicAdd(&control.errors, 1u); }
  if (nodes[i].receiver == OUTLET) { atomicAdd(&control.rootArea, area); }
  output[i].filled = nodes[i].flood[0].x;
  output[i].receiver = nodes[i].receiver;
  output[i].accumulation = f32(area) * p.physical.y;
  output[i].potential = nodes[i].flood[0].y * p.physical.x;
}
