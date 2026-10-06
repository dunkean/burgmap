//! A fixed tortuous drainage network and fractured cross-sections in geographic meters.
use crate::{Noise, smooth};
use std::collections::HashMap;

#[derive(Clone, Copy)]
struct Point {
    a: f64,
    c: f64,
}
struct Segment {
    start: Point,
    end: Point,
}

pub(crate) struct Canyon {
    motif: f64,
    segments: Vec<Segment>,
    bins: HashMap<(i32, i32), Vec<usize>>,
}

pub(crate) struct Section {
    pub wall: f64,
    pub debris: f64,
}

impl Canyon {
    pub fn new(motif: f64, phase: f64, extent: f64, noise: &Noise, noise2: &Noise) -> Self {
        let spacing = motif * 1.8;
        let count = (extent / spacing).ceil() as i32 + 5;
        let origin = 2.8 * noise.fbm(0.0, phase, 2) + 0.65 * noise2.fbm(0.0, 7.1, 2);
        let center = |a: f64| {
            motif
                * (2.8 * noise.fbm(a / (motif * 12.0), phase, 2)
                    + 0.65 * noise2.fbm(a / (motif * 3.2), 7.1, 2)
                    - origin)
        };
        let mut controls = Vec::new();
        for index in -count..=count {
            let id = index as f64;
            let start = id * spacing;
            let turn = noise.noise(id * 1.37 + phase, 8.4);
            let side = if turn < 0.0 { -1.0 } else { 1.0 };
            let reach = motif * (0.65 + 0.50 * noise2.noise(id + phase, 1.8).abs());
            controls.push(Point {
                a: start,
                c: center(start),
            });
            // Reverse along the valley at the second control: actual hairpins,
            // rather than a sine wave that can only move downstream.
            let first = start + spacing * (0.68 + turn.abs() * 0.10);
            let second = start + spacing * (0.42 + turn.abs() * 0.08);
            controls.push(Point {
                a: first,
                c: center(first) + side * reach * 0.25,
            });
            controls.push(Point {
                a: second,
                c: center(second) + side * reach,
            });
        }
        let mut result = Self {
            motif,
            segments: Vec::new(),
            bins: HashMap::new(),
        };
        let trunk = spline(&controls, motif / 64.0);
        result.add_path(&trunk);
        // Confluences are on the actual sampled trunk, so every tributary connects.
        for (group, points) in controls.chunks(3).enumerate() {
            if points.len() < 3 {
                continue;
            }
            let anchor = points[1];
            let id = group as f64 - count as f64;
            let side = if noise2.noise(id + phase, 9.3) < 0.0 {
                -1.0
            } else {
                1.0
            };
            let length = motif * (1.5 + noise.noise(id + phase, 4.9).abs());
            let branch = [
                anchor,
                Point {
                    a: anchor.a - length * 0.35,
                    c: anchor.c + side * length * 0.35,
                },
                Point {
                    a: anchor.a - length * 0.10,
                    c: anchor.c + side * length * 0.65,
                },
                Point {
                    a: anchor.a - length * 0.90,
                    c: anchor.c + side * length,
                },
            ];
            let branch_path = spline(&branch, motif / 64.0);
            result.add_path(&branch_path);
            let fork = branch_path[branch_path.len() / 2];
            result.add_path(&spline(
                &[
                    fork,
                    Point {
                        a: fork.a + length * 0.25,
                        c: fork.c + side * length * 0.30,
                    },
                    Point {
                        a: fork.a + length * 0.10,
                        c: fork.c + side * length * 0.65,
                    },
                ],
                motif / 64.0,
            ));
        }
        result
    }

