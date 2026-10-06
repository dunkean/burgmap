//! Retained physical terrain. Camera sampling never reruns erosion or changes the seed.
//! Regional erosion is prepared in geographic coordinates across the map;
//! analytic world noise and finite features are evaluated at fixed physical scales.
use crate::{
    CavernShape, FiniteShape, Noise, PreparedTerrain, Relief, Rng, Terrain, canyon::Canyon,
    channels::Channels, erosion::erode_walls, generate_motif, smooth,
};

const SOURCE_N: usize = 1024;

pub struct TerrainGenerator {
    map_width: f64,
    motif: f64,
    relief: Relief,
    erosion: f64,
    source: Surface,
    delta: Surface,
    background: Surface,
    feature: Option<FiniteShape>,
    canyon: Option<Canyon>,
    noise: Noise,
    noise2: Noise,
    down: (f64, f64),
    channels: Channels,
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
        Self::new_mixed(seed, map_width, relief, erosion, motif, 0.5)
    }

    pub fn new_mixed(
        seed: &str,
        map_width: f64,
        relief: &str,
        erosion: f64,
        motif: f64,
        mountain_mix: f64,
    ) -> Result<Self, String> {
        if seed.len() > 4096 {
            return Err("La graine ne doit pas dépasser 4 096 octets.".into());
        }
        if !mountain_mix.is_finite() || !(0.0..=1.0).contains(&mountain_mix) {
            return Err("La proportion de montagnes doit être comprise entre 0 et 1.".into());
        }
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
        let mountain_mix = if kind == Relief::Mixed {
            mountain_mix
        } else {
            0.5
        };
        let erosion = if kind == Relief::Cavern { 0.0 } else { erosion };
        let finite = matches!(
            kind,
            Relief::Plateau | Relief::Volcano | Relief::Caldera | Relief::Cavern
        );
        let source_relief = if matches!(kind, Relief::Valley | Relief::Canyon) {
            "mixed"
        } else {
            relief
        };
        let source_width = if finite || kind == Relief::Flat {
            motif
        } else {
            map_width
        };
        let source_erosion = if kind == Relief::Flat {
            erosion * erosion
        } else {
            erosion
        };
        let prepared = if kind == Relief::Cavern {
            // Cave geometry is continuous and sampled analytically, without an unused raster.
            PreparedTerrain::default()
        } else {
            generate_motif(
                seed,
                source_width,
                source_relief,
                source_erosion,
                SOURCE_N,
                motif,
                mountain_mix,
            )?
        };
        let amp = kind.mixed_amplitude(motif, mountain_mix);
        let background = if finite && kind != Relief::Cavern {
            generate_motif(seed, map_width, "mixed", erosion, SOURCE_N, motif, 0.5)?
        } else {
            PreparedTerrain::default()
        };
        let delta = if kind == Relief::Flat && erosion > 0.0 {
            let initial = generate_motif(
                seed,
                motif,
                source_relief,
                0.0,
                SOURCE_N,
                motif,
                mountain_mix,
            )?;
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
        let _valley_floor = params.range(180.0, 320.0) * motif / 2400.0;
        let valley_offset = params.range(-0.08, 0.08) * motif;
        let source_max = prepared.height.iter().copied().fold(0.0_f32, f32::max) as f64;
        let limit = match kind {
            Relief::Flat => 80.0,
            Relief::Hills => 500.0,
            Relief::Valley => 1500.0,
            Relief::Canyon => 2500.0,
            Relief::Mountains | Relief::Mixed => 3500.0,
            Relief::Plateau => 2400.0,
            Relief::HighMountains => 7000.0,
            Relief::Volcano | Relief::Caldera => 5000.0,
            Relief::Cavern => 240.0,
        };
        let background_max = background.height.iter().copied().fold(0.0_f32, f32::max) as f64;
        let estimated = if kind == Relief::Flat {
            amp * 2.0 + 10.0
        } else if kind == Relief::Cavern {
            amp * 1.2 + 2.0
        } else {
            source_max * 1.6 + background_max + amp * 0.5 + 10.0
        };
        let cave = (kind == Relief::Cavern).then(|| CavernShape::new(root.fork("cavern")));
        let channels = Channels::new(motif, phase, valley_offset, map_width, &noise, &noise2);
        let feature = FiniteShape::new(kind, motif, &root);
        let canyon =
            (kind == Relief::Canyon).then(|| Canyon::new(motif, phase, map_width, &noise, &noise2));
        let mut result = Self {
            map_width,
            motif,
            relief: kind,
            erosion,
            source: Surface::new(prepared.height),
            delta: Surface::new(delta),
            background: Surface::new(background.height),
            feature,
            canyon,
            noise,
            noise2,
            down,
            channels,
            phase,
            amp,
            max_height: estimated.min(limit),
            cave,
        };
        if kind == Relief::Canyon && erosion > 0.0 {
            // Evolve the actual tortuous canyon, not an unrelated projected erosion raster.
            let mut initial = vec![0.0; SOURCE_N * SOURCE_N];
            let cell = map_width / SOURCE_N as f64;
            for y in 0..SOURCE_N {
                for x in 0..SOURCE_N {
                    initial[y * SOURCE_N + x] =
                        result.height_at((x as f64 + 0.5) * cell, (y as f64 + 0.5) * cell, cell)
                            as f32;
                }
            }
            let mut worn = initial.clone();
            erode_walls(&mut worn, SOURCE_N, cell, erosion, 0.40);
            for y in 0..SOURCE_N {
                for x in 0..SOURCE_N {
                    let wx = (x as f64 + 0.5) * cell;
                    let wy = (y as f64 + 0.5) * cell;
                    let (a, c) = result.channel_coordinates(wx, wy);
                    let wall = result
                        .canyon
                        .as_ref()
                        .unwrap()
                        .section(a, c, cell, &result.noise, &result.noise2)
                        .wall;
                    let weight = 1.0 - smooth((wall - 0.88) / 0.12);
                    let i = y * SOURCE_N + x;
                    worn[i] = (worn[i] - initial[i]) * weight as f32;
                }
            }
            result.delta = Surface::new(worn);
        }
        Ok(result)
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
        let epsilon = (self.motif / 65536.0).max(cell * 0.5);
        let mut min = f32::INFINITY;
        let mut max = f32::NEG_INFINITY;
        for row in 0..resolution {
            for col in 0..resolution {
                let wx = x + (col as f64 + 0.5) * cell;
                let wy = y + (row as f64 + 0.5) * cell;
                let i = row * resolution + col;
                let rock = self.rock_at(wx, wy);
                let h = self.height_at(wx, wy, cell);
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
        u8::from(cave.distance(px, py, &self.noise) >= 0.0)
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
            Relief::Cavern => {
                let px = (x - self.map_width * 0.5) / self.motif + 0.5;
                let py = (y - self.map_width * 0.5) / self.motif + 0.5;
                let distance = self.cave.as_ref().unwrap().distance(px, py, &self.noise);
                let floor = self.amp * (0.08 + 0.035 * fbm(&self.noise2, x, y, 480.0 * scale, 3));
                floor + self.amp * smooth(distance / 0.035)
            }
            Relief::Plateau | Relief::Volcano | Relief::Caldera => {
                let px = (x - self.map_width * 0.5) / self.motif + 0.5;
                let py = (y - self.map_width * 0.5) / self.motif + 0.5;
                let edge = px.min(1.0 - px).min(py).min(1.0 - py);
                let weight = smoother(edge / 0.055);
                let surroundings = self.regional(&self.background, x, y, footprint);
                if weight == 0.0 {
                    surroundings
                } else {
                    let local = self.source.sample(px, py, footprint / self.motif) * weight;
                    let protection = self.feature.as_ref().unwrap().protection(
                        px * self.motif,
                        py * self.motif,
                        self.erosion,
                        &self.noise,
                        &self.noise2,
                    );
                    local * protection + local.max(surroundings) * (1.0 - protection)
                }
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
                    + self.delta.sample(
                        0.5 + 0.44 * self.noise2.fbm(x / self.motif + 11.3, y / self.motif, 2),
                        0.5 + 0.44
                            * self
                                .noise2
                                .fbm(x / self.motif - 4.7, y / self.motif + 2.9, 2),
                        footprint * 2.0 / self.motif,
                    )
            }
            Relief::Hills
            | Relief::Mountains
            | Relief::Mixed
            | Relief::HighMountains
            | Relief::Valley
            | Relief::Canyon => {
                let terrain = self.regional(&self.source, x, y, footprint);
                if self.relief == Relief::Canyon {
                    let (along, across) = self.channel_coordinates(x, y);
                    let section = self.canyon.as_ref().unwrap().section(
                        along,
                        across,
                        footprint,
                        &self.noise,
                        &self.noise2,
                    );
                    let floor = self.amp * (0.06 + 0.012 * rough);
                    floor
                        + (terrain + self.amp * 0.9) * section.wall
                        + self.amp * section.debris
                        + self.regional(&self.delta, x, y, footprint)
                } else if self.relief == Relief::Valley {
                    let (along, across) = self.channel_coordinates(x, y);
                    let wall = self.channels.wall(
                        along,
                        across,
                        false,
                        footprint,
                        &self.noise,
                        &self.noise2,
                    );
                    self.amp * (0.06 + 0.012 * rough) + terrain * wall.powf(1.2)
                } else {
                    terrain
                }
            }
        };
        height.clamp(0.3, self.max_height)
    }

    fn channel_coordinates(&self, x: f64, y: f64) -> (f64, f64) {
        let dx = x - self.map_width * 0.5;
        let dy = y - self.map_width * 0.5;
        (
            dx * self.down.0 + dy * self.down.1,
            -dx * self.down.1 + dy * self.down.0,
        )
    }

    fn regional(&self, field: &Surface, x: f64, y: f64, footprint: f64) -> f64 {
        // Sample the actual geographic raster. A noise projection folded drainage
        // back over itself and destroyed the recognizable erosion valleys.
        field.sample(
            x / self.map_width,
            y / self.map_width,
            footprint / self.map_width,
        )
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
