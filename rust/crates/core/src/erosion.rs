//! Coarse landscape evolution ported from web/src/gen/terrain/erosion.ts.
//! Priority flood, D-infinity split drainage, implicit stream-power incision,
//! basin breaching, thermal relaxation, and bounded bicubic sampling.
use crate::{noise::Noise, smooth};
use std::f64::consts::{FRAC_PI_4, SQRT_2};

const D8: [(isize, isize); 8] = [
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
    (0, -1),
    (1, -1),
];
const DIST: [f64; 8] = [1.0, SQRT_2, 1.0, SQRT_2, 1.0, SQRT_2, 1.0, SQRT_2];

// A gentle onset and a bounded endpoint, independent of map extent.
fn erosion_strength(erosion: f64) -> f64 {
    0.12 * erosion
}

// Reuse the same D8 topology through every erosion iteration. Sentinel edges
// preserve visiting order while removing repeated divisions and bounds arithmetic.
struct Grid {
    n: usize,
    neighbors: Vec<[usize; 8]>,
    borders: Vec<bool>,
}
impl Grid {
    fn new(n: usize) -> Self {
        let mut neighbors = vec![[usize::MAX; 8]; n * n];
        let mut borders = vec![false; n * n];
        for y in 0..n {
            for x in 0..n {
                let i = y * n + x;
                borders[i] = x == 0 || y == 0 || x == n - 1 || y == n - 1;
                for (d, &(dx, dy)) in D8.iter().enumerate() {
                    let nx = x as isize + dx;
                    let ny = y as isize + dy;
                    if nx >= 0 && ny >= 0 && nx < n as isize && ny < n as isize {
                        neighbors[i][d] = ny as usize * n + nx as usize;
                    }
                }
            }
        }
        Self {
            n,
            neighbors,
            borders,
        }
    }
    fn neighbor(&self, i: usize, d: usize) -> Option<usize> {
        let r = self.neighbors[i][d];
        (r != usize::MAX).then_some(r)
    }
}

struct Flood {
    filled: Vec<f32>,
    receiver: Vec<usize>,
    order: Vec<usize>,
}

// Equal-height heap insertion/removal uses the TS visiting order for stable drainage.
struct MinHeap(Vec<(f32, usize)>);

impl MinHeap {
    fn push(&mut self, value: usize, key: f32) {
        self.0.push((key, value));
        let mut i = self.0.len() - 1;
        while i > 0 {
            let parent = (i - 1) / 2;
            if self.0[parent].0 <= key {
                break;
            }
            self.0[i] = self.0[parent];
            i = parent;
        }
        self.0[i] = (key, value);
    }

    fn pop(&mut self) -> Option<usize> {
        let result = self.0.first()?.1;
        let last = self.0.pop().unwrap();
        if !self.0.is_empty() {
            let mut i = 0;
            loop {
                let mut child = i * 2 + 1;
                if child >= self.0.len() {
                    break;
                }
                if child + 1 < self.0.len() && self.0[child + 1].0 < self.0[child].0 {
                    child += 1;
                }
                if self.0[child].0 >= last.0 {
                    break;
                }
                self.0[i] = self.0[child];
                i = child;
            }
            self.0[i] = last;
        }
        Some(result)
    }
}

fn flood(h: &[f32], grid: &Grid) -> Flood {
    let mut fl = Flood {
        filled: vec![0.0; h.len()],
        receiver: vec![usize::MAX; h.len()],
        order: Vec::with_capacity(h.len()),
    };
    let mut closed = vec![false; h.len()];
    let mut heap = MinHeap(Vec::with_capacity(h.len()));
    for i in 0..h.len() {
        if grid.borders[i] {
            closed[i] = true;
            fl.filled[i] = h[i];
            heap.push(i, h[i]);
        }
    }
    while let Some(c) = heap.pop() {
        fl.order.push(c);
        for d in 0..8 {
            if let Some(r) = grid.neighbor(c, d) {
                if closed[r] {
                    continue;
                }
                closed[r] = true;
                fl.filled[r] = if h[r] > fl.filled[c] {
                    h[r]
                } else {
                    // Topological rank already orders flats. A fixed 1 cm rise per cell
                    // creates artificial planar drainage on low-amplitude terrain.
                    fl.filled[c]
                };
                fl.receiver[r] = c;
                heap.push(r, fl.filled[r]);
            }
        }
    }
    let mut rank = vec![0; h.len()];
    for (k, &c) in fl.order.iter().enumerate() {
        rank[c] = k;
    }
    for (k, &c) in fl.order.iter().enumerate() {
        if fl.receiver[c] == usize::MAX {
            continue;
        }
        let mut gradient = 0.0;
        for (d, &distance) in DIST.iter().enumerate() {
            if let Some(r) = grid.neighbor(c, d) {
                if rank[r] >= k {
                    continue;
                }
                let drop = (fl.filled[c] as f64 - fl.filled[r] as f64) / distance;
                if drop > gradient {
                    gradient = drop;
                    fl.receiver[c] = r;
                }
            }
        }
    }
    fl
}

