use wasm_bindgen::prelude::*;

/// A square raster in meters. Cell centers are ((x + .5) * width / resolution, ...).
/// Array getters copy in a single batch: JS owns them independently of free().
#[wasm_bindgen]
pub struct TerrainOutput {
    terrain: burgmap_core::Terrain,
}

#[wasm_bindgen]
impl TerrainOutput {
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> f64 {
        self.terrain.x
    }
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> f64 {
        self.terrain.y
    }
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> f64 {
        self.terrain.width
    }

    #[wasm_bindgen(getter)]
    pub fn resolution(&self) -> u32 {
        self.terrain.resolution as u32
    }

    #[wasm_bindgen(getter)]
    pub fn min_height(&self) -> f32 {
        self.terrain.min_height
    }

    #[wasm_bindgen(getter)]
    pub fn max_height(&self) -> f32 {
        self.terrain.max_height
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> Vec<f32> {
        self.terrain.height.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn cave_mask(&self) -> Vec<u8> {
        self.terrain.cave_mask.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn normal_x(&self) -> Vec<f32> {
        self.terrain.normal_x.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn normal_y(&self) -> Vec<f32> {
        self.terrain.normal_y.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn normal_z(&self) -> Vec<f32> {
        self.terrain.normal_z.clone()
    }
}

/// Owns the prepared physical erosion field. Retain this object across camera changes.
#[wasm_bindgen]
pub struct TerrainEngine {
    generator: burgmap_core::TerrainGenerator,
}

#[wasm_bindgen]
impl TerrainEngine {
    #[allow(clippy::too_many_arguments)]
    pub fn with_source(
        seed: &str,
        width: f64,
        relief: &str,
        erosion: f64,
        motif_size: f64,
        mountain_mix: f64,
        source: &[f32],
        environment: Option<String>,
    ) -> Result<TerrainEngine, JsValue> {
        burgmap_core::TerrainGenerator::new_mixed_with_source(
            seed,
            width,
            relief,
            erosion,
            motif_size,
            mountain_mix,
            source,
            environment.as_deref(),
        )
        .map(|generator| TerrainEngine { generator })
        .map_err(|e| JsValue::from_str(&e))
    }
    /// Temporary interchange: externally evaluated FP32 noises, unchanged CPU erosion.
    #[allow(clippy::too_many_arguments)]
    pub fn with_generation_noise(
        seed: &str,
        width: f64,
        relief: &str,
        erosion: f64,
        motif_size: f64,
        mountain_mix: f64,
        coarse: &[f32],
        fine: &[f32],
        environment: Option<String>,
    ) -> Result<TerrainEngine, JsValue> {
        burgmap_core::TerrainGenerator::new_mixed_with_noise(
            seed,
            width,
            relief,
            erosion,
            motif_size,
            mountain_mix,
            Some(&burgmap_core::GenerationNoise { coarse, fine }),
            environment.as_deref(),
        )
        .map(|generator| TerrainEngine { generator })
        .map_err(|error| JsValue::from_str(&error))
    }
    #[wasm_bindgen(constructor)]
    pub fn new(
        seed: &str,
        width: f64,
        relief: &str,
        erosion: f64,
        motif_size: f64,
        mountain_mix: Option<f64>,
        environment: Option<String>,
    ) -> Result<TerrainEngine, JsValue> {
        burgmap_core::TerrainGenerator::new_with_environment(
            seed,
            width,
            relief,
            erosion,
            motif_size,
            mountain_mix.unwrap_or(0.5),
            environment.as_deref(),
        )
        .map(|generator| TerrainEngine { generator })
        .map_err(|error| JsValue::from_str(&error))
    }
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> f64 {
        self.generator.width()
    }

    pub fn prepare_environment(
        seed: &str,
        width: f64,
        relief: &str,
        erosion: f64,
        motif: f64,
    ) -> Result<Vec<f32>, JsValue> {
        burgmap_core::TerrainGenerator::prepare_environment(seed, width, relief, erosion, motif)
            .map_err(|error| JsValue::from_str(&error))
    }
    #[wasm_bindgen(getter)]
    pub fn motif_size(&self) -> f64 {
        self.generator.motif_size()
    }
    #[wasm_bindgen(getter)]
    pub fn min_height(&self) -> f64 {
        self.generator.min_height()
    }
    #[wasm_bindgen(getter)]
    pub fn max_height(&self) -> f64 {
        self.generator.max_height()
    }

    pub fn sampling_field(&self) -> Vec<f32> {
        self.generator.sampling_field()
    }
    pub fn sampling_parameters(&self) -> Vec<f64> {
        self.generator.sampling_parameters()
    }
    pub fn sampling_permutations(&self) -> Vec<u32> {
        self.generator.sampling_permutations()
    }
    pub fn sampling_gradients(&self) -> Vec<f32> {
        self.generator.sampling_gradients()
    }
    pub fn sampling_branches(&self) -> Vec<f32> {
        self.generator.sampling_branches()
    }
    pub fn sample_region(
        &self,
        x: f64,
        y: f64,
        extent: f64,
        resolution: f64,
    ) -> Result<TerrainOutput, JsValue> {
        let n = raster_resolution(resolution)?;
        self.generator
            .sample_region(x, y, extent, n)
            .map(|terrain| TerrainOutput { terrain })
            .map_err(|error| JsValue::from_str(&error))
    }
}

#[wasm_bindgen]
pub struct GenerationNoisePlan {
    plan: burgmap_core::GenerationNoisePlan,
}

#[wasm_bindgen]
impl GenerationNoisePlan {
    pub fn generation(
        seed: &str,
        width: f64,
        relief: &str,
        motif: f64,
    ) -> Result<GenerationNoisePlan, JsValue> {
        burgmap_core::GenerationNoisePlan::generation(seed, width, relief, motif)
            .map(|plan| GenerationNoisePlan { plan })
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn finite_shape(
        seed: &str,
        motif: f64,
        relief: &str,
        erosion: f64,
    ) -> Result<GenerationNoisePlan, JsValue> {
        burgmap_core::GenerationNoisePlan::finite_shape(seed, motif, relief, erosion)
            .map(|plan| GenerationNoisePlan { plan })
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn erosion(
        seed: &str,
        width: f64,
        relief: &str,
        erosion: f64,
        motif: f64,
        mix: f64,
    ) -> Result<GenerationNoisePlan, JsValue> {
        burgmap_core::GenerationNoisePlan::erosion(seed, width, relief, erosion, motif, mix)
            .map(|plan| GenerationNoisePlan { plan })
            .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen(constructor)]
    pub fn new(seed: &str, width: f64, motif: f64) -> Result<GenerationNoisePlan, JsValue> {
        burgmap_core::GenerationNoisePlan::new(seed, width, motif)
            .map(|plan| GenerationNoisePlan { plan })
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn parameters(&self) -> Vec<f32> {
        self.plan.parameters.clone()
    }
    pub fn permutations(&self) -> Vec<u32> {
        self.plan.permutations.clone()
    }
    pub fn gradients(&self) -> Vec<f32> {
        self.plan.gradients.clone()
    }
}

fn raster_resolution(resolution: f64) -> Result<usize, JsValue> {
    if !resolution.is_finite()
        || resolution.fract() != 0.0
        || !(64.0..=1024.0).contains(&resolution)
    {
        return Err(JsValue::from_str(
            "La résolution doit être un entier de 64 à 1 024.",
        ));
    }
    Ok(resolution as usize)
}

#[wasm_bindgen]
pub fn generate_terrain(
    seed: &str,
    width: f64,
    relief: &str,
    erosion: f64,
    resolution: f64,
) -> Result<TerrainOutput, JsValue> {
    burgmap_core::generate_terrain(seed, width, relief, erosion, raster_resolution(resolution)?)
        .map(|terrain| TerrainOutput { terrain })
        .map_err(|error| JsValue::from_str(&error))
}
