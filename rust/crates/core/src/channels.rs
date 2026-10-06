//! Fixed geographic drainage corridors: erosion changes slopes, never their topology.
use crate::{Noise, smooth};

pub(crate) struct Channels {
    motif: f64,
    phase: f64,
    offset: f64,
    first: i32,
    branches: Vec<[Branch; 2]>,
}

struct Branch {
    join: f64,
    across: f64,
    length: f64,
    bend_phase: f64,
}

impl Channels {
    pub fn new(
        motif: f64,
        phase: f64,
        offset: f64,
        extent: f64,
        noise: &Noise,
        noise2: &Noise,
    ) -> Self {
        let count = (extent / (motif * 2.6)).ceil() as i32 + 4;
        let mut result = Self {
            motif,
            phase,
            offset,
            first: -count,
            branches: Vec::new(),
        };
        result.offset -= motif
            * (2.8 * noise.fbm(0.0, phase, 2)
                + 0.65 * noise2.fbm(0.0, 7.1, 2)
                + 0.10 * noise.fbm(0.0, 3.7, 2));
        for index in -count..=count {
            let id = index as f64;
            result.branches.push(std::array::from_fn(|bank| {
                let side = if bank == 0 { -1.0 } else { 1.0 };
                let jitter = noise.noise(id * 1.73 + phase, side * 6.3);
                let join = (id + 0.5 + jitter * 0.28) * motif * 2.6;
                Branch {
                    join,
                    across: result.center(join, noise, noise2),
                    length: motif * (2.5 + 0.8 * noise2.noise(id + phase, side)),
                    bend_phase: noise2.noise(id * 3.1, side * 2.7) * 3.0,
                }
            }));
        }
        result
    }
    fn center(&self, along: f64, noise: &Noise, noise2: &Noise) -> f64 {
        self.offset
            + self.motif * 2.8 * noise.fbm(along / (self.motif * 12.0), self.phase, 2)
            + self.motif * 0.65 * noise2.fbm(along / (self.motif * 3.2), 7.1, 2)
            + self.motif * 0.10 * noise.fbm(along / self.motif, 3.7, 2)
    }

    /// A normalized cross-section. Zero is the floor, one the surrounding upland.
    pub fn wall(
        &self,
        along: f64,
        across: f64,
        narrow: bool,
        footprint: f64,
        noise: &Noise,
        noise2: &Noise,
    ) -> f64 {
        let floor = self.motif * if narrow { 0.018 } else { 0.065 };
        let slope = (self.motif * if narrow { 0.055 } else { 0.32 }).max(footprint);
        let distance = (across - self.center(along, noise, noise2)).abs();
        let mut wall = smooth((distance - floor) / slope);
        let spacing = self.motif * 2.6;
        // Tributaries join the same trunk on both banks and narrow toward their heads.
        // Looking up nearby confluences is bounded independently of map size.
        let cell = (along / spacing).floor() as i32;
        for index in cell - 1..=cell + 2 {
            let Some(branches) = self.branches.get((index - self.first) as usize) else {
                continue;
            };
            for (bank, branch) in branches.iter().enumerate() {
                let side = if bank == 0 { -1.0 } else { 1.0 };
                let join = branch.join;
                let r = side * (across - branch.across);
                let length = branch.length;
                if r < -self.motif * 0.25 || r > length {
                    continue;
                }
                let t = (r / length).max(0.0);
                let bend = self.motif
                    * 0.22
                    * (t * std::f64::consts::PI).sin()
                    * (branch.bend_phase + t * 3.0).sin()
                    * smooth(t / 0.15);
                let branch_along = join - 0.85 * r + bend;
                let d = (along - branch_along).abs() / 1.31;
                let taper = 1.0 - smooth((t - 0.45) / 0.55);
                let branch = smooth((d - floor * 0.65 * taper) / (slope * 0.7));
                // Do not clip an affluent at r=0: that half-plane cut left straight
                // edges across the shoulders even after smoothing the union.
                let entrance = smooth((r + self.motif * 0.25) / (self.motif * 0.25));
                let other = 1.0 - (1.0 - branch) * taper * entrance;
                // Blend intersecting valley shoulders instead of a hard minimum crease.
                // A clipped profile at 1 represents no incision. It must remain
                // neutral, rather than carving a strip from smooth_min(1, 1).
                let width = 0.22 * smooth((1.0 - wall) / 0.15) * smooth((1.0 - other) / 0.15);
                let blend = if width > 1e-9 {
                    ((width - (wall - other).abs()) / width).max(0.0)
                } else {
                    0.0
                };
                wall = (wall.min(other) - width * 0.25 * blend * blend).max(0.0);
            }
        }
        wall
    }
}
