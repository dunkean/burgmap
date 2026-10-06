use crate::rng::Rng;
use std::f64::consts::TAU;

pub(crate) struct Noise {
    pub(crate) perm: [u8; 512],
    pub(crate) gradients: [(f64, f64); 32],
}

impl Noise {
    pub fn new(mut rng: Rng) -> Self {
        let mut p = std::array::from_fn::<_, 256, _>(|i| i as u8);
        for i in (1..256).rev() {
            let j = (rng.float() * (i + 1) as f64).floor() as usize;
            p.swap(i, j);
        }
        Self {
            perm: std::array::from_fn(|i| p[i & 255]),
            gradients: std::array::from_fn(|i| {
                let angle = (i as f64 + 0.37) * TAU / 32.0;
                (angle.cos(), angle.sin())
            }),
        }
    }

    pub fn noise(&self, x: f64, y: f64) -> f64 {
        let f2 = 0.5 * (3.0_f64.sqrt() - 1.0);
        let g2 = (3.0 - 3.0_f64.sqrt()) / 6.0;
        let s = (x + y) * f2;
        let i = (x + s).floor() as i32;
        let j = (y + s).floor() as i32;
        let t = (i + j) as f64 * g2;
        let x0 = x - (i as f64 - t);
        let y0 = y - (j as f64 - t);
        let (i1, j1) = if x0 > y0 { (1, 0) } else { (0, 1) };
        let ii = (i & 255) as usize;
        let jj = (j & 255) as usize;
        let points = [
            (x0, y0, ii + self.perm[jj] as usize),
            (
                x0 - i1 as f64 + g2,
                y0 - j1 as f64 + g2,
                ii + i1 + self.perm[jj + j1] as usize,
            ),
            (
                x0 - 1.0 + 2.0 * g2,
                y0 - 1.0 + 2.0 * g2,
                ii + 1 + self.perm[jj + 1] as usize,
            ),
        ];
        let mut value = 0.0;
        for (px, py, index) in points {
            let a = 0.5 - px * px - py * py;
            if a > 0.0 {
                let (gx, gy) = self.gradients[(self.perm[index] & 31) as usize];
                value += a.powi(4) * (gx * px + gy * py);
            }
        }
        75.0 * value
    }

    pub fn fbm(&self, x: f64, y: f64, octaves: usize) -> f64 {
        self.fbm_gain(x, y, octaves, 0.5)
    }

    pub fn fbm_gain(&self, x: f64, y: f64, octaves: usize, gain: f64) -> f64 {
        self.fbm_filtered(x, y, octaves, gain, 0.0)
    }

    /// Pixel footprint in noise coordinates. Fade unresolved octaves without
    /// renormalizing the retained bands (large features must not change amplitude).
    pub fn fbm_filtered(&self, x: f64, y: f64, octaves: usize, gain: f64, footprint: f64) -> f64 {
        let (mut amp, mut freq, mut sum, mut norm) = (1.0, 1.0, 0.0, 0.0);
        for o in 0..octaves {
            let weight = band_weight(footprint * freq);
            if weight > 0.0 {
                sum += amp
                    * weight
                    * self.noise(x * freq + o as f64 * 17.3, y * freq - o as f64 * 9.1);
            }
            norm += amp;
            amp *= gain;
            freq *= 2.0;
        }
        sum / norm
    }

    pub fn ridged(&self, x: f64, y: f64, octaves: usize) -> f64 {
        self.ridged_filtered(x, y, octaves, 0.0)
    }

    pub fn ridged_filtered(&self, x: f64, y: f64, octaves: usize, footprint: f64) -> f64 {
        let (mut amp, mut freq, mut sum, mut norm, mut weight) = (1.0, 1.0, 0.0, 0.0, 1.0);
        for o in 0..octaves {
            let band = band_weight(footprint * freq);
            if band == 0.0 {
                // The missing ridge bands retain their neutral level.
                sum += amp * 0.5;
                norm += amp;
                amp *= 0.5;
                freq *= 2.0;
                continue;
            }
            let r = 1.0
                - self
                    .noise(x * freq + o as f64 * 31.7, y * freq + o as f64 * 5.3)
                    .abs();
            let v = r * r * weight;
            weight = (v * 1.6).clamp(0.0, 1.0);
            sum += amp * (0.5 + band * (v - 0.5));
            norm += amp;
            amp *= 0.5;
            freq *= 2.0;
        }
        sum / norm
    }
}

fn band_weight(footprint: f64) -> f64 {
    // Simplex contains frequencies above its nominal wavelength: retain at least
    // four samples per wavelength, with a smooth transition starting at eight.
    1.0 - crate::smooth((footprint - 0.125) / 0.125)
}