struct Flow {
    first: Vec<usize>,
    second: Vec<usize>,
    fraction: Vec<f32>,
    distance: Vec<f32>,
}

fn continuous_flow(fl: &Flood, grid: &Grid) -> Flow {
    let n = grid.n;
    let size = fl.order.len();
    let mut rank = vec![0; size];
    for (k, &c) in fl.order.iter().enumerate() {
        rank[c] = k;
    }
    let mut flow = Flow {
        first: fl.receiver.clone(),
        second: vec![usize::MAX; size],
        fraction: vec![0.0; size],
        distance: vec![1.0; size],
    };
    for (k, &c) in fl.order.iter().enumerate() {
        let r = flow.first[c];
        if r == usize::MAX {
            continue;
        }
        let diagonal = (c % n).abs_diff(r % n) + (c / n).abs_diff(r / n) == 2;
        let distance = if diagonal { SQRT_2 } else { 1.0 };
        let mut best = (fl.filled[c] as f64 - fl.filled[r] as f64) / distance;
        flow.distance[c] = distance as f32;
        for d in 0..8 {
            let Some(a) = grid.neighbor(c, d) else {
                continue;
            };
            let Some(b) = grid.neighbor(c, (d + 1) & 7) else {
                continue;
            };
            if rank[a] >= k || rank[b] >= k {
                continue;
            }
            let (ux, uy) = (D8[d].0 as f64, D8[d].1 as f64);
            let (vx, vy) = (D8[(d + 1) & 7].0 as f64, D8[(d + 1) & 7].1 as f64);
            let da = fl.filled[c] as f64 - fl.filled[a] as f64;
            let db = fl.filled[c] as f64 - fl.filled[b] as f64;
            let det = ux * vy - uy * vx;
            let gx = (da * vy - db * uy) / det;
            let gy = (db * ux - da * vx) / det;
            let ca = ux * gy - uy * gx;
            let cb = gx * vy - gy * vx;
            if ca < 0.0 || cb < 0.0 {
                continue;
            }
            let slope = gx.hypot(gy);
            if slope <= best {
                continue;
            }
            let t = (ca.atan2(ux * gx + uy * gy) / FRAC_PI_4).clamp(0.0, 1.0);
            best = slope;
            flow.first[c] = a;
            flow.second[c] = b;
            flow.fraction[c] = t as f32;
            flow.distance[c] = ((1.0 - t) * DIST[d] + t * DIST[(d + 1) & 7]) as f32;
        }
    }
    flow
}

fn resolve_pits(h: &mut [f32], fl: &Flood, grid: &Grid, frac: f64) -> usize {
    let mut component = vec![usize::MAX; h.len()];
    let mut stack = Vec::new();
    let mut cells = Vec::new();
    let mut resolved = 0;
    for start in 0..h.len() {
        if component[start] != usize::MAX || fl.filled[start] - h[start] <= 0.05 {
            continue;
        }
        cells.clear();
        component[start] = start;
        stack.push(start);
        while let Some(c) = stack.pop() {
            cells.push(c);
            for d in 0..8 {
                if let Some(r) = grid.neighbor(c, d)
                    && component[r] == usize::MAX
                    && fl.filled[r] - h[r] > 0.05
                {
                    component[r] = start;
                    stack.push(r);
                }
            }
        }
        let mut pour = usize::MAX;
        for &c in &cells {
            let r = fl.receiver[c];
            if r != usize::MAX
                && component[r] != start
                && (pour == usize::MAX || fl.filled[c] < fl.filled[pour])
            {
                pour = c;
            }
        }
        if pour == usize::MAX {
            continue;
        }
        let spill = fl.filled[pour] as f64;
        for &c in &cells {
            if (h[c] as f64) < spill {
                h[c] = (h[c] as f64 + frac * (spill - h[c] as f64)) as f32;
            }
        }
        // Sediment may fill a basin; never carve an arbitrary D8 chain through
        // its outlet. Physical surface erosion handles downhill incision later.
        resolved += 1;
    }
    resolved
}

