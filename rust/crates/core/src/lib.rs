//! First isolated Rust generation stage. World coordinates and elevations are meters.
//! The square raster uses cell centers and has its origin at the upper left.
mod engine;
mod erosion;
mod noise;
mod rng;

use erosion::{MountainCfg, erode_shape, mountain};
use noise::Noise;
use rng::Rng;
use std::f64::consts::{PI, TAU};

pub use engine::TerrainGenerator;

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
    Plateau,
    HighMountains,
    Volcano,
    Caldera,
    Cavern,
}

impl Relief {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "flat" => Ok(Self::Flat),
            "hills" => Ok(Self::Hills),
            "valley" => Ok(Self::Valley),
            "canyon" => Ok(Self::Canyon),
            "mountains" => Ok(Self::Mountains),
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
            Self::Hills => (80.0 * extent.powf(0.85)).min(380.0),
            Self::Valley => (110.0 * extent.powf(0.85)).min(1100.0),
            Self::Canyon => (260.0 * extent.powf(0.78)).min(1800.0),
            Self::Mountains => (400.0 * extent.powf(0.78)).min(2600.0),
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
fn generate_motif(
    seed: &str,
    width: f64,
    relief: &str,
    erosion: f64,
    resolution: usize,
) -> Result<Terrain, String> {
    if !width.is_finite() || !(250.0..=50000.0).contains(&width) {
        return Err("Le motif doit être compris entre 250 et 50 000 mètres.".into());
    }
    if !erosion.is_finite() || !(0.0..=1.0).contains(&erosion) {
        return Err("Le niveau d’érosion doit être compris entre 0 et 1.".into());
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
    let root = Rng::new(&format!("burgmap:{seed}")).fork("terrain");
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
    let k = width / 2400.0;
    let valley_width = params.range(180.0, 320.0) * k;
    let valley_offset = params.range(-0.08, 0.08) * width;
    let amp = relief.amplitude(width);
    let mut cave_mask = Vec::new();
    let mut height = if matches!(
        relief,
        Relief::Hills | Relief::Valley | Relief::Mountains | Relief::HighMountains
    ) {
        let gentle = matches!(relief, Relief::Hills | Relief::Valley);
        let high = relief == Relief::HighMountains;
        mountain(&MountainCfg {
            n,
            width,
            amp: amp
                * if relief == Relief::Valley {
                    0.65
                } else if gentle {
                    1.05
                } else {
                    1.2
                },
            noise: &noise,
            noise2: &noise2,
            down,
            k,
            iterations: if gentle { 18 } else { 22 },
            coarse: 320,
            talus: if gentle {
                0.2
            } else if high {
                1.4
            } else {
                0.85
            },
            detail: if gentle {
                0.025
            } else if high {
                0.085
            } else {
                0.05
            },
            diffusion: if gentle {
                0.7
            } else if high {
                0.12
            } else {
                0.3
            },
            valley: (relief == Relief::Valley).then_some((valley_width, valley_offset, offset)),
            erosion,
        })
    } else if relief == Relief::Cavern {
        let (h, mask) = cavern(n, width, amp, erosion, &noise, &noise2, root.fork("cavern"));
        cave_mask = mask;
        h
    } else {
        vec![0.0; n * n]
    };
    let volcano = VolcanoShape::new(width, root.fork("volcano"), relief == Relief::Caldera);
    let mut plateau_params = root.fork("plateau");
    let mesa_level = plateau_params.range(0.38, 0.58);
    let mesa_angle = plateau_params.range(0.0, TAU);
    let mesa_axis = plateau_params.range(0.65, 1.25);
    let mesa_phase = plateau_params.range(0.0, 100.0);
    for y in 0..n {
        for x in 0..n {
            let i = y * n + x;
            let px = (x as f64 + 0.5) * cell;
            let py = (y as f64 + 0.5) * cell;
            let along = (px - width * 0.5) * down.0 + (py - width * 0.5) * down.1;
            let across = -(px - width * 0.5) * down.1 + (py - width * 0.5) * down.0;
            let q = along / width + 0.5;
            let rough = noise.fbm((px + offset) / (720.0 * k), py / (720.0 * k), 4);
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
                Relief::Canyon => {
                    let meander = 180.0 * k * noise.fbm((along + offset) / (1680.0 * k), 0.37, 3)
                        + 43.2 * k * noise2.fbm(along / (528.0 * k), 4.1, 2);
                    let distance = (across + meander - valley_offset).abs();
                    let floor = width * (0.025 + erosion * 0.025);
                    let wall = smooth((distance - floor) / (width * (0.045 + erosion * 0.055)));
                    let terraces = (wall * 3.0).floor() / 3.0;
                    let shoulder = wall * 0.88 + terraces * 0.12;
                    let tributary = noise2.ridged((px + offset) / (290.0 * k), py / (290.0 * k), 4);
                    let slope_texture = noise.fbm(px / (95.0 * k), py / (95.0 * k), 3);
                    amp * (0.05 + 0.82 * shoulder + 0.08 * rough * wall + 0.08 * (1.0 - q)
                        - 0.07 * tributary * wall * (1.0 - 0.6 * wall)
                        + 0.014 * slope_texture * wall)
                }
                Relief::Plateau => {
                    let dx = (px - width * 0.5) / (width * 0.48);
                    let dy = (py - width * 0.5) / (width * 0.48);
                    let rx = dx * mesa_angle.cos() + dy * mesa_angle.sin();
                    let ry = (-dx * mesa_angle.sin() + dy * mesa_angle.cos()) / mesa_axis;
                    let lobes = noise.fbm(px / (840.0 * k) + mesa_phase, py / (840.0 * k), 4);
                    let boundary = rx.hypot(ry)
                        + 0.32 * lobes
                        + 0.09 * noise2.fbm(px / (330.0 * k), py / (330.0 * k), 3);
                    let apron = 1.0 - smooth((boundary - 0.70) / (0.12 + erosion * 0.12));
                    let upper = 1.0 - smooth((boundary - mesa_level) / (0.08 + erosion * 0.06));
                    let upper_lobe = smooth(
                        (noise2.fbm(px / (650.0 * k) + mesa_phase, py / (650.0 * k), 3) - 0.03)
                            / 0.22,
                    );
                    let buttes = smooth(
                        (noise.fbm(px / (510.0 * k) - mesa_phase, py / (510.0 * k), 3) - 0.16)
                            / 0.22,
                    ) * (1.0 - smooth((rx.hypot(ry) - 1.0) / 0.22));
                    let remnant = noise2.ridged(px / (250.0 * k), py / (250.0 * k), 4);
                    amp * (0.06
                        + 0.46 * apron
                        + 0.31 * upper
                        + 0.13 * upper_lobe * apron
                        + 0.25 * buttes * (1.0 - apron)
                        + 0.055 * remnant * upper
                        + 0.025 * rough)
                }
                Relief::Volcano | Relief::Caldera => {
                    amp * volcano.elevation(px, py, rough, &noise, &noise2)
                }
                _ => height[i] as f64,
            };
            height[i] = h as f32;
        }
    }
    if matches!(
        relief,
        Relief::Flat | Relief::Canyon | Relief::Plateau | Relief::Volcano | Relief::Caldera
    ) {
        erode_shape(
            &mut height,
            n,
            cell,
            erosion,
            if relief == Relief::Flat { 0.03 } else { 0.95 },
        );
    }
    // Historical relief normalization: shift p1 to 1m without changing physical slope.
    // Rock height and cave floor remain a separate, explicitly marked raster.
    let mut sorted = height.clone();
    sorted.sort_unstable_by(f32::total_cmp);
    let p1 = sorted[(sorted.len() as f64 * 0.01).floor() as usize];
    for value in &mut height {
        *value = (1.0 + *value - p1).max(0.3);
    }
    if height.iter().any(|h| !h.is_finite()) {
        return Err("La génération a produit une altitude non finie.".into());
    }
    let min_height = height.iter().copied().fold(f32::INFINITY, f32::min);
    let max_height = height.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    Ok(Terrain {
        x: 0.0,
        y: 0.0,
        width,
        resolution: n,
        min_height,
        max_height,
        height,
        cave_mask,
        normal_x: Vec::new(),
        normal_y: Vec::new(),
        normal_z: Vec::new(),
    })
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

    fn rock(&self, px: f64, py: f64, motif: f64, erosion: f64, noise: &Noise) -> u8 {
        let mut distance = f64::INFINITY;
        for chamber in &self.chambers {
            distance = distance.min(
                (px - chamber.x).hypot(py - chamber.y) - chamber.radius * (1.0 + erosion * 0.5),
            );
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
            distance = distance.min(d - radius * (1.0 + erosion * 0.8));
        }
        let scale = motif / 2400.0;
        let roughness = 0.009
            * (1.0 - erosion * 0.65)
            * noise.fbm(
                px * motif / (110.0 * scale),
                py * motif / (110.0 * scale),
                3,
            );
        u8::from(distance + roughness >= 0.0)
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

    fn elevation(&self, px: f64, py: f64, rough: f64, noise: &Noise, noise2: &Noise) -> f64 {
        let dx = px - self.center.0;
        let dy = py - self.center.1;
        let x = dx * self.rotation.cos() + dy * self.rotation.sin();
        let y = (-dx * self.rotation.sin() + dy * self.rotation.cos()) / self.axis;
        let azimuth = y.atan2(x);
        let angular = noise.fbm(
            azimuth.cos() * 2.0 + self.phase,
            azimuth.sin() * 2.0 - 2.3,
            3,
        );
        let geographic = noise2.fbm(
            (px + self.phase) / (620.0 * self.scale),
            py / (620.0 * self.scale),
            3,
        );
        let wobble =
            1.0 + (if self.collapsed { 0.14 } else { 0.075 }) * angular + 0.035 * geographic;
        let radius = x.hypot(y) / (self.radius * wobble);
        let rim = (if self.collapsed { 0.55 } else { 0.255 })
            + (if self.collapsed { 0.07 } else { 0.028 })
                * noise2.fbm(azimuth.cos() * 3.0, azimuth.sin() * 3.0 + self.phase, 2);
        let mut cone = if self.collapsed {
            // Broad low basin, steep irregular interior wall, then the outer apron.
            if radius <= rim {
                0.06 + 0.90 * smooth((radius / rim - 0.58) / 0.42)
            } else {
                0.96 * (1.0 - (radius - rim) / (1.18 - rim)).max(0.0).powf(1.45)
            }
        } else if radius <= rim {
            0.36 + 0.62 * smooth((radius / rim - 0.36) / 0.64)
        } else {
            (1.0 - (radius - rim) / (1.05 - rim)).max(0.0).powf(1.6)
        };
        let mut opening = 0.0;
        if self.collapsed {
            let angle_distance = ((azimuth - self.breach_angle + PI).rem_euclid(TAU) - PI).abs();
            // A full-width sector reaches exactly the basin floor, then falls to the apron.
            // Multiplying the rim by a percentage left a closed barrier at the outlet.
            let breach = 1.0
                - smooth((angle_distance - self.breach_width * 0.40) / (self.breach_width * 0.60));
            let rim_weight = smooth((radius / rim - 0.30) / 0.30);
            opening = breach * rim_weight;
            let outlet = 0.06 * (1.0 - smooth((radius - rim * 0.65) / (1.18 - rim * 0.65)));
            cone = cone * (1.0 - opening) + outlet * opening;
            cone *= 1.0 + 0.10 * angular * (1.0 - opening);
        }
        let flutes = noise2.ridged(px / (360.0 * self.scale), py / (360.0 * self.scale), 3) - 0.5;
        0.035 + cone + (0.04 * rough + 0.05 * flutes * cone) * (1.0 - opening)
    }
}

fn cavern(
    n: usize,
    width: f64,
    amp: f64,
    erosion: f64,
    noise: &Noise,
    noise2: &Noise,
    mut rng: Rng,
) -> (Vec<f32>, Vec<u8>) {
    // Connected network: every added chamber has an explicit tunnel to an earlier chamber.
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
    let cell = width / n as f64;
    let mut height = vec![0.0; n * n];
    let mut mask = vec![1; n * n];
    for y in 0..n {
        for x in 0..n {
            let px = (x as f64 + 0.5) / n as f64;
            let py = (y as f64 + 0.5) / n as f64;
            let wx = px * width;
            let wy = py * width;
            let mut distance = f64::INFINITY;
            for chamber in &chambers {
                distance = distance.min(
                    (px - chamber.x).hypot(py - chamber.y) - chamber.radius * (1.0 + erosion * 0.5),
                );
            }
            for &(a, b, radius) in &links {
                let dx = chambers[b].x - chambers[a].x;
                let dy = chambers[b].y - chambers[a].y;
                let length2 = dx * dx + dy * dy;
                let t = if length2 > 0.0 {
                    ((px - chambers[a].x) * dx + (py - chambers[a].y) * dy) / length2
                } else {
                    0.0
                };
                let t = t.clamp(0.0, 1.0);
                let d = (px - chambers[a].x - t * dx).hypot(py - chambers[a].y - t * dy);
                distance = distance.min(d - radius * (1.0 + erosion * 0.8));
            }
            let k = width / 2400.0;
            let roughness =
                0.009 * (1.0 - erosion * 0.65) * noise.fbm(wx / (110.0 * k), wy / (110.0 * k), 3);
            let d = distance + roughness;
            let i = y * n + x;
            mask[i] = u8::from(d >= 0.0);
            let floor = amp * (0.08 + 0.065 * noise2.fbm(wx / (480.0 * k), wy / (480.0 * k), 3));
            height[i] = floor as f32;
        }
    }
    // Floor erosion precedes the rock mask; walls never become artificial drainage channels.
    erode_shape(&mut height, n, cell, erosion, 0.12);
    for (i, value) in height.iter_mut().enumerate() {
        if mask[i] == 1 {
            *value += amp as f32;
        }
    }
    (height, mask)
}
