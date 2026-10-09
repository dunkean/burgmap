//! Retained physical terrain. Camera sampling never reruns erosion or changes the seed.
//! Regional erosion is prepared in geographic coordinates across the map;
//! analytic world noise and finite features are evaluated at fixed physical scales.
use crate::{
    CavernShape, FiniteShape, Noise, PreparedTerrain, Relief, Rng, Terrain, channels::Channels,
    generate_motif, smooth,
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
    feature_origin: (f64, f64),
    noise: Noise,
    noise2: Noise,
    down: (f64, f64),
    channels: Channels,
    phase: f64,
    amp: f64,
    max_height: f64,
    cave: Option<CavernShape>,
    coast: crate::coast::Coast,
    coastal_surface: Surface,
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
        Self::new_with_environment(seed, map_width, relief, erosion, motif, mountain_mix, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new_with_environment(
        seed: &str,
        map_width: f64,
        relief: &str,
        erosion: f64,
        motif: f64,
        mountain_mix: f64,
        environment: Option<&str>,
    ) -> Result<Self, String> {
        Self::new_mixed_with_noise(
            seed,
            map_width,
            relief,
            erosion,
            motif,
            mountain_mix,
            None,
            environment,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new_mixed_with_noise(
        seed: &str,
        map_width: f64,
        relief: &str,
        erosion: f64,
        motif: f64,
        mountain_mix: f64,
        generation_noise: Option<&crate::GenerationNoise<'_>>,
        environment: Option<&str>,
    ) -> Result<Self, String> {
        Self::new_prepared(
            seed,
            map_width,
            relief,
            erosion,
            motif,
            mountain_mix,
            generation_noise,
            None,
            environment,
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub fn new_mixed_with_source(
        seed: &str,
        map_width: f64,
        relief: &str,
        erosion: f64,
        motif: f64,
        mountain_mix: f64,
        source: &[f32],
        environment: Option<&str>,
    ) -> Result<Self, String> {
        Self::new_prepared(
            seed,
            map_width,
            relief,
            erosion,
            motif,
            mountain_mix,
            None,
            Some(source),
            environment,
        )
    }
    #[allow(clippy::too_many_arguments)] // Temporary prepared numeric interchange.
    fn new_prepared(
        seed: &str,
        map_width: f64,
        relief: &str,
        erosion: f64,
        motif: f64,
        mountain_mix: f64,
        generation_noise: Option<&crate::GenerationNoise<'_>>,
        external_source: Option<&[f32]>,
        environment: Option<&str>,
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
        if !erosion.is_finite() || !(0.0..=2.0).contains(&erosion) {
            return Err("Le niveau d’érosion doit être compris entre 0 et 2.".into());
        }
        let kind = Relief::parse(relief)?;
        let environment = if kind.is_geological() {
            environment.unwrap_or("mixed")
        } else {
            "mixed"
        };
        Relief::environment(environment)?;
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
        let source_relief = if kind == Relief::Valley {
            "mixed"
        } else {
            relief
        };
        let source_width = if finite || kind == Relief::Flat {
            motif
        } else {
            map_width
        };
        let source_motif = if kind == Relief::Valley {
            motif * kind.environment_scale()
        } else {
            motif
        };
        let source_erosion = erosion;
        let flat_base = if kind == Relief::Flat && erosion > 0.0 {
            Some(
                crate::generate_motif_base(
                    seed,
                    source_width,
                    source_relief,
                    0.0,
                    SOURCE_N,
                    source_motif,
                    mountain_mix,
                )?
                .height,
            )
        } else {
            None
        };
        let prepared = if let Some(source) = external_source {
            if !matches!(
                kind,
                Relief::Hills
                    | Relief::Mountains
                    | Relief::Mixed
                    | Relief::HighMountains
                    | Relief::Valley
                    | Relief::Canyon
                    | Relief::Volcano
                    | Relief::Caldera
                    | Relief::Plateau
            ) || source.len() != SOURCE_N * SOURCE_N * if kind.is_geological() { 2 } else { 1 }
                || !source.iter().all(|h| h.is_finite() && *h >= 0.3)
            {
                return Err("Champ de relief externe invalide.".into());
            }
            PreparedTerrain {
                height: source[..SOURCE_N * SOURCE_N].to_vec(),
            }
        } else if let Some(base) = &flat_base {
            let mut height = base.clone();
            crate::erosion::erode_shape(
                &mut height,
                SOURCE_N,
                source_width / SOURCE_N as f64,
                source_erosion,
                0.03,
            );
            crate::normalize(height)?
        } else if kind == Relief::Cavern {
            // Cave geometry is continuous and sampled analytically, without an unused raster.
            PreparedTerrain::default()
        } else {
            crate::normalize(
                crate::generate_motif_base_with_noise(
                    seed,
                    source_width,
                    source_relief,
                    source_erosion,
                    SOURCE_N,
                    source_motif,
                    mountain_mix,
                    generation_noise,
                )?
                .height,
            )?
        };
        let amp = kind.mixed_amplitude(motif, mountain_mix);
        let background = if let Some(source) = external_source.filter(|_| kind.is_geological()) {
            PreparedTerrain {
                height: source[SOURCE_N * SOURCE_N..].to_vec(),
            }
        } else if finite && kind != Relief::Cavern {
            let environment_motif = motif * kind.environment_scale();
            generate_motif(
                seed,
                map_width,
                environment,
                erosion,
                SOURCE_N,
                environment_motif,
                0.5,
            )?
        } else {
            PreparedTerrain::default()
        };
        let delta = if kind == Relief::Flat && erosion > 0.0 {
            let initial = crate::normalize(flat_base.unwrap())?;
            prepared
                .height
                .iter()
                .zip(initial.height)
                .map(|(&h, base)| h - base)
                .collect()
        } else {
            Vec::new()
        };
        let root = Rng::new(&format!("magna-urbis:{seed}")).fork("terrain");
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
        let limit: f64 = match kind {
            Relief::Flat => 80.0,
            Relief::Hills => 500.0,
            Relief::Valley => 1500.0,
            Relief::Canyon => 2500.0,
            Relief::Mountains | Relief::Mixed => 3500.0,
            Relief::Plateau => 3500.0,
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
        let slack = (map_width - motif).max(0.0);
        let mut placement = root.fork("geological-placement");
        let feature_origin = (
            (map_width - motif) * 0.5 + placement.range(-0.42, 0.42) * slack,
            (map_width - motif) * 0.5 + placement.range(-0.42, 0.42) * slack,
        );
        let result = Self {
            map_width,
            motif,
            relief: kind,
            erosion,
            source: Surface::new(prepared.height),
            delta: Surface::new(delta),
            background: Surface::new(background.height),
            feature,
            feature_origin,
            noise,
            noise2,
            down,
            channels,
            phase,
            amp,
            max_height: estimated.min(if kind.is_geological() {
                limit.max(source_max + background_max + amp * 0.18)
            } else {
                limit
            }),
            cave,
            coast: crate::coast::Coast::new(
                root.fork("coast"),
                map_width,
                motif,
                amp,
                if kind == Relief::Flat {
                    amp * 0.35
                } else {
                    0.0
                },
            ),
            coastal_surface: Surface::new(Vec::new()),
        };
        Ok(result)
    }

    /// Retained mip levels, largest first. Empty correction means no field for plains.
    pub fn sampling_field(&self) -> Vec<f32> {
        if !self.coastal_surface.levels.is_empty() {
            return self
                .coastal_surface
                .levels
                .iter()
                .flatten()
                .copied()
                .collect();
        }
        let mut values: Vec<f32> = self
            .sampling_surface()
            .levels
            .iter()
            .flatten()
            .copied()
            .collect();
        if self.relief.is_geological() {
            values.extend(self.background.levels.iter().flatten());
        }
        values
    }
    /// Retained physical field, including its filtered pyramid.
    fn sampling_surface(&self) -> &Surface {
        if self.relief == Relief::Flat {
            &self.delta
        } else {
            &self.source
        }
    }
    /// Temporary sampler parameters: map/motif meters, phase, amplitude, clamp,
    /// family (0 plain, 1 regional, 2 valley, 3 finite), then the geographic channel direction.
    pub fn sampling_parameters(&self) -> Vec<f64> {
        let mut values = vec![
            self.map_width,
            self.motif,
            self.phase,
            self.amp,
            self.max_height,
            if self.relief == Relief::Flat {
                0.0
            } else if self.relief == Relief::Valley {
                2.0
            } else if self.relief.is_geological() {
                3.0
            } else {
                1.0
            },
            self.down.0,
            self.down.1,
        ];
        match &self.feature {
            Some(FiniteShape::Volcano(shape)) => {
                values.extend(shape.parameters(self.amp).iter().map(|&v| v as f64))
            }
            Some(FiniteShape::Plateau(shape)) => values.extend(
                shape
                    .parameters(self.amp, self.erosion)
                    .iter()
                    .map(|&v| v as f64),
            ),
            None => {}
        }
        if self.relief.is_geological() {
            // Reserved sampler slots: local field origin in map meters.
            values[21] = self.feature_origin.0;
            values[22] = self.feature_origin.1;
        }
        if !self.coastal_surface.levels.is_empty() {
            values[5] = 4.0;
        }
        values
    }

    pub fn prepare_environment(
        seed: &str,
        width: f64,
        relief: &str,
        erosion: f64,
        motif: f64,
    ) -> Result<Vec<f32>, String> {
        Relief::environment(relief)?;
        if !motif.is_finite() || !(250.0..=150000.0).contains(&motif) {
            return Err("Taille du motif environnant invalide.".into());
        }
        Ok(generate_motif(seed, width, relief, erosion, SOURCE_N, motif, 0.5)?.height)
    }
    pub fn sampling_permutations(&self) -> Vec<u32> {
        self.noise
            .perm
            .iter()
            .chain(self.noise2.perm.iter())
            .chain(self.coast.noise.perm.iter())
            .map(|&v| v as u32)
            .collect()
    }
    pub fn sampling_gradients(&self) -> Vec<f32> {
        self.noise
            .gradients
            .iter()
            .chain(self.noise2.gradients.iter())
            .chain(self.coast.noise.gradients.iter())
            .flat_map(|&(x, y)| [x as f32, y as f32])
            .collect()
    }
    pub fn sampling_branches(&self) -> Vec<f32> {
        self.channels.sampling_branches()
    }
    /// Optional surface sea. Caverns intentionally retain their underground floor.
    pub fn set_coast(&mut self, mask: u32, mode: &str) -> Result<(), String> {
        self.configure_coast(mask, mode)?;
        if mask == 0 {
            return Ok(());
        }
        let cell = self.map_width / SOURCE_N as f64;
        let mut field = Vec::with_capacity(SOURCE_N * SOURCE_N);
        for y in 0..SOURCE_N {
            for x in 0..SOURCE_N {
                field.push(
                    self.height_at((x as f64 + 0.5) * cell, (y as f64 + 0.5) * cell, cell) as f32,
                );
            }
        }
        crate::erosion::erode_surface(
            &mut field,
            SOURCE_N,
            cell,
            self.erosion,
            self.coast_talus(),
            self.motif,
        );
        self.set_coast_surface(&field)
    }

    /// Shape only, for GPU assembly followed by physical surface erosion.
    pub fn configure_coast(&mut self, mask: u32, mode: &str) -> Result<(), String> {
        if self.relief == Relief::Cavern && mask != 0 {
            return Err("Les côtes ne s’appliquent pas aux cavernes.".into());
        }
        self.coast.configure(mask, mode)?;
        self.coastal_surface = Surface::new(Vec::new());
        Ok(())
    }

    fn coast_talus(&self) -> f64 {
        crate::mountain_parameters(self.relief, self.map_width, self.motif, 0.5)
            .talus
            .clamp(0.2, 0.85)
    }

    pub fn coast_erosion_parameters(&self) -> Vec<f32> {
        crate::erosion::surface_parameters(
            self.map_width,
            self.motif,
            self.erosion,
            self.coast_talus(),
        )
        .to_vec()
    }

    /// Prepared signed heights; sea level must not be renormalized or cut again.
    pub fn set_coast_surface(&mut self, heights: &[f32]) -> Result<(), String> {
        if !self.coast.active()
            || heights.len() != SOURCE_N * SOURCE_N
            || !heights.iter().all(|h| h.is_finite())
        {
            return Err("Surface littorale préparée invalide.".into());
        }
        self.coastal_surface = Surface::new(heights.to_vec());
        Ok(())
    }

    pub fn coast_parameters(&self) -> Vec<f32> {
        self.coast.parameters.clone()
    }

    pub fn width(&self) -> f64 {
        self.map_width
    }
    pub fn motif_size(&self) -> f64 {
        self.motif
    }
    pub fn min_height(&self) -> f64 {
        if let Some(field) = self.coastal_surface.levels.first() {
            return field.iter().copied().fold(f32::INFINITY, f32::min) as f64;
        }
        if self.coast.active() {
            -self.coast.depth()
        } else {
            0.3
        }
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
        let mut vertical = vec![(f64::NAN, 0.0_f64); resolution];
        for row in 0..resolution {
            let mut horizontal = (f64::NAN, 0.0_f64);
            for (col, vertical_sample) in vertical.iter_mut().enumerate() {
                let wx = x + (col as f64 + 0.5) * cell;
                let wy = y + (row as f64 + 0.5) * cell;
                let i = row * resolution + col;
                let rock = self.rock_at(wx, wy);
                let h = self.height_at(wx, wy, cell);
                height[i] = h as f32;
                if !cave_mask.is_empty() {
                    cave_mask[i] = rock;
                }
                // Shade the same filtered surface as the contours, not subpixel gullies.
                let left_x = wx - epsilon;
                let right_x = wx + epsilon;
                let upper_y = wy - epsilon;
                let lower_y = wy + epsilon;
                let left = if horizontal.0.to_bits() == left_x.to_bits() {
                    horizontal.1
                } else {
                    self.height_at(left_x, wy, cell)
                };
                let upper = if vertical_sample.0.to_bits() == upper_y.to_bits() {
                    vertical_sample.1
                } else {
                    self.height_at(wx, upper_y, cell)
                };
                let right = self.height_at(right_x, wy, cell);
                let lower = self.height_at(wx, lower_y, cell);
                horizontal = (right_x, right);
                *vertical_sample = (lower_y, lower);
                let gx = (right - left) / (2.0 * epsilon);
                let gy = (lower - upper) / (2.0 * epsilon);
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
        if !self.coastal_surface.levels.is_empty() {
            return self.regional(&self.coastal_surface, x, y, footprint);
        }
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
        let rough = || fbm(&self.noise, x + self.phase, y, 720.0 * scale, 4);
        let height = match self.relief {
            Relief::Cavern => {
                let px = (x - self.map_width * 0.5) / self.motif + 0.5;
                let py = (y - self.map_width * 0.5) / self.motif + 0.5;
                let distance = self.cave.as_ref().unwrap().distance(px, py, &self.noise);
                let floor = self.amp * (0.08 + 0.035 * fbm(&self.noise2, x, y, 480.0 * scale, 3));
                floor + self.amp * smooth(distance / 0.035)
            }
            Relief::Plateau | Relief::Volcano | Relief::Caldera => {
                let px = (x - self.feature_origin.0) / self.motif;
                let py = (y - self.feature_origin.1) / self.motif;
                let edge = px.min(1.0 - px).min(py).min(1.0 - py);
                let weight = match self.feature.as_ref().unwrap() {
                    FiniteShape::Plateau(shape) => {
                        smoother(edge / 0.045)
                            * shape.influence(
                                px * self.motif,
                                py * self.motif,
                                &self.noise,
                                &self.noise2,
                            )
                    }
                    FiniteShape::Volcano(shape) => {
                        shape.influence(px * self.motif, py * self.motif, &self.noise, &self.noise2)
                    }
                };
                let surroundings = self.regional(&self.background, x, y, footprint);
                if weight == 0.0 {
                    surroundings
                } else {
                    let local = self.source.sample(px, py, footprint / self.motif);
                    // A low-frequency foundation lifts the complete crater with its
                    // surroundings; smooth union blends gradients over a physical apron.
                    let foundation = if matches!(
                        self.relief,
                        Relief::Volcano | Relief::Caldera | Relief::Plateau
                    ) {
                        self.regional(
                            &self.background,
                            self.feature_origin.0 + self.motif * 0.5,
                            self.feature_origin.1 + self.motif * 0.5,
                            self.motif * 0.35,
                        )
                    } else {
                        0.0
                    };
                    let local = local + foundation;
                    let protection = self.feature.as_ref().unwrap().protection(
                        px * self.motif,
                        py * self.motif,
                        self.erosion,
                        &self.noise,
                        &self.noise2,
                    );
                    let k = self.amp * 0.18;
                    let overlap = (1.0 - (local - surroundings).abs() / k).max(0.0);
                    let union = local.max(surroundings) + k * overlap * overlap * 0.25;
                    let joined = local * protection + union * (1.0 - protection);
                    surroundings * (1.0 - weight) + joined * weight
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
                self.amp * (0.45 + 0.275 * swell + 0.065 * rough())
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
                if self.relief == Relief::Valley {
                    let (along, across) = self.channel_coordinates(x, y);
                    let wall = self.channels.wall(
                        along,
                        across,
                        false,
                        footprint,
                        &self.noise,
                        &self.noise2,
                    );
                    self.amp * (0.06 + 0.012 * rough()) + terrain * wall.powf(1.2)
                } else {
                    terrain
                }
            }
        };
        self.coast.apply(
            x,
            y,
            self.map_width,
            height.clamp(0.3, self.max_height),
            footprint,
        )
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
        if t == 0.0 {
            at(lower)
        } else {
            at(lower) * (1.0 - t) + at(upper) * t
        }
    }
}