fn thermal(h: &mut [f32], grid: &Grid, cell: f64, talus: f64, passes: usize, rate: f64) {
    let mut delta = vec![0.0_f64; h.len()];
    for _ in 0..passes {
        delta.fill(0.0);
        for i in 0..h.len() {
            if grid.borders[i] {
                continue;
            }
            let mut excess = [0.0_f64; 8];
            let (mut total, mut maximum) = (0.0_f64, 0.0_f64);
            for (d, &step) in DIST.iter().enumerate() {
                if let Some(r) = grid.neighbor(i, d) {
                    let drop = h[i] as f64 - h[r] as f64;
                    let ds = cell * step;
                    excess[d] = (drop - talus * ds).max(0.0);
                    total += excess[d];
                    maximum = maximum.max(excess[d]);
                }
            }
            if total > 0.0 {
                // Eight donors can meet at one cell; this bound avoids overshoot
                // and the new pits produced by a steepest-neighbor transfer.
                let movement = rate * 0.125 * maximum;
                delta[i] -= movement;
                for (d, &weight) in excess.iter().enumerate() {
                    if weight > 0.0 {
                        delta[grid.neighbor(i, d).unwrap()] += movement * weight / total;
                    }
                }
            }
        }
        for (value, change) in h.iter_mut().zip(&delta) {
            *value = (*value as f64 + change) as f32;
        }
    }
}

pub(crate) fn diffuse(h: &mut [f32], n: usize, channels: &[bool], strength: f64) {
    let previous = h.to_vec();
    for y in 1..n - 1 {
        for x in 1..n - 1 {
            let i = y * n + x;
            let weight = strength
                * if channels.get(i).copied().unwrap_or(false) {
                    0.75
                } else {
                    1.0
                };
            let average = (previous[i - 1] as f64
                + previous[i + 1] as f64
                + previous[i - n] as f64
                + previous[i + n] as f64)
                * 0.2
                + (previous[i - n - 1] as f64
                    + previous[i - n + 1] as f64
                    + previous[i + n - 1] as f64
                    + previous[i + n + 1] as f64)
                    * 0.05;
            h[i] = ((1.0 - weight) * previous[i] as f64 + weight * average) as f32;
        }
    }
}

fn sample(h: &[f32], n: usize, fx: f64, fy: f64, cubic: bool) -> f64 {
    let x = fx.floor() as isize;
    let y = fy.floor() as isize;
    let tx = fx - x as f64;
    let ty = fy - y as f64;
    let at = |dx: isize, dy: isize| {
        h[(y + dy).clamp(0, n as isize - 1) as usize * n
            + (x + dx).clamp(0, n as isize - 1) as usize] as f64
    };
    if !cubic {
        return (at(0, 0) * (1.0 - tx) + at(1, 0) * tx) * (1.0 - ty)
            + (at(0, 1) * (1.0 - tx) + at(1, 1) * tx) * ty;
    }
    let interpolate = |a: f64, b: f64, c: f64, d: f64, t: f64| {
        b + 0.5 * t * (c - a + t * (2.0 * a - 5.0 * b + 4.0 * c - d + t * (3.0 * (b - c) + d - a)))
    };
    let mut rows = [0.0; 4];
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for dy in -1..=2 {
        rows[(dy + 1) as usize] = interpolate(at(-1, dy), at(0, dy), at(1, dy), at(2, dy), tx);
        for dx in -1..=2 {
            lo = lo.min(at(dx, dy));
            hi = hi.max(at(dx, dy));
        }
    }
    interpolate(rows[0], rows[1], rows[2], rows[3], ty).clamp(lo, hi)
}

pub(crate) struct MountainCfg<'a> {
    pub n: usize,
    pub width: f64,
    pub amp: f64,
    pub generation_noise: Option<&'a crate::GenerationNoise<'a>>,
    pub noise: &'a Noise,
    pub noise2: &'a Noise,
    pub down: (f64, f64),
    pub k: f64,
    pub iterations: usize,
    pub coarse: usize,
    pub mountain_mix: f64,
    pub talus: f64,
    pub detail: f64,
    pub diffusion: f64,
    pub crest: f64,
    pub valley: Option<(f64, f64, f64)>,
    pub erosion: f64,
}

