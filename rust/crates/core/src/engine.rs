//! Retained physical terrain. Camera sampling never reruns erosion or changes the seed.
//! Regional relief reuses an aperiodically mapped erosion source in this prototype;
//! analytic world noise and finite features are evaluated at fixed physical scales.
use crate::{CavernShape, Noise, Relief, Rng, Terrain, generate_motif, smooth};

const SOURCE_N: usize = 512;

pub struct TerrainGenerator {
    map_width: f64,
    motif: f64,
    relief: Relief,
    erosion: f64,
    source: Surface,
    delta: Surface,
    noise: Noise,
    noise2: Noise,
    down: (f64, f64),
    valley_offset: f64,
    valley_floor: f64,
    phase: f64,
    amp: f64,
    max_height: f64,
    cave: Option<CavernShape>,
}

impl TerrainGenerator {
    pub fn new(
        seed: &str,
        map_width: f64,
        relief: &str,
        erosion: f64,
        motif: f64,
    ) -> Result<Self, String> {
        if !map_width.is_finite() || !(500.0..=100000.0).contains(&map_width) {
            return Err("La largeur doit être comprise entre 500 et 100 000 mètres.".into());
        }
        if !motif.is_finite() || !(250.0..=50000.0).contains(&motif) {
            return Err("La taille du motif doit être comprise entre 250 et 50 000 mètres.".into());
        }
        if !erosion.is_finite() || !(0.0..=1.0).contains(&erosion) {
            return Err("Le niveau d’érosion doit être compris entre 0 et 1.".into());
        }
        let kind = Relief::parse(relief)?;
        let erosion = if kind == Relief::Cavern { 0.0 } else { erosion };
        let source_relief = if kind == Relief::Valley {
            "hills"
        } else {
            relief
        };
        let mut prepared = generate_motif(seed, motif, source_relief, erosion, SOURCE_N)?;
        let amp = kind.amplitude(motif);
        if kind == Relief::Valley {
            let scale = amp / Relief::Hills.amplitude(motif);
            for value in &mut prepared.height {
                *value *= scale as f32;
            }
        }
        if kind == Relief::Cavern {
            // Cache the continuous floor independently from the analytically sampled walls.
            for (i, value) in prepared.height.iter_mut().enumerate() {
                *value -= prepared.cave_mask[i] as f32 * amp as f32;
            }
        }
        let delta = if matches!(kind, Relief::Flat | Relief::Canyon) && erosion > 0.0 {
            let initial = generate_motif(seed, motif, source_relief, 0.0, SOURCE_N)?;
            prepared
                .height
                .iter()
                .zip(initial.height)
                .map(|(&h, base)| h - base)
                .collect()
        } else {
            Vec::new()
        };
        let root = Rng::new(&format!("burgmap:{seed}")).fork("terrain");
        let noise = Noise::new(root.fork("noise"));
        let noise2 = Noise::new(root.fork("noise2"));
        let mut params = root.fork("params");
        let side = [(0.0, -1.0), (1.0, 0.0), (0.0, 1.0), (-1.0, 0.0)]
            [(params.float() * 4.0).floor() as usize];
        let angle = params.range(-0.3, 0.3);
        let down = (
            side.0 * angle.cos() - side.1 * angle.sin(),
            side.0 * angle.sin() + side.1 * angle.cos(),
        );
        let phase = params.range(0.0, 1000.0);
        let valley_floor = params.range(180.0, 320.0) * motif / 2400.0;
        let valley_offset = params.range(-0.08, 0.08) * motif;
        let source_max = prepared.height.iter().copied().fold(0.0_f32, f32::max) as f64;
        let limit = match kind {
            Relief::Flat => 80.0,
            Relief::Hills => 500.0,
            Relief::Valley => 1500.0,
            Relief::Canyon => 2500.0,
            Relief::Mountains => 3500.0,
            Relief::Plateau => 2400.0,
            Relief::HighMountains => 7000.0,
            Relief::Volcano | Relief::Caldera => 5000.0,
            Relief::Cavern => 240.0,
        };
        let estimated = if kind == Relief::Cavern {
            source_max + amp + 2.0
        } else {
            source_max * 1.6 + amp * 0.5 + 10.0
        };
        let cave = (kind == Relief::Cavern).then(|| CavernShape::new(root.fork("cavern")));
        Ok(Self {
            map_width,
            motif,
            relief: kind,
            erosion,
            source: Surface::new(prepared.height),
            delta: Surface::new(delta),
            noise,
            noise2,
            down,
            valley_offset,
            valley_floor,
            phase,
            amp,
            max_height: estimated.min(limit),
            cave,
        })
    }