    fn add_path(&mut self, path: &[Point]) {
        let size = self.motif * 0.12;
        let padding = self.motif * 0.22;
        for pair in path.windows(2) {
            let id = self.segments.len();
            self.segments.push(Segment {
                start: pair[0],
                end: pair[1],
            });
            let min_a = ((pair[0].a.min(pair[1].a) - padding) / size).floor() as i32;
            let max_a = ((pair[0].a.max(pair[1].a) + padding) / size).floor() as i32;
            let min_c = ((pair[0].c.min(pair[1].c) - padding) / size).floor() as i32;
            let max_c = ((pair[0].c.max(pair[1].c) + padding) / size).floor() as i32;
            for a in min_a..=max_a {
                for c in min_c..=max_c {
                    self.bins.entry((a, c)).or_default().push(id);
                }
            }
        }
    }

    pub fn section(
        &self,
        a: f64,
        c: f64,
        footprint: f64,
        noise: &Noise,
        noise2: &Noise,
    ) -> Section {
        let size = self.motif * 0.12;
        let Some(candidates) = self
            .bins
            .get(&((a / size).floor() as i32, (c / size).floor() as i32))
        else {
            return Section {
                wall: 1.0,
                debris: 0.0,
            };
        };
        let mut distance2 = f64::INFINITY;
        for &id in candidates {
            let s = &self.segments[id];
            let da = s.end.a - s.start.a;
            let dc = s.end.c - s.start.c;
            let t = (((a - s.start.a) * da + (c - s.start.c) * dc)
                / (da * da + dc * dc).max(1e-12))
            .clamp(0.0, 1.0);
            distance2 =
                distance2.min((a - s.start.a - t * da).powi(2) + (c - s.start.c - t * dc).powi(2));
        }
        let geology = noise.fbm_filtered(
            a / (self.motif * 0.32),
            c / (self.motif * 0.32),
            7,
            0.5,
            footprint / (self.motif * 0.32),
        );
        let fracture = noise2.ridged_filtered(
            a / (self.motif * 0.10),
            c / (self.motif * 0.10),
            7,
            footprint / (self.motif * 0.10),
        );
        let floor = self.motif * (0.018 + 0.010 * geology);
        let slope = self.motif * (0.070 + 0.025 * geology);
        let distance = distance2.sqrt() + self.motif * 0.018 * geology;
        let t = (distance - floor) / slope;
        // Unequal rock benches and short cliffs, broken by the same geological field.
        let ledge = 0.30 + geology * 0.20;
        let mut wall = 0.35 * smooth(t / 0.20)
            + 0.30 * smooth((t - ledge) / 0.18)
            + 0.35 * smooth((t - 0.68 - geology * 0.12) / 0.32);
        let antialias = smooth((footprint / slope - 0.10) / 0.45);
        wall = wall * (1.0 - antialias) + smooth(t) * antialias;
        let rock = smooth((fracture - 0.53) / 0.25);
        let debris = rock * (0.018 + 0.085 * smooth(t / 0.22)) * (1.0 - smooth((t - 0.65) / 0.40));
        Section { wall, debris }
    }
}

fn spline(controls: &[Point], step: f64) -> Vec<Point> {
    let mut result = Vec::new();
    result.push(controls[0]);
    for i in 0..controls.len() - 1 {
        let p0 = controls[i.saturating_sub(1)];
        let p1 = controls[i];
        let p2 = controls[i + 1];
        let p3 = controls[(i + 2).min(controls.len() - 1)];
        let count = (((p2.a - p1.a).hypot(p2.c - p1.c)
            + (p1.a - p0.a).hypot(p1.c - p0.c) * 0.25
            + (p3.a - p2.a).hypot(p3.c - p2.c) * 0.25)
            / step)
            .ceil()
            .max(2.0) as usize;
        for j in 1..=count {
            let t = j as f64 / count as f64;
            let interpolate = |a: f64, b: f64, c: f64, d: f64| {
                0.5 * (2.0 * b
                    + (-a + c) * t
                    + (2.0 * a - 5.0 * b + 4.0 * c - d) * t * t
                    + (-a + 3.0 * b - 3.0 * c + d) * t * t * t)
            };
            result.push(Point {
                a: interpolate(p0.a, p1.a, p2.a, p3.a),
                c: interpolate(p0.c, p1.c, p2.c, p3.c),
            });
        }
    }
    result
}