pub(crate) fn mountain(cfg: &MountainCfg<'_>) -> Vec<f32> {
    let n = cfg.n;
    let nc = cfg.coarse;
    let count = nc * nc;
    let grid = Grid::new(nc);
    let extent = cfg.width * 1.44;
    let cc = extent / nc as f64;
    let cell = cfg.width / n as f64;
    let x0 = -cfg.width * 0.22;
    let mut uplift = vec![0.0_f32; count];
    let mut h = vec![0.0_f32; count];
    for y in 0..nc {
        for x in 0..nc {
            let px = x0 + (x as f64 + 0.5) * cc;
            let py = x0 + (y as f64 + 0.5) * cc;
            let env_wavelength = (1900.0 * cfg.k).max(cc * 4.0);
            let initial_wavelength = (415.0 * cfg.k).max(cc * 4.0);
            let coarse_noise = cfg.generation_noise.filter(|v| !v.coarse.is_empty());
            let env = coarse_noise.map_or_else(
                || {
                    cfg.noise
                        .fbm(px / env_wavelength + 3.1, py / env_wavelength - 1.7, 3)
                },
                |v| v.coarse[(y * nc + x) * 4] as f64,
            );
            let q = ((px - cfg.width * 0.5) * cfg.down.0 + (py - cfg.width * 0.5) * cfg.down.1)
                / cfg.width;
            let edge = x.min(y).min(nc - 1 - x).min(nc - 1 - y) as f64 / (0.1 * nc as f64);
            // Broad regions vary uplift continuously between hills and mountain ranges.
            let distribution = coarse_noise.map_or_else(
                || {
                    cfg.noise2
                        .fbm(px / (2700.0 * cfg.k) + 8.4, py / (2700.0 * cfg.k), 3)
                },
                |v| v.coarse[(y * nc + x) * 4 + 1] as f64,
            );
            let mountains = smooth((distribution + (cfg.mountain_mix - 0.5) * 1.4 + 0.28) / 0.56);
            let regional_amp = 0.20 + 0.80 * mountains;
            let ridge = if cfg.crest > 0.0 {
                coarse_noise.map_or_else(
                    || {
                        cfg.noise2
                            .ridged(px / env_wavelength + 5.7, py / env_wavelength - 3.2, 3)
                    },
                    |v| v.coarse[(y * nc + x) * 4 + 3] as f64,
                )
            } else {
                0.0
            };
            // Ridge skeleton belongs to the main uplift, not a texture painted
            // after erosion. Hills and canyon uplands keep their smoother forms.
            let skeleton = 1.0 + cfg.crest * mountains * ((0.24 + 1.8 * ridge * ridge) - 1.0);
            let u = (0.7 + 0.5 * env - 0.25 * q).max(0.12) * regional_amp * skeleton;
            let mut corridor = 1.0;
            if let Some((width, offset, noise_offset)) = cfg.valley {
                let along = q * cfg.width;
                let across =
                    -(px - cfg.width * 0.5) * cfg.down.1 + (py - cfg.width * 0.5) * cfg.down.0;
                let meander = 320.0
                    * cfg.k
                    * cfg
                        .noise
                        .fbm((along + noise_offset) / (2600.0 * cfg.k), 0.37, 2)
                    + 120.0
                        * cfg.k
                        * cfg
                            .noise
                            .fbm((along + noise_offset) / (900.0 * cfg.k), 5.1, 2);
                let floor = width * (0.8 + 0.4 * cfg.noise2.fbm(along / (1500.0 * cfg.k), 3.3, 2));
                let wall = smooth(((across - offset + meander).abs() - floor) / (cfg.width * 0.42));
                corridor = 0.055 + 0.945 * wall.powf(1.25);
            }
            uplift[y * nc + x] = (u * corridor * (0.25 + 0.75 * smooth(edge))) as f32;
            h[y * nc + x] = (corridor
                * (2.5 * u
                    + 0.6
                        * coarse_noise.map_or_else(
                            || {
                                cfg.noise2
                                    .fbm(px / initial_wavelength, py / initial_wavelength, 3)
                            },
                            |v| v.coarse[(y * nc + x) * 4 + 2] as f64,
                        ))) as f32;
        }
    }
    for (i, value) in h.iter_mut().enumerate() {
        if grid.borders[i] {
            *value = 0.0;
        }
    }
    let uplift_step = cfg.amp * 1.25 / cfg.iterations as f64;
    let strength = erosion_strength(cfg.erosion);
    let incision = strength * cc / (0.004_f64.sqrt() * cfg.k * 2400.0);
    let catchment_cap = 4.0 * 0.004_f64.sqrt() * cfg.k * 2400.0 / cc;
    let mut acc = vec![1.0_f32; count];
    let mut channels = vec![false; count];
    for _ in 0..cfg.iterations {
        for i in 0..count {
            if !grid.borders[i] {
                h[i] = (h[i] as f64 + uplift[i] as f64 * uplift_step) as f32;
            }
        }
        if cfg.erosion > 0.0 {
            let fl = flood(&h, &grid);
            resolve_pits(&mut h, &fl, &grid, (strength * 0.6).min(0.6));
            let flow = continuous_flow(&fl, &grid);
            acc.fill(1.0);
            for &c in fl.order.iter().rev() {
                let r = flow.first[c];
                let s = flow.second[c];
                let t = flow.fraction[c] as f64;
                if r != usize::MAX {
                    acc[r] = (acc[r] as f64 + acc[c] as f64 * (1.0 - t)) as f32;
                }
                if s != usize::MAX {
                    acc[s] = (acc[s] as f64 + acc[c] as f64 * t) as f32;
                }
            }
            let baseline = h.clone();
            for &c in &fl.order {
                let r = flow.first[c];
                let s = flow.second[c];
                let t = flow.fraction[c] as f64;
                if r == usize::MAX {
                    continue;
                }
                let lower = if s != usize::MAX {
                    (1.0 - t) * h[r] as f64 + t * h[s] as f64
                } else {
                    h[r] as f64
                };
                let original_lower = if s == usize::MAX {
                    baseline[r] as f64
                } else {
                    (1.0 - t) * baseline[r] as f64 + t * baseline[s] as f64
                };
                let slope = ((baseline[c] as f64 - original_lower)
                    / (cc * flow.distance[c] as f64))
                    .max(0.0);
                // A flood potential routes water across sinks; it must not cut a
                // physical channel across a flat or uphill saddle in that potential.
                let response = slope * slope / (slope * slope + 0.04);
                let factor = (incision * (acc[c] as f64).sqrt().min(catchment_cap) * response
                    / flow.distance[c] as f64)
                    .min(6.0);
                h[c] = (h[c] as f64).min((h[c] as f64 + factor * lower) / (1.0 + factor)) as f32;
            }
            thermal(&mut h, &grid, cc, cfg.talus, 3, strength * 0.8);
            for i in 0..count {
                channels[i] = acc[i] as f64 >= count as f64 * 0.001;
            }
            let diffusion = cfg.diffusion * 3.0 * strength;
            for _ in 0..diffusion.floor() as usize {
                diffuse(&mut h, nc, &channels, 0.5);
            }
            if diffusion.fract() > 0.0 {
                diffuse(&mut h, nc, &channels, 0.5 * diffusion.fract());
            }
        }
        for (i, value) in h.iter_mut().enumerate() {
            if grid.borders[i] {
                *value = 0.0;
            }
        }
    }
    for value in &mut h {
        *value = value.max(0.0);
    }
    if cfg.erosion > 0.0 {
        thermal(&mut h, &grid, cc, cfg.talus * 0.95, 4, strength * 0.8);
        for _ in 0..2 {
            let fl = flood(&h, &grid);
            if resolve_pits(&mut h, &fl, &grid, strength * 0.5) == 0 {
                break;
            }
        }
        diffuse(&mut h, nc, &channels, strength * 0.5);
    }
    let mut output = vec![0.0_f32; n * n];
    let mut drainage_weight = vec![0.0_f64; n * n];
    let mut samples = Vec::with_capacity(n * n / 16 + 1);
    for y in 0..n {
        for x in 0..n {
            let px = (x as f64 + 0.5) * cell;
            let py = (y as f64 + 0.5) * cell;
            let drainage = sample(&acc, nc, (px - x0) / cc - 0.5, (py - x0) / cc - 0.5, false);
            let warp = (16.0 * cfg.k).min(cc * 0.9);
            let warp_wavelength = (110.0 * cfg.k).max(cc * 4.0);
            let wx = px
                + warp
                    * cfg.generation_noise.map_or_else(
                        || {
                            cfg.noise2
                                .fbm(px / warp_wavelength + 11.3, py / warp_wavelength, 2)
                        },
                        |v| v.fine[(y * n + x) * 4] as f64,
                    );
            let wy = py
                + warp
                    * cfg.generation_noise.map_or_else(
                        || {
                            cfg.noise2.fbm(
                                px / warp_wavelength - 4.7,
                                py / warp_wavelength + 2.9,
                                2,
                            )
                        },
                        |v| v.fine[(y * n + x) * 4 + 1] as f64,
                    );
            let i = y * n + x;
            drainage_weight[i] = 1.0
                - 0.85
                    * strength
                    * smooth((drainage - 4.0) / (count as f64 * 0.001 - 4.0).max(12.0));
            output[i] = sample(&h, nc, (wx - x0) / cc - 0.5, (wy - x0) / cc - 0.5, true) as f32;
            if (x + y * 7) & 15 == 0 {
                samples.push(output[i]);
            }
        }
    }
    samples.sort_unstable_by(f32::total_cmp);
    let p99 = samples[(samples.len() as f64 * 0.99).floor() as usize].max(0.0001) as f64;
    // Keep a legible relief at the endpoint instead of erasing it with runaway incision.
    let worn_amplitude = cfg.amp * (1.0 - 0.2 * strength);
    let scale = worn_amplitude / p99;
    let slopes = output.clone();
    let wavelength = (cell * 6.0).max(260.0 * cfg.k);
    let octaves = (wavelength / (cell * 4.0)).log2().round().clamp(1.0, 6.0) as usize;
    for y in 0..n {
        for x in 0..n {
            let i = y * n + x;
            let gx = slopes[y * n + (x + 1).min(n - 1)] as f64
                - slopes[y * n + x.saturating_sub(1)] as f64;
            let gy = slopes[(y + 1).min(n - 1) * n + x] as f64
                - slopes[y.saturating_sub(1) * n + x] as f64;
            let slope = gx.hypot(gy) * scale / (2.0 * cell);
            let factor = smooth((slope - 0.015) / 0.3) * drainage_weight[i];
            let px = (x as f64 + 0.5) * cell;
            let py = (y as f64 + 0.5) * cell;
            let detail = (cfg.generation_noise.map_or_else(
                || cfg.noise2.ridged(px / wavelength, py / wavelength, octaves),
                |v| v.fine[i * 4 + 2] as f64,
            ) - 0.5)
                * cfg.detail
                * worn_amplitude
                * factor;
            output[i] = (output[i] as f64 * scale + detail).max(0.3) as f32;
        }
    }
    output
}