    pub fn width(&self) -> f64 {
        self.map_width
    }
    pub fn motif_size(&self) -> f64 {
        self.motif
    }
    pub fn min_height(&self) -> f64 {
        0.3
    }
    pub fn max_height(&self) -> f64 {
        self.max_height
    }

    pub fn sample_region(
        &self,
        x: f64,
        y: f64,
        extent: f64,
        resolution: usize,
    ) -> Result<Terrain, String> {
        if !x.is_finite()
            || !y.is_finite()
            || !extent.is_finite()
            || extent <= 0.0
            || x < 0.0
            || y < 0.0
            || x + extent > self.map_width + 0.0001
            || y + extent > self.map_width + 0.0001
        {
            return Err("La région doit être un carré fini à l’intérieur de la carte.".into());
        }
        if !(64..=1024).contains(&resolution) {
            return Err("La résolution doit être comprise entre 64 et 1 024.".into());
        }
        let count = resolution * resolution;
        let mut height = vec![0.0_f32; count];
        let mut cave_mask = if self.cave.is_some() {
            vec![1; count]
        } else {
            Vec::new()
        };
        let mut normal_x = vec![0.0_f32; count];
        let mut normal_y = vec![0.0_f32; count];
        let mut normal_z = vec![0.0_f32; count];
        let cell = extent / resolution as f64;
        let epsilon = (self.motif / SOURCE_N as f64).max(cell * 0.5);
        let mut min = f32::INFINITY;
        let mut max = f32::NEG_INFINITY;
        for row in 0..resolution {
            for col in 0..resolution {
                let wx = x + (col as f64 + 0.5) * cell;
                let wy = y + (row as f64 + 0.5) * cell;
                let i = row * resolution + col;
                let rock = self.rock_at(wx, wy);
                let h = self.height_at(wx, wy, cell) + if rock == 1 { self.amp } else { 0.0 };
                height[i] = h.clamp(0.3, self.max_height) as f32;
                if !cave_mask.is_empty() {
                    cave_mask[i] = rock;
                }
                // Shade the same filtered surface as the contours, not subpixel gullies.
                let gx = (self.height_at(wx + epsilon, wy, cell)
                    - self.height_at(wx - epsilon, wy, cell))
                    / (2.0 * epsilon);
                let gy = (self.height_at(wx, wy + epsilon, cell)
                    - self.height_at(wx, wy - epsilon, cell))
                    / (2.0 * epsilon);
                let norm = (1.0 + gx * gx + gy * gy).sqrt();
                normal_x[i] = (-gx / norm) as f32;
                normal_y[i] = (-gy / norm) as f32;
                normal_z[i] = (1.0 / norm) as f32;
                min = min.min(height[i]);
                max = max.max(height[i]);
            }
        }
        Ok(Terrain {
            x,
            y,
            width: extent,
            resolution,
            min_height: min,
            max_height: max,
            height,
            cave_mask,
            normal_x,
            normal_y,
            normal_z,
        })
    }

    fn rock_at(&self, x: f64, y: f64) -> u8 {
        let Some(cave) = &self.cave else {
            return 0;
        };
        let px = (x - self.map_width * 0.5) / self.motif + 0.5;
        let py = (y - self.map_width * 0.5) / self.motif + 0.5;
        cave.rock(px, py, self.motif, 0.0, &self.noise)
    }

