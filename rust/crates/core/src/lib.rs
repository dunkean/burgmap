//! First isolated Rust generation stage. World coordinates and elevations are meters.
//! The square raster uses cell centers and has its origin at the upper left.
mod channels;
mod coast;
mod engine;
mod erosion;
mod generation_noise;
mod hydrology;
mod noise;
mod rng;

use erosion::{MountainCfg, erode_shape, erode_surface, mountain};
use noise::Noise;
use rng::Rng;
use std::f64::consts::{PI, TAU};

pub use engine::TerrainGenerator;
pub use generation_noise::{GenerationNoise, GenerationNoisePlan};
pub use hydrology::{HydrologyConfig, HydrologyEngine, HydrologyOutput};

pub struct Terrain {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub resolution: usize,
    pub min_height: f32,
    pub max_height: f32,
    pub height: Vec<f32>,
    /// Cavern only: 1 = solid rock, 0 = open floor. Empty for surface relief.
    pub cave_mask: Vec<u8>,
    pub normal_x: Vec<f32>,
    pub normal_y: Vec<f32>,
    pub normal_z: Vec<f32>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Relief {
    Flat,
    Hills,
    Valley,
    Canyon,
    Mountains,
    Mixed,
    Plateau,
    HighMountains,
    Volcano,
    Caldera,
    Cavern,
}

impl Relief {
    fn is_geological(self) -> bool {
        matches!(self, Self::Plateau | Self::Volcano | Self::Caldera)
    }

    fn environment(value: &str) -> Result<Self, String> {
        let kind = Self::parse(value)?;
        if !matches!(
            kind,
            Self::Flat | Self::Hills | Self::Mixed | Self::Mountains | Self::HighMountains
        ) {
            return Err("Relief environnant invalide.".into());
        }
        Ok(kind)
    }

    fn environment_scale(self) -> f64 {
        match self {
            Self::Plateau => 2.5,
            Self::Valley | Self::Volcano | Self::Caldera => 2.0,
            _ => 1.0,
        }
    }

    fn mixed_amplitude(self, motif: f64, mountain_mix: f64) -> f64 {
        if self == Self::Mixed {
            Self::Hills.amplitude(motif) * (1.0 - mountain_mix)
                + Self::Mountains.amplitude(motif) * mountain_mix
        } else {
            self.amplitude(motif)
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "flat" => Ok(Self::Flat),
            "hills" => Ok(Self::Hills),
            "valley" => Ok(Self::Valley),
            "canyon" => Ok(Self::Canyon),
            "mountains" => Ok(Self::Mountains),
            "mixed" => Ok(Self::Mixed),
            "plateau" => Ok(Self::Plateau),
            "high-mountains" => Ok(Self::HighMountains),
            "volcano" => Ok(Self::Volcano),
            "caldera" => Ok(Self::Caldera),
            "cavern" => Ok(Self::Cavern),
            _ => Err(format!("Type de relief inconnu : {value}")),
        }
    }