// Smooth positive cubic B-spline weights keep the erosion delta continuous,
// including its derivatives. Clamped interpolating cubics can ring on flat terrain.
fn sample_delta(h: &[f32], n: usize, fx: f64, fy: f64) -> f64 {
    let x = fx.floor() as isize;
    let y = fy.floor() as isize;
    let weights = |t: f64| {
        [
            (1.0 - t).powi(3) / 6.0,
            (3.0 * t.powi(3) - 6.0 * t * t + 4.0) / 6.0,
            (-3.0 * t.powi(3) + 3.0 * t * t + 3.0 * t + 1.0) / 6.0,
            t.powi(3) / 6.0,
        ]
    };
    let wx = weights(fx - x as f64);
    let wy = weights(fy - y as f64);
    let mut result = 0.0;
    for (j, &weight_y) in wy.iter().enumerate() {
        let row = (y + j as isize - 1).clamp(0, n as isize - 1) as usize;
        for (i, &weight_x) in wx.iter().enumerate() {
            let col = (x + i as isize - 1).clamp(0, n as isize - 1) as usize;
            result += h[row * n + col] as f64 * weight_x * weight_y;
        }
    }
    result
}

fn sample_extended(h: &[f32], n: usize, fx: f64, fy: f64) -> f64 {
    let x = fx.clamp(0.0, (n - 1) as f64);
    let y = fy.clamp(0.0, (n - 1) as f64);
    let mut value = sample(h, n, x, y, false);
    if fx != x {
        let xa = (x - 1.0).max(0.0);
        let xb = (x + 1.0).min((n - 1) as f64);
        value += (fx - x) * (sample(h, n, xb, y, false) - sample(h, n, xa, y, false)) / (xb - xa);
    }
    if fy != y {
        let ya = (y - 1.0).max(0.0);
        let yb = (y + 1.0).min((n - 1) as f64);
        value += (fy - y) * (sample(h, n, x, yb, false) - sample(h, n, x, ya, false)) / (yb - ya);
    }
    value
}