    fn height_at(&self, x: f64, y: f64, footprint: f64) -> f64 {
        let fbm = |noise: &Noise, x: f64, y: f64, wavelength: f64, octaves: usize| {
            noise.fbm_filtered(
                x / wavelength,
                y / wavelength,
                octaves,
                0.5,
                footprint / wavelength,
            )
        };
        let scale = self.motif / 2400.0;
        let rough = fbm(&self.noise, x + self.phase, y, 720.0 * scale, 4);
        let height = match self.relief {
            Relief::Plateau | Relief::Volcano | Relief::Caldera | Relief::Cavern => {
                let px = (x - self.map_width * 0.5) / self.motif + 0.5;
                let py = (y - self.map_width * 0.5) / self.motif + 0.5;
                let edge = px.min(1.0 - px).min(py).min(1.0 - py);
                let weight = smoother(edge / 0.055);
                let background = if self.relief == Relief::Cavern {
                    self.amp * (0.08 + 0.065 * fbm(&self.noise2, x, y, 480.0 * scale, 3))
                } else {
                    self.amp * (0.07 + 0.035 * rough)
                };
                let local = self.source.sample(px, py, footprint / self.motif);
                background * (1.0 - weight) + local * weight
            }
            Relief::Flat => {
                let swell = self.noise.fbm_filtered(
                    (x + self.phase) / (1200.0 * scale),
                    y / (1200.0 * scale),
                    4,
                    0.42,
                    footprint / (1200.0 * scale),
                );
                self.amp * (0.45 + 0.275 * swell + 0.065 * rough)
                    + self.regional(&self.delta, x, y, footprint)
            }
            Relief::Canyon => {
                let along = (x - self.map_width * 0.5) * self.down.0
                    + (y - self.map_width * 0.5) * self.down.1;
                let across = -(x - self.map_width * 0.5) * self.down.1
                    + (y - self.map_width * 0.5) * self.down.0;
                let meander = 180.0
                    * scale
                    * fbm(
                        &self.noise,
                        along + self.phase,
                        0.37 * 1680.0 * scale,
                        1680.0 * scale,
                        3,
                    )
                    + 43.2
                        * scale
                        * fbm(&self.noise2, along, 4.1 * 528.0 * scale, 528.0 * scale, 3)
                    + 14.0 * scale * fbm(&self.noise, along, 7.1 * 170.0 * scale, 170.0 * scale, 2);
                let distance = (across + meander - self.valley_offset).abs();
                let floor = self.motif * (0.025 + self.erosion * 0.025);
                let wall =
                    smooth((distance - floor) / (self.motif * (0.045 + self.erosion * 0.055)));
                let shelf = wall * 0.92
                    + smooth((wall - 0.30) / 0.07) * 0.025
                    + smooth((wall - 0.69) / 0.06) * 0.055;
                let tributary = self.noise2.ridged_filtered(
                    (x + self.phase) / (290.0 * scale),
                    y / (290.0 * scale),
                    4,
                    footprint / (290.0 * scale),
                );
                let rock = fbm(&self.noise, x, y, 95.0 * scale, 3);
                self.amp
                    * (0.09 + 0.78 * shelf + 0.08 * rough * wall
                        - 0.07 * tributary * wall * (1.0 - 0.6 * wall)
                        + 0.014 * rock * wall)
                    + self.regional(&self.delta, x, y, footprint) * wall
            }
            Relief::Hills | Relief::Mountains | Relief::HighMountains | Relief::Valley => {
                let variation = fbm(
                    &self.noise,
                    x + 9.7 * self.motif * 1.8,
                    y,
                    self.motif * 1.8,
                    3,
                );
                let terrain = self.regional(&self.source, x, y, footprint)
                    * (1.0 + 0.22 * variation)
                    + self.amp * (0.15 + 0.11 * rough);
                let wavelength = self.motif / 160.0;
                let detail_amp =
                    (self.amp * 0.008).min(wavelength * 0.14) / (1.0 + self.erosion * 1.4);
                let detail = detail_amp * fbm(&self.noise2, x, y, wavelength, 3);
                if self.relief == Relief::Valley {
                    let along = (x - self.map_width * 0.5) * self.down.0
                        + (y - self.map_width * 0.5) * self.down.1;
                    let across = -(x - self.map_width * 0.5) * self.down.1
                        + (y - self.map_width * 0.5) * self.down.0;
                    let meander = 320.0
                        * scale
                        * fbm(
                            &self.noise,
                            along + self.phase,
                            0.37 * 2600.0 * scale,
                            2600.0 * scale,
                            2,
                        )
                        + 120.0
                            * scale
                            * fbm(&self.noise2, along, 5.1 * 900.0 * scale, 900.0 * scale, 2);
                    let wall = smooth(
                        ((across + meander - self.valley_offset).abs() - self.valley_floor)
                            / (self.motif * 0.42),
                    );
                    self.amp * 0.045 + (terrain + detail) * (0.055 + 0.945 * wall.powf(1.25))
                } else {
                    terrain + detail
                }
            }
        };
        height.clamp(0.3, self.max_height)
    }

