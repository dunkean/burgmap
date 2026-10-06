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

// Keep the lower half of the control; make its upper half substantially stronger.
fn erosion_strength(erosion: f64) -> f64 {
    erosion + 32.0 * (erosion - 0.5).max(0.0).powi(3)
}

fn neighbor(i: usize, n: usize, d: usize) -> Option<usize> {
    let x = i % n;
    let y = i / n;
    let (dx, dy) = D8[d];
    let nx = x as isize + dx;
    let ny = y as isize + dy;
    (nx >= 0 && ny >= 0 && nx < n as isize && ny < n as isize)
        .then_some((ny * n as isize + nx) as usize)
}

fn border(i: usize, n: usize) -> bool {
    let x = i % n;
    let y = i / n;
    x == 0 || y == 0 || x == n - 1 || y == n - 1
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

fn flood(h: &[f32], n: usize) -> Flood {
    let mut fl = Flood {
        filled: vec![0.0; h.len()],
        receiver: vec![usize::MAX; h.len()],
        order: Vec::with_capacity(h.len()),
    };
    let mut closed = vec![false; h.len()];
    let mut heap = MinHeap(Vec::with_capacity(h.len()));
    for i in 0..h.len() {
        if border(i, n) {
            closed[i] = true;
            fl.filled[i] = h[i];
            heap.push(i, h[i]);
        }
    }
    while let Some(c) = heap.pop() {
        fl.order.push(c);
        for d in 0..8 {
            if let Some(r) = neighbor(c, n, d) {
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
            if let Some(r) = neighbor(c, n, d) {
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

fn continuous_flow(fl: &Flood, n: usize) -> Flow {
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
            let Some(a) = neighbor(c, n, d) else {
                continue;
            };
            let Some(b) = neighbor(c, n, (d + 1) & 7) else {
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

fn resolve_pits(h: &mut [f32], fl: &Flood, n: usize, cell: f64, frac: f64) -> usize {
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
                if let Some(r) = neighbor(c, n, d)
                    && component[r] == usize::MAX
                    && fl.filled[r] - h[r] > 0.05
                {
                    component[r] = start;
                    stack.push(r);
                }
            }
        }
        let bottom = cells.iter().map(|&c| h[c]).fold(f32::INFINITY, f32::min) as f64;
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
        let level = bottom + frac * (spill - bottom);
        for &c in &cells {
            if (h[c] as f64) < spill {
                h[c] = (h[c] as f64 + frac * (spill - h[c] as f64)) as f32;
            }
        }
        let mut current = (h[pour] as f64).min(level);
        h[pour] = current as f32;
        let mut r = fl.receiver[pour];
        for _ in 0..400 {
            if r == usize::MAX {
                break;
            }
            current = (current - 0.01 * cell).max(0.5);
            if h[r] as f64 <= current {
                break;
            }
            h[r] = current as f32;
            r = fl.receiver[r];
        }
        resolved += 1;
    }
    resolved
}

pub(crate) fn thermal(h: &mut [f32], n: usize, cell: f64, talus: f64, passes: usize, rate: f64) {
    let mut delta = vec![0.0_f64; h.len()];
    for _ in 0..passes {
        delta.fill(0.0);
        for i in 0..h.len() {
            if border(i, n) {
                continue;
            }
            let mut excess = [0.0_f64; 8];
            let (mut total, mut maximum) = (0.0_f64, 0.0_f64);
            for (d, &step) in DIST.iter().enumerate() {
                if let Some(r) = neighbor(i, n, d) {
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
                        delta[neighbor(i, n, d).unwrap()] += movement * weight / total;
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
    pub noise: &'a Noise,
    pub noise2: &'a Noise,
    pub down: (f64, f64),
    pub k: f64,
    pub iterations: usize,
    pub coarse: usize,
    pub talus: f64,
    pub detail: f64,
    pub diffusion: f64,
    pub valley: Option<(f64, f64, f64)>,
    pub erosion: f64,
}

pub(crate) fn mountain(cfg: &MountainCfg<'_>) -> Vec<f32> {
    let n = cfg.n;
    let nc = cfg.coarse;
    let count = nc * nc;
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
            let env = cfg
                .noise
                .fbm(px / env_wavelength + 3.1, py / env_wavelength - 1.7, 3);
            let q = ((px - cfg.width * 0.5) * cfg.down.0 + (py - cfg.width * 0.5) * cfg.down.1)
                / cfg.width;
            let edge = x.min(y).min(nc - 1 - x).min(nc - 1 - y) as f64 / (0.1 * nc as f64);
            let u = (0.7 + 0.5 * env - 0.55 * q).max(0.12);
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
                        * cfg
                            .noise2
                            .fbm(px / initial_wavelength, py / initial_wavelength, 3)))
                as f32;
        }
    }
    for (i, value) in h.iter_mut().enumerate() {
        if border(i, nc) {
            *value = 0.0;
        }
    }
    let uplift_step = cfg.amp * 1.25 / cfg.iterations as f64;
    let strength = erosion_strength(cfg.erosion);
    let incision = strength * 2.0 / (0.004 * count as f64).sqrt();
    let mut acc = vec![1.0_f32; count];
    let mut channels = vec![false; count];
    for _ in 0..cfg.iterations {
        for i in 0..count {
            if !border(i, nc) {
                h[i] = (h[i] as f64 + uplift[i] as f64 * uplift_step) as f32;
            }
        }
        if cfg.erosion > 0.0 {
            let fl = flood(&h, nc);
            resolve_pits(&mut h, &fl, nc, cc, (cfg.erosion * 1.2).min(0.85));
            let flow = continuous_flow(&fl, nc);
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
                let factor = (incision * (acc[c] as f64).sqrt() / flow.distance[c] as f64).min(6.0);
                h[c] = (h[c] as f64).min((h[c] as f64 + factor * lower) / (1.0 + factor)) as f32;
            }
            thermal(&mut h, nc, cc, cfg.talus, 3, (cfg.erosion * 0.9).min(0.8));
            for i in 0..count {
                channels[i] = acc[i] as f64 >= count as f64 * 0.001;
            }
            let diffusion = cfg.diffusion * 3.0 * strength * 2.0;
            for _ in 0..diffusion.floor() as usize {
                diffuse(&mut h, nc, &channels, 0.5);
            }
            if diffusion.fract() > 0.0 {
                diffuse(&mut h, nc, &channels, 0.5 * diffusion.fract());
            }
        }
        for (i, value) in h.iter_mut().enumerate() {
            if border(i, nc) {
                *value = 0.0;
            }
        }
    }
    for value in &mut h {
        *value = value.max(0.0);
    }
    if cfg.erosion > 0.0 {
        thermal(&mut h, nc, cc, cfg.talus * 0.95, 4, strength * 0.8);
        for _ in 0..2 {
            let fl = flood(&h, nc);
            if resolve_pits(&mut h, &fl, nc, cc, cfg.erosion.min(0.85)) == 0 {
                break;
            }
        }
        diffuse(&mut h, nc, &channels, cfg.erosion.min(0.8));
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
                    * cfg
                        .noise2
                        .fbm(px / warp_wavelength + 11.3, py / warp_wavelength, 2);
            let wy = py
                + warp
                    * cfg
                        .noise2
                        .fbm(px / warp_wavelength - 4.7, py / warp_wavelength + 2.9, 2);
            let i = y * n + x;
            drainage_weight[i] =
                1.0 - 0.85 * smooth((drainage - 4.0) / (count as f64 * 0.001 - 4.0).max(12.0));
            output[i] = sample(&h, nc, (wx - x0) / cc - 0.5, (wy - x0) / cc - 0.5, true) as f32;
            if (x + y * 7) & 15 == 0 {
                samples.push(output[i]);
            }
        }
    }
    samples.sort_unstable_by(f32::total_cmp);
    let p99 = samples[(samples.len() as f64 * 0.99).floor() as usize].max(0.0001) as f64;
    // Full p99 normalization used to undo the loss of relief at strong erosion.
    let worn_amplitude = cfg.amp / (1.0 + 0.35 * (strength - cfg.erosion));
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
            let detail = (cfg.noise2.ridged(px / wavelength, py / wavelength, octaves) - 0.5)
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
    if erosion == 0.0 {
        return;
    }
    // Move the fixed simulation border outside the displayed map. Extrapolate its
    // slope rather than adding a raised/lowered rim that would divert drainage.
    let coarse_n = n.min(320);
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
    erode_shape_coarse(&mut coarse, padded_n, cell * ratio, erosion, talus);
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

fn erode_shape_coarse(h: &mut [f32], n: usize, cell: f64, erosion: f64, talus: f64) {
    let strength = erosion_strength(erosion);
    let iterations = (12.0 * erosion + 4.0 * (strength - erosion)).ceil() as usize;
    let mut order: Vec<_> = (0..h.len()).collect();
    let mut fractions = vec![[0.0_f32; 8]; h.len()];
    let mut acc = vec![1.0_f32; h.len()];
    for _ in 0..iterations {
        order.sort_unstable_by(|&a, &b| h[a].total_cmp(&h[b]).then(a.cmp(&b)));
        acc.fill(1.0);
        // Spread actual downhill drainage over all contributing neighbors. No
        // forced flood gradients or single receiver paths on gentle plains.
        for &c in &order {
            let mut weights = [0.0_f64; 8];
            let mut total = 0.0;
            for (d, &distance) in DIST.iter().enumerate() {
                if let Some(r) = neighbor(c, n, d) {
                    weights[d] = ((h[c] as f64 - h[r] as f64) / distance).max(0.0).powf(1.1);
                    total += weights[d];
                }
            }
            for (fraction, weight) in fractions[c].iter_mut().zip(weights) {
                *fraction = if total > 0.0 {
                    (weight / total) as f32
                } else {
                    0.0
                };
            }
        }
        for &c in order.iter().rev() {
            for (d, &weight) in fractions[c].iter().enumerate() {
                if weight > 0.0 {
                    acc[neighbor(c, n, d).unwrap()] += acc[c] * weight;
                }
            }
        }
        for &c in &order {
            if border(c, n) {
                continue;
            }
            let (mut lower, mut distance) = (0.0, 0.0);
            for (d, &weight) in fractions[c].iter().enumerate() {
                if weight > 0.0 {
                    lower += h[neighbor(c, n, d).unwrap()] as f64 * weight as f64;
                    distance += DIST[d] * weight as f64;
                }
            }
            if distance == 0.0 || lower >= h[c] as f64 {
                continue;
            }
            let factor = (strength * 0.07 * (acc[c] as f64).sqrt() / distance).min(4.0);
            h[c] = ((h[c] as f64 + factor * lower) / (1.0 + factor)) as f32;
        }
        thermal(h, n, cell, talus, 1, (strength * 0.35).min(0.8));
        let channels: Vec<_> = acc.iter().map(|&a| a > (n * n) as f32 * 0.001).collect();
        diffuse(h, n, &channels, (strength * 0.18).min(0.65));
    }
}