/// Incise pre-shaped canyon/plateau/volcano without regional uplift or p99 rescaling.
pub(crate) fn erode_shape(h: &mut [f32], n: usize, cell: f64, erosion: f64, talus: f64) {
    erode_with(
        h,
        n,
        cell,
        erosion,
        talus,
        &ShapeErosion {
            gain: 1.0,
            motif: cell * n as f64,
            coarse: 320,
            iterations: 12,
            canyon_amplitude: None,
        },
    );
}

/// Catchment-driven canyon incision; no prescribed channel geometry.
pub(crate) fn erode_canyon(
    h: &mut [f32],
    n: usize,
    cell: f64,
    erosion: f64,
    talus: f64,
    motif: f64,
    amplitude: f64,
) {
    erode_with(
        h,
        n,
        cell,
        erosion,
        talus,
        &ShapeErosion {
            gain: 1.0,
            motif,
            coarse: surface_resolution(cell * n as f64, motif),
            iterations: 12,
            canyon_amplitude: Some(amplitude),
        },
    );
}

/// Shared erosion of physical surface detail after regional reconstruction.
pub(crate) fn erode_surface(
    h: &mut [f32],
    n: usize,
    cell: f64,
    erosion: f64,
    talus: f64,
    motif: f64,
) {
    erode_with(
        h,
        n,
        cell,
        erosion,
        talus,
        &ShapeErosion {
            gain: 1.0,
            motif,
            coarse: surface_resolution(cell * n as f64, motif),
            iterations: 12,
            canyon_amplitude: None,
        },
    );
}