    fn amplitude(self, width: f64) -> f64 {
        let extent = width / 2400.0;
        match self {
            Self::Flat => (20.0 * extent.powf(0.6)).min(60.0),
            Self::Hills => (88.0 * extent.powf(0.85)).min(380.0),
            Self::Valley => (110.0 * extent.powf(0.85)).min(1100.0),
            Self::Canyon => (260.0 * extent.powf(0.78)).min(1800.0),
            Self::Mountains | Self::Mixed => (400.0 * extent.powf(0.78)).min(2600.0),
            Self::Plateau => (240.0 * extent.powf(0.78)).min(1800.0),
            Self::HighMountains => (1050.0 * extent.powf(0.78)).min(5200.0),
            Self::Volcano | Self::Caldera => (720.0 * extent.powf(0.78)).min(3800.0),
            Self::Cavern => (32.0 * extent.powf(0.6)).min(160.0),
        }
    }
}

fn smooth(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn fbm_length(noise: &Noise, x: f64, y: f64, wavelength: f64, min: f64, gain: f64) -> f64 {
    let octaves = ((wavelength / min).log2().floor() + 1.0).clamp(1.0, 9.0) as usize;
    noise.fbm_gain(x / wavelength, y / wavelength, octaves, gain)
}

/// Deterministic terrain generation. No browser state, JS objects, or rendering dependencies.
/// Inputs are rejected rather than silently clamped. Seeds are UTF-16 hashed like the TS engine.
#[derive(Default)]
struct PreparedTerrain {
    height: Vec<f32>,
}

fn generate_motif_base(
    seed: &str,
    width: f64,
    relief: &str,
    erosion: f64,
    resolution: usize,
    motif: f64,
    mountain_mix: f64,
) -> Result<PreparedTerrain, String> {
    generate_motif_base_with_noise(
        seed,
        width,
        relief,
        erosion,
        resolution,
        motif,
        mountain_mix,
        None,
    )
}

#[allow(clippy::too_many_arguments)] // Temporary numeric interchange, matching the existing motif API.
fn generate_motif_base_with_noise(
    seed: &str,
    width: f64,
    relief: &str,
    erosion: f64,
    resolution: usize,
    motif: f64,
    mountain_mix: f64,
    generation_noise: Option<&GenerationNoise<'_>>,
) -> Result<PreparedTerrain, String> {
    if !width.is_finite() || !(250.0..=100000.0).contains(&width) {
        return Err("La surface préparée doit être comprise entre 250 et 100 000 mètres.".into());
    }
    if !erosion.is_finite() || !(0.0..=2.0).contains(&erosion) {
        return Err("Le niveau d’érosion doit être compris entre 0 et 2.".into());
    }
    if !(64..=1024).contains(&resolution) {
        return Err("La résolution doit être comprise entre 64 et 1 024.".into());
    }
    if seed.len() > 4096 {
        return Err("La graine ne doit pas dépasser 4 096 octets.".into());
    }
    let relief = Relief::parse(relief)?;
    let erosion = if relief == Relief::Cavern {
        0.0
    } else {
        erosion
    };
    let n = resolution;
    let cell = width / n as f64;
    let root = Rng::new(&format!("magna-urbis:{seed}")).fork("terrain");
    let noise = Noise::new(root.fork("noise"));
    let noise2 = Noise::new(root.fork("noise2"));
    let mut params = root.fork("params");
    let cardinal = (params.float() * 4.0).floor() as usize;
    let sides = [(0.0, -1.0), (1.0, 0.0), (0.0, 1.0), (-1.0, 0.0)];
    let angle = params.range(-0.3, 0.3);
    let side = sides[cardinal];
    let down = (
        side.0 * angle.cos() - side.1 * angle.sin(),
        side.0 * angle.sin() + side.1 * angle.cos(),
    );
    let offset = params.range(0.0, 1000.0);
    // Length scales are physical: widening the map reveals more geography,
    // instead of stretching the same noise pattern over a larger rectangle.
    let k = motif / 2400.0;
    let valley_width = params.range(180.0, 320.0) * k;
    let valley_offset = params.range(-0.08, 0.08) * width;
    let amp = relief.mixed_amplitude(motif, mountain_mix);
    let mut height = if matches!(
        relief,
        Relief::Hills
            | Relief::Valley
            | Relief::Canyon
            | Relief::Mountains
            | Relief::Mixed
            | Relief::HighMountains
    ) {
        if let Some(values) = generation_noise {
            let nc = if width > motif * 3.0 { 640 } else { 320 };
            if (!values.coarse.is_empty() && values.coarse.len() != nc * nc * 4)
                || values.fine.len() != n * n * 4
                || !values
                    .coarse
                    .iter()
                    .chain(values.fine)
                    .all(|v| v.is_finite())
            {
                return Err("Champs de bruit de génération invalides.".into());
            }
        }
        let settings = mountain_parameters(relief, width, motif, mountain_mix);
        mountain(&MountainCfg {
            generation_noise,
            n,
            width,
            amp: settings.amp,
            noise: &noise,
            noise2: &noise2,
            down,
            k,
            iterations: settings.iterations,
            coarse: settings.coarse,
            mountain_mix: settings.mountain_mix,
            talus: settings.talus,
            detail: settings.detail,
            diffusion: settings.diffusion,
            crest: settings.crest,
            valley: (relief == Relief::Valley).then_some((valley_width, valley_offset, offset)),
            erosion,
        })
    } else if relief == Relief::Cavern {
        let (h, _) = cavern(n, width, amp, erosion, &noise, &noise2, root.fork("cavern"));
        h
    } else {
        vec![0.0; n * n]
    };
    let volcano = VolcanoShape::new(width, root.fork("volcano"), relief == Relief::Caldera);
    let plateau = PlateauShape::new(width, root.fork("plateau"));
    for y in 0..n {
        for x in 0..n {
            let i = y * n + x;
            let px = (x as f64 + 0.5) * cell;
            let py = (y as f64 + 0.5) * cell;
            let along = (px - width * 0.5) * down.0 + (py - width * 0.5) * down.1;
            let q = along / width + 0.5;
            let rough = || noise.fbm((px + offset) / (720.0 * k), py / (720.0 * k), 4);
            let h = match relief {
                Relief::Flat => {
                    9.0 + 5.5
                        * (width / 2400.0).powf(0.6)
                        * fbm_length(
                            &noise,
                            px + offset,
                            py,
                            1200.0 * k,
                            (cell * 5.0).max(220.0 * k),
                            0.42,
                        )
                        + 6.0 * (width / 2400.0).powf(0.6) * (0.5 - q)
                }
                Relief::Valley => height[i] as f64 + 44.0 * (amp / 110.0) * (0.5 - q),
                Relief::Plateau => {
                    amp * plateau.elevation(px, py, erosion, rough(), &noise, &noise2)
                }
                Relief::Volcano | Relief::Caldera => {
                    amp * volcano.elevation(px, py, rough(), &noise, &noise2)
                }
                _ => height[i] as f64,
            };
            height[i] = h as f32;
        }
    }
    if matches!(
        relief,
        Relief::Flat | Relief::Plateau | Relief::Volcano | Relief::Caldera
    ) {
        if matches!(relief, Relief::Volcano | Relief::Caldera | Relief::Plateau) {
            erode_surface(
                &mut height,
                n,
                cell,
                erosion,
                if relief == Relief::Plateau {
                    0.95
                } else {
                    0.55
                },
                motif,
            );
        } else {
            erode_shape(
                &mut height,
                n,
                cell,
                erosion,
                if relief == Relief::Flat { 0.03 } else { 0.95 },
            );
        }
    }
    if relief == Relief::Canyon {
        erosion::erode_canyon(
            &mut height,
            n,
            cell,
            erosion,
            1.15,
            motif,
            mountain_parameters(relief, width, motif, mountain_mix).amp,
        );
    } else if matches!(
        relief,
        Relief::Hills | Relief::Mountains | Relief::Mixed | Relief::HighMountains | Relief::Valley
    ) {
        erode_surface(
            &mut height,
            n,
            cell,
            erosion,
            mountain_parameters(relief, width, motif, mountain_mix).talus,
            motif,
        );
    }
    Ok(PreparedTerrain { height })
}

pub(crate) struct MountainParameters {
    amp: f64,
    iterations: usize,
    coarse: usize,
    mountain_mix: f64,
    talus: f64,
    detail: f64,
    diffusion: f64,
    crest: f64,
}
fn mountain_parameters(relief: Relief, width: f64, motif: f64, mix: f64) -> MountainParameters {
    let gentle = matches!(relief, Relief::Hills | Relief::Valley);
    let high = relief == Relief::HighMountains;
    let canyon = relief == Relief::Canyon;
    MountainParameters {
        amp: relief.mixed_amplitude(motif, mix)
            * if canyon {
                1.7
            } else if relief == Relief::Valley {
                0.65
            } else if gentle {
                1.05
            } else {
                1.2
            },
        // Reserve the ridge skeleton for mountain chains. Ordinary mountains
        // (including mixed regions) use the smoother TypeScript uplift profile.
        // GenerationNoisePlan exports this same setting to GPU erosion.
        crest: if high { 1.0 } else { 0.0 },
        iterations: if gentle { 18 } else { 22 },
        coarse: if width > motif * 3.0 { 640 } else { 320 },
        mountain_mix: if canyon {
            0.0
        } else if relief == Relief::Mixed {
            mix
        } else if gentle {
            0.0
        } else {
            0.72
        },
        talus: if canyon {
            1.15
        } else if relief == Relief::Mixed {
            0.2 + 0.65 * mix
        } else if gentle {
            0.2
        } else if high {
            1.4
        } else {
            0.85
        },
        detail: if canyon {
            0.012
        } else if relief == Relief::Mixed {
            0.025 + 0.025 * mix
        } else if gentle {
            0.025
        } else if high {
            0.085
        } else {
            0.05
        },
        diffusion: if canyon {
            0.08
        } else if relief == Relief::Mixed {
            0.7 - 0.4 * mix
        } else if gentle {
            0.7
        } else if high {
            0.12
        } else {
            0.3
        },
    }
}

fn normalize(mut height: Vec<f32>) -> Result<PreparedTerrain, String> {
    // Historical relief normalization: shift p1 to 1m without changing physical slope.
    // Rock height and cave floor remain a separate, explicitly marked raster.
    let mut sorted = height.clone();
    let index = (sorted.len() as f64 * 0.01).floor() as usize;
    let p1 = *sorted.select_nth_unstable_by(index, f32::total_cmp).1;
    for value in &mut height {
        *value = (1.0 + *value - p1).max(0.3);
    }
    if height.iter().any(|h| !h.is_finite()) {
        return Err("La génération a produit une altitude non finie.".into());
    }
    Ok(PreparedTerrain { height })
}

/// Compatibility entry point. New clients retain TerrainGenerator and request regions.
pub fn generate_terrain(
    seed: &str,
    width: f64,
    relief: &str,
    erosion: f64,
    resolution: usize,
) -> Result<Terrain, String> {
    TerrainGenerator::new(seed, width, relief, erosion, 3000.0)?
        .sample_region(0.0, 0.0, width, resolution)
}

struct Chamber {
    x: f64,
    y: f64,
    radius: f64,
}

struct CavernShape {
    chambers: Vec<Chamber>,
    links: Vec<(usize, usize, f64)>,
}

impl CavernShape {
    fn new(mut rng: Rng) -> Self {
        let count = 14;
        let mut chambers = vec![Chamber {
            x: 0.5,
            y: 0.5,
            radius: 0.12,
        }];
        let mut links = Vec::with_capacity(count);
        for index in 1..count {
            let parent = (rng.float() * index as f64).floor() as usize;
            let angle = rng.range(0.0, TAU);
            let step = rng.range(0.13, 0.27);
            chambers.push(Chamber {
                x: (chambers[parent].x + angle.cos() * step).clamp(0.12, 0.88),
                y: (chambers[parent].y + angle.sin() * step).clamp(0.12, 0.88),
                radius: rng.range(0.045, 0.10),
            });
            links.push((parent, index, rng.range(0.018, 0.035)));
        }
        Self { chambers, links }
    }

    fn distance(&self, px: f64, py: f64, noise: &Noise) -> f64 {
        let mut distance = f64::INFINITY;
        for chamber in &self.chambers {
            distance = distance.min((px - chamber.x).hypot(py - chamber.y) - chamber.radius);
        }
        for &(a, b, radius) in &self.links {
            let dx = self.chambers[b].x - self.chambers[a].x;
            let dy = self.chambers[b].y - self.chambers[a].y;
            let length2 = dx * dx + dy * dy;
            let t = if length2 > 0.0 {
                ((px - self.chambers[a].x) * dx + (py - self.chambers[a].y) * dy) / length2
            } else {
                0.0
            }
            .clamp(0.0, 1.0);
            let d = (px - self.chambers[a].x - t * dx).hypot(py - self.chambers[a].y - t * dy);
            distance = distance.min(d - radius);
        }
        distance + 0.009 * noise.fbm(px * (2400.0 / 110.0), py * (2400.0 / 110.0), 3)
    }
}

struct PlateauShape {
    width: f64,
    level: f64,
    layout: f64,
    angle: f64,
    axis: f64,
    phase: f64,
}

impl PlateauShape {
    fn new(width: f64, mut rng: Rng) -> Self {
        Self {
            width,
            level: rng.range(0.38, 0.58),
            layout: rng.float(),
            angle: rng.range(0.0, TAU),
            axis: rng.range(0.78, 1.12),
            phase: rng.range(0.0, 100.0),
        }
    }

    fn parameters(&self, amp: f64, _erosion: f64) -> Vec<f32> {
        vec![
            (self.width * 0.5) as f32,
            (self.width * 0.5) as f32,
            (self.width * 0.48) as f32,
            self.axis as f32,
            self.angle.cos() as f32,
            self.angle.sin() as f32,
            self.level as f32,
            self.layout as f32,
            self.phase as f32,
            (self.width / 2400.0) as f32,
            2.0,
            amp as f32,
            0.0,
            0.95,
            0.5,
            Relief::Plateau.environment_scale() as f32,
        ]
    }

    // Union of warped lobes, with bays and occasional detached mesas. This is a
    // signed geographic boundary, also used for joining the finite raster.
    fn boundary(&self, px: f64, py: f64, noise: &Noise, noise2: &Noise) -> (f64, f64) {
        let k = self.width / 2400.0;
        let dx = (px - self.width * 0.5) / (self.width * 0.48);
        let dy = (py - self.width * 0.5) / (self.width * 0.48);
        let rx = dx * self.angle.cos() + dy * self.angle.sin();
        let ry = (-dx * self.angle.sin() + dy * self.angle.cos()) / self.axis;
        let wx = rx + 0.10 * noise.fbm(px / (700.0 * k) + self.phase, py / (700.0 * k), 3);
        let wy = ry + 0.10 * noise2.fbm(px / (700.0 * k), py / (700.0 * k) - self.phase, 3);
        let detached = self.layout > 0.72;
        let mut boundary = if detached { 10.0 } else { wx.hypot(wy) - 0.31 };
        let count = 3 + (self.layout * 5.0).floor() as usize;
        for i in 0..count {
            let i = i as f64;
            let angle = self.phase * 0.13 + i * 2.399963;
            let radius = 0.28 + 0.29 * (0.5 + 0.5 * (self.phase * 0.37 + i * 1.71).sin());
            let lobe = if detached { 0.14 } else { 0.20 }
                + 0.10 * (0.5 + 0.5 * (self.phase * 0.83 + i * 2.31).sin());
            boundary =
                boundary.min((wx - angle.cos() * radius).hypot(wy - angle.sin() * radius) - lobe);
        }
        if self.layout < 0.45 {
            let angle = self.phase * 0.21;
            let bay = 0.27 - (wx - 0.44 * angle.cos()).hypot(wy - 0.44 * angle.sin());
            boundary = boundary.max(bay);
        }
        // Keep all support inside the local simulation. No square raster skirt.
        boundary = boundary.max(dx.hypot(dy) - 0.80);
        (rx, boundary)
    }

    fn influence(&self, px: f64, py: f64, noise: &Noise, noise2: &Noise) -> f64 {
        1.0 - smooth((self.boundary(px, py, noise, noise2).1 + 0.01) / 0.15)
    }

    fn protection(&self, px: f64, py: f64, _erosion: f64, noise: &Noise, noise2: &Noise) -> f64 {
        1.0 - smooth((self.boundary(px, py, noise, noise2).1 + 0.03) / 0.10)
    }

    fn elevation(
        &self,
        px: f64,
        py: f64,
        _erosion: f64,
        rough: f64,
        noise: &Noise,
        noise2: &Noise,
    ) -> f64 {
        let k = self.width / 2400.0;
        let (_, boundary) = self.boundary(px, py, noise, noise2);
        let apron = 1.0 - smooth((boundary + 0.03) / 0.10);
        // Restore the former summit shelves and small relief, clipped to the
        // new geographic footprint. Keep the outline's random draws unchanged.
        let dx = (px - self.width * 0.5) / (self.width * 0.48);
        let dy = (py - self.width * 0.5) / (self.width * 0.48);
        let rx = dx * self.angle.cos() + dy * self.angle.sin();
        let ry = (-dx * self.angle.sin() + dy * self.angle.cos()) / self.axis;
        let radial = rx.hypot(ry);
        let summit_boundary = radial
            + 0.12 * noise.fbm(px / (840.0 * k) + self.phase, py / (840.0 * k), 4)
            + 0.025 * noise2.fbm(px / (500.0 * k), py / (500.0 * k), 2);
        let upper = (1.0 - smooth((summit_boundary - self.level) / 0.11)) * apron;
        let upper_lobe =
            smooth((noise2.fbm(px / (650.0 * k) + self.phase, py / (650.0 * k), 3) - 0.03) / 0.22);
        let buttes =
            smooth((noise.fbm(px / (510.0 * k) - self.phase, py / (510.0 * k), 3) - 0.16) / 0.22)
                * (1.0 - smooth((radial - 1.0) / 0.22));
        let remnant = noise2.ridged(px / (250.0 * k), py / (250.0 * k), 4);
        0.06 + 0.60 * apron
            + 0.20 * upper
            + 0.035 * upper_lobe * apron
            + 0.08 * buttes * (1.0 - apron)
            + 0.012 * remnant * upper
            + 0.010 * rough
    }
}

enum FiniteShape {
    Plateau(PlateauShape),
    Volcano(VolcanoShape),
}

impl FiniteShape {
    fn new(relief: Relief, motif: f64, root: &Rng) -> Option<Self> {
        match relief {
            Relief::Plateau => Some(Self::Plateau(PlateauShape::new(
                motif,
                root.fork("plateau"),
            ))),
            Relief::Volcano | Relief::Caldera => Some(Self::Volcano(VolcanoShape::new(
                motif,
                root.fork("volcano"),
                relief == Relief::Caldera,
            ))),
            _ => None,
        }
    }

    fn protection(&self, x: f64, y: f64, erosion: f64, noise: &Noise, noise2: &Noise) -> f64 {
        match self {
            Self::Plateau(shape) => shape.protection(x, y, erosion, noise, noise2),
            Self::Volcano(shape) => shape.protection(x, y, noise, noise2),
        }
    }
}

struct VolcanoShape {
    center: (f64, f64),
    radius: f64,
    collapsed: bool,
    rotation: f64,
    axis: f64,
    breach_angle: f64,
    breach_width: f64,
    phase: f64,
    scale: f64,
}

impl VolcanoShape {
    fn new(width: f64, mut rng: Rng, collapsed: bool) -> Self {
        Self {
            collapsed,
            center: (width * rng.range(0.43, 0.57), width * rng.range(0.43, 0.57)),
            radius: width * rng.range(0.40, 0.46),
            rotation: rng.range(0.0, TAU),
            axis: rng.range(0.78, 1.16),
            breach_angle: rng.range(-PI, PI),
            breach_width: rng.range(0.45, 0.82),
            phase: rng.range(0.0, 100.0),
            scale: width / 2400.0,
        }
    }

    fn parameters(&self, amp: f64) -> Vec<f32> {
        vec![
            self.center.0 as f32,
            self.center.1 as f32,
            self.radius as f32,
            self.axis as f32,
            self.rotation.cos() as f32,
            self.rotation.sin() as f32,
            self.breach_angle as f32,
            self.breach_width as f32,
            self.phase as f32,
            self.scale as f32,
            u8::from(self.collapsed) as f32,
            amp as f32,
            0.0,
            0.0,
            0.0,
            Relief::Volcano.environment_scale() as f32,
        ]
    }

    fn geometry(&self, px: f64, py: f64, noise: &Noise, noise2: &Noise) -> (f64, f64, f64) {
        let dx = px - self.center.0;
        let dy = py - self.center.1;
        let x = dx * self.rotation.cos() + dy * self.rotation.sin();
        let y = (-dx * self.rotation.sin() + dy * self.rotation.cos()) / self.axis;
        let azimuth = y.atan2(x);
        // Cartesian variation avoids extending every rim irregularity into a
        // radial construction line across the crater floor and interior wall.
        let outline = noise.fbm(
            px / (900.0 * self.scale) + self.phase,
            py / (900.0 * self.scale) - 2.3,
            3,
        );
        let geographic = noise2.fbm(
            (px + self.phase) / (620.0 * self.scale),
            py / (620.0 * self.scale),
            3,
        );
        let wobble =
            1.0 + (if self.collapsed { 0.18 } else { 0.12 }) * outline + 0.055 * geographic;
        let radius = x.hypot(y) / (self.radius * wobble);
        let rim = (if self.collapsed { 0.55 } else { 0.255 })
            + (if self.collapsed { 0.045 } else { 0.030 })
                * noise2.fbm(
                    px / (420.0 * self.scale) + self.phase,
                    py / (420.0 * self.scale),
                    3,
                );
        (radius, rim, azimuth)
    }

    fn opening(&self, radius: f64, rim: f64, azimuth: f64) -> f64 {
        if !self.collapsed {
            return 0.0;
        }
        let angle_distance = ((azimuth - self.breach_angle + PI).rem_euclid(TAU) - PI).abs();
        let breach =
            1.0 - smooth((angle_distance - self.breach_width * 0.40) / (self.breach_width * 0.60));
        breach * smooth((radius / rim - 0.30) / 0.30)
    }

    fn protection(&self, px: f64, py: f64, noise: &Noise, noise2: &Noise) -> f64 {
        let (radius, rim, azimuth) = self.geometry(px, py, noise, noise2);
        let crater = 1.0 - smooth((radius - rim) / (rim * 0.12));
        if !self.collapsed {
            return crater;
        }
        // The collapsed sector receives the same max-height surroundings as the
        // exterior, while the intact basin retains its own depression.
        crater * (1.0 - self.opening(radius, rim, azimuth))
    }

    fn influence(&self, px: f64, py: f64, noise: &Noise, noise2: &Noise) -> f64 {
        let (radius, _, _) = self.geometry(px, py, noise, noise2);
        let apron = if self.collapsed { 1.18 } else { 1.05 };
        let fade = |t: f64| {
            let t = t.clamp(0.0, 1.0);
            1.0 - t.powi(3) * (t * (6.0 * t - 15.0) + 10.0)
        };
        let outline = fade((radius - (apron - 0.25)) / 0.40);
        let width = self.scale * 2400.0;
        let support = (px / width - 0.5).hypot(py / width - 0.5);
        // Follow the volcanic apron, with circular support ending before the
        // local raster edge. Its raised foundation must never expose a square.
        outline * fade((support - 0.39) / 0.10)
    }

    fn elevation(&self, px: f64, py: f64, rough: f64, noise: &Noise, noise2: &Noise) -> f64 {
        let (radius, rim, azimuth) = self.geometry(px, py, noise, noise2);
        let (floor, start, crest, apron, exponent) = if self.collapsed {
            (0.06, 0.58, 0.96, 1.18, 1.45)
        } else {
            (0.36, 0.36, 0.98, 1.05, 1.6)
        };
        let t = ((radius / rim - start) / (1.0 - start)).clamp(0.0, 1.0);
        let bowl = floor + (crest - floor) * t.powi(3) * (t * (6.0 * t - 15.0) + 10.0);
        let outer = crest
            * (1.0 - (radius - rim) / (apron - rim))
                .max(0.0)
                .powf(exponent);
        // Round the crest instead of meeting two profiles at a hard slope break.
        let crown = smooth((radius / rim - 0.94) / 0.12);
        let mut cone = bowl * (1.0 - crown) + outer * crown;
        let opening = self.opening(radius, rim, azimuth);
        if self.collapsed {
            // A full-width sector reaches exactly the basin floor, then falls to the apron.
            // Multiplying the rim by a percentage left a closed barrier at the outlet.
            let outlet = 0.06 * (1.0 - smooth((radius - rim * 0.65) / (1.18 - rim * 0.65)));
            cone = cone * (1.0 - opening) + outlet * opening;
        }
        let flutes = noise2.ridged(px / (360.0 * self.scale), py / (360.0 * self.scale), 3) - 0.5;
        let wall_noise = noise.fbm(px / (150.0 * self.scale), py / (150.0 * self.scale), 3);
        let interior = 1.0 - smooth((radius / rim - 0.82) / 0.18);
        let crater_noise = noise2.fbm(px / (380.0 * self.scale), py / (380.0 * self.scale), 3);
        let texture = (0.018 * rough + (0.055 * flutes + 0.025 * wall_noise) * cone)
            * (1.0 - interior)
            + 0.012 * crater_noise * interior;
        0.035 + cone + texture * (1.0 - opening)
    }
}

fn cavern(
    n: usize,
    _width: f64,
    amp: f64,
    _erosion: f64,
    noise: &Noise,
    noise2: &Noise,
    rng: Rng,
) -> (Vec<f32>, Vec<u8>) {
    let shape = CavernShape::new(rng);
    let mut height = vec![0.0; n * n];
    let mut mask = vec![1; n * n];
    for y in 0..n {
        for x in 0..n {
            let px = (x as f64 + 0.5) / n as f64;
            let py = (y as f64 + 0.5) / n as f64;
            let distance = shape.distance(px, py, noise);
            let floor = amp * (0.08 + 0.035 * noise2.fbm(px * 5.0, py * 5.0, 3));
            let i = y * n + x;
            mask[i] = u8::from(distance >= 0.0);
            // Rock falls continuously toward each opening, rather than a raised mask.
            height[i] = (floor + amp * smooth(distance / 0.035)) as f32;
        }
    }
    (height, mask)
}

fn generate_motif(
    seed: &str,
    width: f64,
    relief: &str,
    erosion: f64,
    resolution: usize,
    motif: f64,
    mountain_mix: f64,
) -> Result<PreparedTerrain, String> {
    normalize(
        generate_motif_base(
            seed,
            width,
            relief,
            erosion,
            resolution,
            motif,
            mountain_mix,
        )?
        .height,
    )
}
