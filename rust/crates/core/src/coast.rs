//! Detailed coasts, broad mainland sectors, branched islands and offshore rocks.
//! Signed distance is positive inland; GPU and CPU share this FP32 capsule plan.
use crate::{Noise, Rng, smooth};
use std::f64::consts::TAU;

pub(crate) struct Coast {
    rng: Rng,
    pub noise: Noise,
    pub parameters: Vec<f32>,
}

impl Coast {
    pub fn new(rng: Rng, width: f64, motif: f64, amp: f64, marine_datum: f64) -> Self {
        Self {
            noise: Noise::new(rng.fork("shore-noise")),
            rng,
            parameters: vec![
                0.0,
                0.0,
                (motif * 0.070).clamp(35.0, 450.0).min(width * 0.060) as f32 / width as f32,
                (amp * 0.25).clamp(12.0, 250.0) as f32,
                0.0,
                0.0,
                0.0,
                marine_datum as f32,
            ],
        }
    }

    pub fn configure(&mut self, mask: u32, mode: &str) -> Result<(), String> {
        if mask > 255 {
            return Err("Les côtes doivent être un masque de huit directions (0 à 255).".into());
        }
        if !matches!(mode, "island" | "archipelago" | "random") {
            return Err("Choisissez île, archipel ou aléatoire.".into());
        }
        self.parameters.truncate(8);
        self.parameters[0] = mask as f32;
        self.parameters[1] = 0.0;
        let mut profile = self.rng.fork("mainland-profile");
        let turn = profile.range(-0.15, 0.15);
        self.parameters[4] = profile.range(2.5, 4.5) as f32;
        self.parameters[5] = turn.cos() as f32;
        self.parameters[6] = turn.sin() as f32;
        if mask == 0 {
            return Ok(());
        }
        let mut rng = self.rng.fork("shape-v2");
        let archipelago =
            mode == "archipelago" || (mode == "random" && self.rng.fork("mode").float() < 0.5);
        if mask == 255 {
            let count = if archipelago {
                3 + (rng.float() * 5.0) as usize
            } else {
                1
            };
            let mut centers: Vec<(f64, f64)> = Vec::new();
            if archipelago {
                let separation = 0.20 + (7 - count) as f64 * 0.025;
                for _ in 0..512 {
                    let candidate = (rng.range(0.18, 0.82), rng.range(0.18, 0.82));
                    if centers
                        .iter()
                        .all(|&(x, y)| (candidate.0 - x).hypot(candidate.1 - y) >= separation)
                    {
                        centers.push(candidate);
                    }
                    if centers.len() == count {
                        break;
                    }
                }
                if centers.len() != count {
                    let turn = rng.range(0.0, TAU);
                    centers = (0..count)
                        .map(|i| {
                            let a = turn + i as f64 * TAU / count as f64;
                            (0.5 + 0.27 * a.cos(), 0.5 + 0.27 * a.sin())
                        })
                        .collect();
                }
            } else {
                centers.push((rng.range(0.475, 0.525), rng.range(0.475, 0.525)));
            }
            for (i, &(cx, cy)) in centers.iter().enumerate() {
                let radius = if archipelago {
                    let spacing = centers
                        .iter()
                        .enumerate()
                        .filter(|&(j, _)| j != i)
                        .map(|(_, &(x, y))| (cx - x).hypot(cy - y))
                        .fold(1.0_f64, f64::min);
                    (spacing * 0.44)
                        .min(0.17)
                        .min(cx.min(cy).min(1.0 - cx).min(1.0 - cy) * 0.85)
                } else {
                    rng.range(0.35, 0.40)
                };
                let turn = rng.range(0.0, TAU);
                let point = |x: f64, y: f64| {
                    (
                        cx + radius * (x * turn.cos() - y * turn.sin()),
                        cy + radius * (x * turn.sin() + y * turn.cos()),
                    )
                };
                let phase = rng.range(0.0, 100.0);
                let segments = 3 + (rng.float() * 3.0) as usize;
                let mut last = point(-0.5, rng.range(-0.16, 0.16));
                let mut last_radius = radius * rng.range(0.21, 0.31);
                for j in 1..=segments {
                    let next = point(-0.5 + j as f64 / segments as f64, rng.range(-0.19, 0.19));
                    let next_radius = radius
                        * if j == segments {
                            rng.range(0.18, 0.30)
                        } else {
                            rng.range(0.28, 0.40)
                        };
                    self.capsule(last, next, last_radius, next_radius, radius, phase);
                    last = next;
                    last_radius = next_radius;
                }
                let side = if rng.float() < 0.5 { -1.0 } else { 1.0 };
                self.capsule(
                    point(0.0, 0.0),
                    point(rng.range(-0.15, 0.15), side * rng.range(0.40, 0.52)),
                    radius * 0.32,
                    radius * rng.range(0.17, 0.25),
                    radius,
                    phase,
                );
            }
        }
        // Detached rocks near the actual shore, including beside peninsulas.
        let wanted = if mask == 255 && archipelago {
            18 + (rng.float() * 15.0) as usize
        } else {
            6 + (rng.float() * 9.0) as usize
        };
        let mut sizes = self.rng.fork("islet-sizes");
        let radii: Vec<f64> = (0..wanted)
            .map(|i| {
                let size_class = if i == 0 {
                    0.95
                } else if i < 3 {
                    0.75
                } else {
                    sizes.float()
                };
                if size_class < 0.6 {
                    sizes.range(0.0025, 0.0085)
                } else if size_class < 0.9 {
                    sizes.range(0.009, 0.023)
                } else {
                    sizes.range(0.025, 0.045)
                }
            })
            .collect();
        let mut islets: Vec<(f64, f64, f64)> = Vec::new();
        let mut target_attempts = 0;
        for _ in 0..1800 {
            if islets.len() == wanted {
                break;
            }
            // Large outcrops need a larger offshore pocket; shrink gradually
            // only if the selected sea sectors cannot accommodate this target.
            let r = radii[islets.len()] * 0.8_f64.powi(target_attempts / 160).max(0.35);
            target_attempts += 1;
            let (x, y) = (rng.range(0.045, 0.955), rng.range(0.045, 0.955));
            let clearance = r * 2.2 + 0.004;
            if x.min(y).min(1.0 - x).min(1.0 - y) < r * 2.2 + 0.01 {
                continue;
            }
            let (distance, _, _, _) = self.distance(x, y, 0.0);
            if !(-clearance - 0.045..-clearance).contains(&distance)
                || islets
                    .iter()
                    .any(|&(ix, iy, ir)| (x - ix).hypot(y - iy) < (r + ir) * 2.2 + 0.007)
            {
                continue;
            }
            if (0..8).any(|i| {
                let angle = i as f64 * TAU / 8.0;
                self.distance(x + r * 2.2 * angle.cos(), y + r * 2.2 * angle.sin(), 0.0)
                    .0
                    > -0.003
            }) {
                continue;
            }
            let turn = rng.range(0.0, TAU);
            self.islet(&mut rng, x, y, r, turn);
            islets.push((x, y, r));
            target_attempts = 0;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn capsule(&mut self, a: (f64, f64), b: (f64, f64), ra: f64, rb: f64, scale: f64, phase: f64) {
        self.parameters.extend([
            a.0 as f32,
            a.1 as f32,
            b.0 as f32,
            b.1 as f32,
            ra as f32,
            rb as f32,
            scale as f32,
            phase as f32,
            0.0,
            0.0,
            0.0,
            1.0,
        ]);
        self.parameters[1] += 1.0;
    }

    fn islet(&mut self, rng: &mut Rng, x: f64, y: f64, r: f64, turn: f64) {
        let shape = (rng.float() * 6.0) as usize;
        let phase = rng.range(0.0, 100.0);
        // Low sandy outcrops and taller rocks are independent
        // of the mainland's height at their offshore position.
        let rocky = rng.float() < 0.55;
        let peak = if rocky {
            rng.range(0.45, 1.5) * (self.depth() * 0.8).clamp(10.0, 70.0)
        } else {
            rng.range(0.8, 5.0)
        };
        // Retain the former detail draws so removing interior noise does not
        // change this seed's silhouettes, sizes or subsequent placements.
        if rocky {
            rng.range(0.2, 0.5);
            rng.range(0.35, 0.8);
        }
        let apron = if rocky {
            rng.range(0.45, 1.0)
        } else {
            rng.range(1.5, 2.4)
        };
        let lean = rng.range(0.45, 0.85);
        let point = |a: (f64, f64)| {
            (
                x + r * (a.0 * turn.cos() - a.1 * turn.sin()),
                y + r * (a.0 * turn.sin() + a.1 * turn.cos()),
            )
        };
        let mut segment = |a, b, ra: f64, rb: f64| {
            self.capsule(point(a), point(b), r * ra, r * rb, r * 3.0, phase);
            let start = self.parameters.len() - 4;
            self.parameters[start..].copy_from_slice(&[peak as f32, 0.0, 0.0, apron as f32]);
        };
        match shape {
            // Compact asymmetric rock; no repeated long capsule.
            0 => segment((-0.2, 0.05), (0.25, -0.1), 0.95, lean),
            // Angular three-armed outcrop.
            1 => {
                segment((-0.6, 0.4), (0.2, -0.65), 0.5, 0.35);
                segment((-0.2, 0.0), (0.7, 0.35), 0.6, 0.35);
            }
            // Broad two-lobed island.
            2 => {
                segment((-0.55, 0.0), (0.1, 0.15), 0.85, 0.4);
                segment((0.0, 0.1), (0.75, -0.15), 0.4, lean);
            }
            // Crooked crescent, with a cove on its inner side.
            3 => {
                segment((-0.9, -0.35), (-0.3, 0.4), 0.28, 0.45);
                segment((-0.3, 0.4), (0.45, 0.4), 0.45, 0.4);
                segment((0.45, 0.4), (0.85, -0.25), 0.4, 0.22);
            }
            // Irregular branching reef or ridge.
            4 => {
                segment((-0.75, 0.0), (0.7, 0.1), 0.42, 0.36);
                segment((-0.15, 0.0), (-0.35, -0.8), 0.5, 0.25);
                segment((0.3, 0.05), (0.55, 0.7), 0.4, 0.3);
            }
            // Keep occasional long outcrops, rather than making all islets round.
            _ => segment((-1.2, -0.12), (1.0, 0.18), 0.42, 0.3),
        }
    }
    pub fn active(&self) -> bool {
        self.parameters[0] != 0.0
    }
    pub fn depth(&self) -> f64 {
        self.parameters[3] as f64
    }

    fn distance(&self, x: f64, y: f64, footprint: f64) -> (f64, f64, f64, f64) {
        let at = |i: usize| self.parameters[i] as f64;
        let mask = at(0) as u32;
        let mut distance = -2.0;
        let mut scale = 0.2;
        let mut islet_height = 0.0;
        let mut apron = 1.0;
        if mask != 255 {
            let (dx, dy) = (x - 0.5, y - 0.5);
            let r = dx.hypot(dy);
            let angle = (dx.atan2(-dy) / TAU * 8.0).rem_euclid(8.0);
            let a = angle.floor() as u32;
            let t = smooth(angle.fract());
            let reach = |i: u32| {
                if mask & (1 << (i & 7)) == 0 {
                    1.50
                } else {
                    0.64
                }
            };
            let edge = if r > 0.0 {
                let u = dx * at(5) + dy * at(6);
                let v = -dx * at(6) + dy * at(5);
                0.5 * r / (u.abs().powf(at(4)) + v.abs().powf(at(4))).powf(1.0 / at(4))
            } else {
                0.5
            };
            // Mainland sectors extend past the frame, instead of being clipped by other seas.
            distance = edge * (reach(a) * (1.0 - t) + reach(a + 1) * t) - r
                + 0.070
                    * self
                        .noise
                        .fbm_filtered(x / 0.26, y / 0.26, 7, 0.56, footprint / 0.26)
                + 0.020
                    * self
                        .noise
                        .fbm_filtered(x / 0.055, y / 0.055, 5, 0.55, footprint / 0.055);
        }
        let mut cached_phase = f64::NAN;
        let mut detail = 0.0;
        for i in 0..at(1) as usize {
            let j = 8 + i * 12;
            let (ax, ay, bx, by) = (at(j), at(j + 1), at(j + 2), at(j + 3));
            let (dx, dy) = (bx - ax, by - ay);
            let t =
                (((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy).max(1e-12)).clamp(0.0, 1.0);
            let base =
                at(j + 4) * (1.0 - t) + at(j + 5) * t - (x - ax - t * dx).hypot(y - ay - t * dy);
            let s = at(j + 6);
            if base + s * 0.165 <= distance {
                continue;
            }
            let phase = at(j + 7);
            if phase != cached_phase {
                detail = s
                    * (0.14
                        * self.noise.fbm_filtered(
                            x / (s * 1.1) + phase,
                            y / (s * 1.1) - phase,
                            7,
                            0.56,
                            footprint / (s * 1.1),
                        )
                        + 0.025
                            * self.noise.fbm_filtered(
                                x / (s * 0.13) - phase,
                                y / (s * 0.13) + phase,
                                4,
                                0.55,
                                footprint / (s * 0.13),
                            ));
                cached_phase = phase;
            }
            if base + detail > distance {
                distance = base + detail;
                scale = s;
                // A simple shared elevation per islet. Shore taper and physical
                // erosion provide its slopes; no fBm or ridged interior texture.
                islet_height = at(j + 8);
                apron = at(j + 11);
            }
        }
        (distance, scale, islet_height, apron)
    }

    pub fn apply(&self, x: f64, y: f64, width: f64, height: f64, footprint: f64) -> f64 {
        if !self.active() {
            return height;
        }
        // Coastal plains should not stand on their inland formula's constant
        // pedestal. Express elevations above the marine datum, with a smooth
        // positive floor so low pockets retain the selected coast geography.
        let datum = self.parameters[7] as f64;
        let height = if datum > 0.0 {
            let relative = height - datum;
            0.3 + 0.5 * (relative + (relative * relative + 1.0).sqrt())
        } else {
            height
        };
        let (distance, scale, islet_height, apron) =
            self.distance(x / width, y / width, footprint / width);
        let height = if islet_height > 0.0 {
            islet_height
        } else {
            height
        };
        // Alternate gentler shores and rocky cliffs, without tapering entire islands.
        let cliff =
            smooth((self.noise.fbm(x / (width * 0.12), y / (width * 0.12), 3) - 0.20) / 0.25);
        let width_variation = 0.65
            + 1.1
                * smooth(
                    self.noise
                        .fbm(x / (width * 0.21) + 11.7, y / (width * 0.21) - 4.2, 3)
                        + 0.5,
                );
        let ramp = (self.parameters[2] as f64)
            .max(height / (width * 0.45))
            .min(scale * 0.18)
            * width_variation
            * apron
            * (1.0 - 0.90 * cliff);
        if distance <= 0.0 {
            -self.depth() * smooth(-distance / (ramp * 4.0))
        } else {
            height * smooth(distance / ramp)
        }
    }
}