    fn regional(&self, field: &Surface, x: f64, y: f64, footprint: f64) -> f64 {
        // Continuous world coordinates without modulo or tile blending. The old
        // repeated source exposed its motif-sized lattice even with zero erosion.
        let wavelength = self.motif * 1.2;
        // Keep the coordinate map fixed at every LOD: filtering these coordinates
        // would move whole hills as the camera zooms. Only filter the sampled field.
        let u = 0.5 + 0.44 * self.noise2.fbm(x / wavelength + 11.3, y / wavelength, 2);
        let v = 0.5
            + 0.44
                * self
                    .noise2
                    .fbm(x / wavelength - 4.7, y / wavelength + 2.9, 2);
        // Account conservatively for coordinate deformation when selecting a mip.
        field.sample(u, v, footprint * 2.0 / self.motif)
    }
}

fn smoother(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

// Positive cubic B-splines interpolate the prepared physical raster without grid creases or overshoot.
fn sample_c2(field: &[f32], n: usize, fx: f64, fy: f64) -> f64 {
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
    let mut value = 0.0;
    for (j, &weight_y) in wy.iter().enumerate() {
        let row = (y + j as isize - 1).clamp(0, n as isize - 1) as usize;
        for (i, &weight_x) in wx.iter().enumerate() {
            let col = (x + i as isize - 1).clamp(0, n as isize - 1) as usize;
            value += field[row * n + col] as f64 * weight_x * weight_y;
        }
    }
    value
}

// Box-filtered physical source pyramid. Heights, normals and contours share the
// same smoothly interpolated level, including finite features and erosion deltas.
struct Surface {
    levels: Vec<Vec<f32>>,
}

impl Surface {
    fn new(field: Vec<f32>) -> Self {
        if field.is_empty() {
            return Self { levels: Vec::new() };
        }
        let mut levels = vec![field];
        let mut n = SOURCE_N;
        while n > 1 {
            let previous = levels.last().unwrap();
            let half = n / 2;
            let mut next = vec![0.0; half * half];
            for y in 0..half {
                for x in 0..half {
                    let i = 2 * y * n + 2 * x;
                    next[y * half + x] =
                        (previous[i] + previous[i + 1] + previous[i + n] + previous[i + n + 1])
                            * 0.25;
                }
            }
            levels.push(next);
            n = half;
        }
        Self { levels }
    }

    fn sample(&self, u: f64, v: f64, footprint: f64) -> f64 {
        if self.levels.is_empty() {
            return 0.0;
        }
        let lod = (footprint * SOURCE_N as f64)
            .max(1.0)
            .log2()
            .min((self.levels.len() - 1) as f64);
        let lower = lod.floor() as usize;
        let upper = (lower + 1).min(self.levels.len() - 1);
        let at = |level: usize| {
            let n = SOURCE_N >> level;
            sample_c2(
                &self.levels[level],
                n,
                u * n as f64 - 0.5,
                v * n as f64 - 0.5,
            )
        };
        let t = lod - lower as f64;
        at(lower) * (1.0 - t) + at(upper) * t
    }
}