struct ShapeErosion {
    gain: f64,
    motif: f64,
    coarse: usize,
    iterations: usize,
    canyon_amplitude: Option<f64>,
}

// Deep trunk-river erosion is deliberately separate from ordinary hillside
// erosion. Accumulation selects the rivers; Euclidean bank profiles enlarge
// their incision without reproducing grid-aligned basin-breach trenches.
fn canyon_cut(h: &mut [f32], n: usize, cell: f64, erosion: f64, motif: f64, amplitude: f64) {
    let grid = Grid::new(n);
    let fl = flood(h, &grid);
    let flow = continuous_flow(&fl, &grid);
    let mut acc = vec![1.0_f32; h.len()];
    for &c in fl.order.iter().rev() {
        let value = acc[c];
        let t = flow.fraction[c];
        if flow.first[c] != usize::MAX {
            acc[flow.first[c]] += value * (1.0 - t);
        }
        if flow.second[c] != usize::MAX {
            acc[flow.second[c]] += value * t;
        }
    }
    let importance: Vec<_> = acc
        .iter()
        .map(|&a| smooth(((a as f64 * cell * cell / (motif * motif)).sqrt() - 0.10) / 0.30))
        .collect();
    let mut seeds: Vec<_> = importance
        .iter()
        .enumerate()
        .map(|(i, &a)| if a > 0.0 { i } else { usize::MAX })
        .collect();
    let mut next = seeds.clone();
    let score = |c: usize, seed: usize| -> f64 {
        if seed == usize::MAX {
            return 0.0;
        }
        let distance =
            ((c % n).abs_diff(seed % n) as f64).hypot((c / n).abs_diff(seed / n) as f64) * cell;
        let width = motif * (0.008 + 0.065 * importance[seed].sqrt()) * erosion.sqrt();
        amplitude * 0.90 * erosion * importance[seed] * (1.0 - smooth(distance / width))
    };
    // Jump flooding propagates the strongest physical river-bank profile.
    // The same bounded schedule and Euclidean distance are used on the GPU.
    let mut jump = n.next_power_of_two() / 2;
    let mut steps = Vec::new();
    while jump > 0 {
        steps.push(jump);
        jump /= 2;
    }
    steps.extend([1, 1]);
    for jump in steps {
        for c in 0..h.len() {
            let mut best = seeds[c];
            let mut value = score(c, best);
            for &(dx, dy) in &D8 {
                let x = (c % n) as isize + dx * jump as isize;
                let y = (c / n) as isize + dy * jump as isize;
                if x < 0 || y < 0 || x >= n as isize || y >= n as isize {
                    continue;
                }
                let seed = seeds[y as usize * n + x as usize];
                let candidate = score(c, seed);
                if candidate > value || (candidate == value && seed < best) {
                    value = candidate;
                    best = seed;
                }
            }
            next[c] = best;
        }
        std::mem::swap(&mut seeds, &mut next);
    }
    for (c, value) in h.iter_mut().enumerate() {
        *value -= score(c, seeds[c]) as f32;
    }
}

fn erode_with(h: &mut [f32], n: usize, cell: f64, erosion: f64, talus: f64, tuning: &ShapeErosion) {
    if erosion == 0.0 {
        return;
    }
    // Move the fixed simulation border outside the displayed map. Extrapolate its
    // slope rather than adding a raised/lowered rim that would divert drainage.
    let coarse_n = n.min(tuning.coarse);
    let padding = 12;
    let padded_n = coarse_n + padding * 2;
    let ratio = n as f64 / coarse_n as f64;
    let mut coarse = vec![0.0_f32; padded_n * padded_n];
    for y in 0..padded_n {
        for x in 0..padded_n {
            coarse[y * padded_n + x] = sample_extended(
                h,
                n,
                (x as f64 - padding as f64 + 0.5) * ratio - 0.5,
                (y as f64 - padding as f64 + 0.5) * ratio - 0.5,
            ) as f32;
        }
    }
    let original = coarse.clone();
    if let Some(amplitude) = tuning.canyon_amplitude {
        canyon_cut(
            &mut coarse,
            padded_n,
            cell * ratio,
            erosion,
            tuning.motif,
            amplitude,
        );
    }
    erode_shape_coarse(&mut coarse, padded_n, cell * ratio, erosion, talus, tuning);
    for (value, baseline) in coarse.iter_mut().zip(original) {
        *value -= baseline;
    }
    for y in 0..n {
        for x in 0..n {
            let change = sample_delta(
                &coarse,
                padded_n,
                (x as f64 + 0.5) / ratio - 0.5 + padding as f64,
                (y as f64 + 0.5) / ratio - 0.5 + padding as f64,
            );
            h[y * n + x] = (h[y * n + x] as f64 + change) as f32;
        }
    }
}

