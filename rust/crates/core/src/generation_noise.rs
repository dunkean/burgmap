//! Temporary interchange for externally evaluated generation noises.
//! This module describes pure numeric inputs; it has no GPU or browser dependency.
use crate::{Noise, Rng};

pub struct GenerationNoise<'a> {
    /// Interleaved environment, regional distribution, initial height, ridge skeleton.
    /// Empty preserves the CPU initial conditions and their drainage topology.
    pub coarse: &'a [f32],
    /// Interleaved X warp, Y warp, ridge detail, padding.
    pub fine: &'a [f32],
}

pub struct GenerationNoisePlan {
    pub parameters: Vec<f32>,
    pub permutations: Vec<u32>,
    pub gradients: Vec<f32>,
}

impl GenerationNoisePlan {
    pub fn generation(seed: &str, width: f64, relief: &str, motif: f64) -> Result<Self, String> {
        let kind = crate::Relief::parse(relief)?;
        let source_motif = if kind == crate::Relief::Valley {
            motif * kind.environment_scale()
        } else {
            motif
        };
        Self::new(seed, width, source_motif)
    }

    pub fn new(seed: &str, width: f64, motif: f64) -> Result<Self, String> {
        if seed.len() > 4096
            || !width.is_finite()
            || !(250.0..=100000.0).contains(&width)
            || !motif.is_finite()
            || !(250.0..=150000.0).contains(&motif)
        {
            return Err("Paramètres de bruit de génération invalides.".into());
        }
        let n = 1024;
        let nc = if width > motif * 3.0 { 640 } else { 320 };
        let cell = width / n as f64;
        let cc = width * 1.44 / nc as f64;
        let k = motif / 2400.0;
        let detail = (cell * 6.0).max(260.0 * k);
        let root = Rng::new(&format!("burgmap:{seed}")).fork("terrain");
        let noises = [
            Noise::new(root.fork("noise")),
            Noise::new(root.fork("noise2")),
        ];
        Ok(Self {
            parameters: vec![
                width as f32,
                n as f32,
                nc as f32,
                k as f32,
                cc as f32,
                (-width * 0.22) as f32,
                (1900.0 * k).max(cc * 4.0) as f32,
                (415.0 * k).max(cc * 4.0) as f32,
                (110.0 * k).max(cc * 4.0) as f32,
                detail as f32,
                (detail / (cell * 4.0)).log2().round().clamp(1.0, 6.0) as f32,
                cell as f32,
            ],
            permutations: noises
                .iter()
                .flat_map(|noise| noise.perm.iter().map(|&v| v as u32))
                .collect(),
            gradients: noises
                .iter()
                .flat_map(|noise| {
                    noise
                        .gradients
                        .iter()
                        .flat_map(|&(x, y)| [x as f32, y as f32])
                })
                .collect(),
        })
    }
}

impl GenerationNoisePlan {
    /// Same scalar configuration as the CPU mountain simulation; GPU adapter owns scheduling.
    pub fn erosion(
        seed: &str,
        width: f64,
        relief: &str,
        erosion: f64,
        motif: f64,
        mix: f64,
    ) -> Result<Self, String> {
        let kind = crate::Relief::parse(relief)?;
        if !matches!(
            kind,
            crate::Relief::Hills
                | crate::Relief::Mountains
                | crate::Relief::Mixed
                | crate::Relief::HighMountains
                | crate::Relief::Valley
                | crate::Relief::Canyon
        ) || !erosion.is_finite()
            || !(0.0..=2.0).contains(&erosion)
            || !mix.is_finite()
            || !(0.0..=1.0).contains(&mix)
        {
            return Err("Configuration d'érosion GPU invalide.".into());
        }
        let motif = if kind == crate::Relief::Valley {
            motif * kind.environment_scale()
        } else {
            motif
        };
        let source_kind = if kind == crate::Relief::Valley {
            crate::Relief::Mixed
        } else {
            kind
        };
        let mix = if source_kind == crate::Relief::Mixed && kind != crate::Relief::Valley {
            mix
        } else {
            0.5
        };
        let cfg = crate::mountain_parameters(source_kind, width, motif, mix);
        let mut plan = Self::new(seed, width, motif)?;
        let mut rng = Rng::new(&format!("burgmap:{seed}"))
            .fork("terrain")
            .fork("params");
        let side = [(0.0, -1.0), (1.0, 0.0), (0.0, 1.0), (-1.0, 0.0)]
            [(rng.float() * 4.0).floor() as usize];
        let angle = rng.range(-0.3, 0.3);
        let down = (
            side.0 * angle.cos() - side.1 * angle.sin(),
            side.0 * angle.sin() + side.1 * angle.cos(),
        );
        let strength = 0.12 * erosion;
        plan.parameters.extend([
            cfg.amp as f32,
            cfg.iterations as f32,
            cfg.mountain_mix as f32,
            cfg.talus as f32,
            cfg.detail as f32,
            cfg.diffusion as f32,
            strength as f32,
            (cfg.amp * 1.25 / cfg.iterations as f64) as f32,
            down.0 as f32,
            down.1 as f32,
            (strength * (width * 1.44 / cfg.coarse as f64) / (0.004_f64.sqrt() * motif)) as f32,
            erosion as f32,
        ]);
        plan.parameters.extend(crate::erosion::surface_parameters(
            width, motif, erosion, cfg.talus,
        ));
        plan.parameters.push(cfg.crest as f32);
        Ok(plan)
    }
}

impl GenerationNoisePlan {
    pub fn finite_shape(
        seed: &str,
        motif: f64,
        relief: &str,
        erosion: f64,
    ) -> Result<Self, String> {
        let kind = crate::Relief::parse(relief)?;
        if !matches!(
            kind,
            crate::Relief::Plateau | crate::Relief::Volcano | crate::Relief::Caldera
        ) || !erosion.is_finite()
            || !(0.0..=2.0).contains(&erosion)
        {
            return Err("Configuration de forme finie GPU invalide.".into());
        }
        let mut plan = Self::new(seed, motif, motif)?;
        let root = Rng::new(&format!("burgmap:{seed}")).fork("terrain");
        if kind == crate::Relief::Plateau {
            plan.parameters = crate::PlateauShape::new(motif, root.fork("plateau"))
                .parameters(kind.amplitude(motif), erosion);
        } else {
            plan.parameters = crate::VolcanoShape::new(
                motif,
                root.fork("volcano"),
                kind == crate::Relief::Caldera,
            )
            .parameters(kind.amplitude(motif));
            plan.parameters[13] = 0.55;
            plan.parameters[15] = kind.environment_scale() as f32;
        }
        let mut params = root.fork("params");
        let _ = params.float();
        let _ = params.range(-0.3, 0.3);
        plan.parameters[12] = params.range(0.0, 1000.0) as f32;
        Ok(plan)
    }
}