fn erode_shape_coarse(
    h: &mut [f32],
    n: usize,
    cell: f64,
    erosion: f64,
    talus: f64,
    tuning: &ShapeErosion,
) {
    let grid = Grid::new(n);
    let strength = erosion * tuning.gain;
    let mut order: Vec<_> = (0..h.len()).collect();
    let mut acc = vec![1.0_f32; h.len()];
    for _ in 0..tuning.iterations {
        order.sort_unstable_by(|&a, &b| h[a].total_cmp(&h[b]).then(a.cmp(&b)));
        let mut receiver = vec![usize::MAX; h.len()];
        for c in 0..h.len() {
            if grid.borders[c] {
                continue;
            }
            let mut best = 0.0;
            for (d, &distance) in DIST.iter().enumerate() {
                let r = grid.neighbor(c, d).unwrap();
                let slope = (h[c] as f64 - h[r] as f64) / distance;
                if slope > best {
                    best = slope;
                    receiver[c] = r;
                }
            }
        }
        // Strict physical descent: closed bowls stay closed instead of acquiring
        // artificial breach trenches on hills. The same D-infinity split is used on GPU.
        let fl = Flood {
            filled: h.to_vec(),
            receiver,
            order: order.clone(),
        };
        let flow = continuous_flow(&fl, &grid);
        acc.fill(1.0);
        for &c in order.iter().rev() {
            let r = flow.first[c];
            let s = flow.second[c];
            let t = flow.fraction[c];
            if r != usize::MAX {
                acc[r] += acc[c] * (1.0 - t);
            }
            if s != usize::MAX {
                acc[s] += acc[c] * t;
            }
        }
        let baseline = h.to_vec();
        for &c in &order {
            let r = flow.first[c];
            let s = flow.second[c];
            let t = flow.fraction[c] as f64;
            if r == usize::MAX || grid.borders[c] {
                continue;
            }
            let lower = if s == usize::MAX {
                h[r] as f64
            } else {
                (1.0 - t) * h[r] as f64 + t * h[s] as f64
            };
            let original_lower = if s == usize::MAX {
                baseline[r] as f64
            } else {
                (1.0 - t) * baseline[r] as f64 + t * baseline[s] as f64
            };
            let distance = flow.distance[c] as f64;
            let slope = ((baseline[c] as f64 - original_lower) / (cell * distance)).max(0.0);
            // Catchment is physical and slope response follows the relief's talus.
            // Gentle hills keep legible gullies without forced flat-basin trenches.
            let threshold = talus * 0.10;
            let response = 0.08 + 0.92 * slope * slope / (slope * slope + threshold * threshold);
            let factor = (strength
                * 0.40
                * (acc[c] as f64 * cell * cell / (0.004 * tuning.motif * tuning.motif))
                    .sqrt()
                    .min(4.0)
                * response
                / distance)
                .min(4.0);
            h[c] = (h[c] as f64).min((h[c] as f64 + factor * lower) / (1.0 + factor)) as f32;
        }
        thermal(h, &grid, cell, talus, 1, (erosion * 0.09).min(0.3));
        let channels: Vec<_> = acc.iter().map(|&a| a > (n * n) as f32 * 0.001).collect();
        diffuse(h, n, &channels, (erosion * 0.025).min(0.1));
    }
}

fn surface_resolution(width: f64, motif: f64) -> usize {
    ((width / motif * 96.0).ceil() as usize).clamp(640, 1024)
}

/// Scalar schedule shared with the browser GPU adapter. Cell size is physical;
/// the padded border does not impose a flat/zero rim on the visible region.
pub(crate) fn surface_parameters(width: f64, motif: f64, erosion: f64, talus: f64) -> [f32; 8] {
    let coarse = surface_resolution(width, motif);
    let n = coarse + 24;
    let cell = width / coarse as f64;
    [
        n as f32,
        cell as f32,
        (-12.0 * cell) as f32,
        12.0,
        talus as f32,
        (erosion * 0.1125) as f32,
        (erosion * 0.40 * cell / (0.004_f64.sqrt() * motif)) as f32,
        (erosion * 0.025).min(0.1) as f32,
    ]
}
