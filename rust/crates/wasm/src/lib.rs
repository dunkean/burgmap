use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}

/// Cached terrain drainage. Vector regeneration does not repeat terrain/coast preparation.
#[wasm_bindgen]
pub struct HydrologyEngine {
    engine: magna_urbis_core::HydrologyEngine,
}

#[wasm_bindgen]
impl HydrologyEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(
        seed: &str,
        width: f64,
        resolution: f64,
        height: &[f32],
        sea_enabled: bool,
    ) -> Result<HydrologyEngine, JsValue> {
        magna_urbis_core::HydrologyEngine::new(
            seed,
            width,
            raster_resolution(resolution)?,
            height,
            sea_enabled,
        )
        .map(|engine| Self { engine })
        .map_err(|e| JsValue::from_str(&e))
    }
    #[allow(clippy::too_many_arguments)]
    pub fn with_drainage(
        seed: &str,
        width: f64,
        resolution: f64,
        height: &[f32],
        sea_enabled: bool,
        filled: &[f32],
        receivers: &[u32],
        accumulation: &[f32],
    ) -> Result<HydrologyEngine, JsValue> {
        magna_urbis_core::HydrologyEngine::with_drainage(
            seed,
            width,
            raster_resolution(resolution)?,
            height,
            sea_enabled,
            filled,
            receivers,
            accumulation,
        )
        .map(|engine| Self { engine })
        .map_err(|e| JsValue::from_str(&e))
    }
    pub fn filled(&self) -> Vec<f32> {
        self.engine.filled().to_vec()
    }
    pub fn receivers(&self) -> Vec<u32> {
        self.engine.receivers().to_vec()
    }
    pub fn accumulation(&self) -> Vec<f32> {
        self.engine.accumulation().to_vec()
    }
    #[allow(clippy::too_many_arguments)]
    pub fn generate(
        &self,
        main: &str,
        density: f32,
        wetness: f32,
        lakes: &str,
        meanders: &str,
        meander_intensity: f32,
        estuary: &str,
        width_scale: f32,
        incision: f32,
        min_lake_area: f32,
        lake_abundance: Option<f32>,
        lake_coverage: Option<f32>,
        max_lake_area: Option<f32>,
        depression_policy: Option<String>,
        max_breach_depth: Option<f32>,
        max_breach_length: Option<f32>,
    ) -> Result<HydrologyOutput, JsValue> {
        let defaults = magna_urbis_core::HydrologyConfig::default();
        let cfg = magna_urbis_core::HydrologyConfig {
            main: main.into(),
            density,
            wetness,
            lakes: lakes.into(),
            meanders: meanders.into(),
            meander_intensity,
            estuary: estuary.into(),
            width_scale,
            incision,
            min_lake_area,
            lake_abundance: lake_abundance.unwrap_or(defaults.lake_abundance),
            lake_coverage: lake_coverage.unwrap_or(defaults.lake_coverage),
            max_lake_area: max_lake_area.unwrap_or(defaults.max_lake_area),
            depression_policy: depression_policy.unwrap_or(defaults.depression_policy),
            max_breach_depth: max_breach_depth.unwrap_or(defaults.max_breach_depth),
            max_breach_length: max_breach_length.unwrap_or(defaults.max_breach_length),
        };
        let mut previous = performance_now();
        let mut stage_ms = Vec::new();
        let mut stage_labels = Vec::new();
        self.engine
            .generate_profiled(&cfg, &mut |label| {
                let now = performance_now();
                stage_ms.push(now - previous);
                previous = now;
                stage_labels.push(label);
            })
            .map(|output| HydrologyOutput {
                output,
                stage_ms,
                stage_labels: stage_labels.join(","),
            })
            .map_err(|e| JsValue::from_str(&e))
    }
}

/// Batch-copy getters; JS owns arrays independently of this wrapper's lifetime.
#[wasm_bindgen]
pub struct HydrologyOutput {
    output: magna_urbis_core::HydrologyOutput,
    stage_ms: Vec<f64>,
    stage_labels: String,
}

#[wasm_bindgen]
impl HydrologyOutput {
    #[wasm_bindgen(getter)]
    pub fn stage_ms(&self) -> Vec<f64> {
        self.stage_ms.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn stage_labels(&self) -> String {
        self.stage_labels.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> f32 {
        self.output.width
    }
    #[wasm_bindgen(getter)]
    pub fn resolution(&self) -> u32 {
        self.output.resolution as u32
    }
    #[wasm_bindgen(getter)]
    pub fn receivers(&self) -> Vec<u32> {
        self.output.receivers.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn accumulation(&self) -> Vec<f32> {
        self.output.accumulation.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn basins(&self) -> Vec<u32> {
        self.output.basins.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn filled(&self) -> Vec<f32> {
        self.output.filled.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn raw_receivers(&self) -> Vec<u32> {
        self.output.raw_receivers.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn raw_accumulation(&self) -> Vec<f32> {
        self.output.raw_accumulation.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn raw_basins(&self) -> Vec<u32> {
        self.output.raw_basins.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn flat_labels(&self) -> Vec<u32> {
        self.output.flat_labels.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn flat_rank(&self) -> Vec<u32> {
        self.output.flat_rank.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn external_inflow_area(&self) -> f32 {
        self.output.external_inflow_area
    }
    #[wasm_bindgen(getter)]
    pub fn raw_filled(&self) -> Vec<f32> {
        self.output.raw_filled.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn raw_drainage_height(&self) -> Vec<f32> {
        self.output.raw_drainage_height.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn breach_count(&self) -> u32 {
        self.output.breach_count
    }
    #[wasm_bindgen(getter)]
    pub fn breach_cut_volume_m3(&self) -> f32 {
        self.output.breach_cut_volume_m3
    }
    #[wasm_bindgen(getter)]
    pub fn avoided_fill_volume_m3(&self) -> f32 {
        self.output.avoided_fill_volume_m3
    }
    #[wasm_bindgen(getter)]
    pub fn lake_depth(&self) -> Vec<f32> {
        self.output.lake_depth.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn lake_labels(&self) -> Vec<u32> {
        self.output.lake_labels.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn drainage_height(&self) -> Vec<f32> {
        self.output.drainage_height.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn surface_height(&self) -> Vec<f32> {
        self.output.surface_height.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn adjusted_height(&self) -> Vec<f32> {
        self.output.adjusted_height.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn river_points(&self) -> Vec<f32> {
        self.output.river_points.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn river_offsets(&self) -> Vec<u32> {
        self.output.river_offsets.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn river_meta(&self) -> Vec<u32> {
        self.output.river_meta.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn node_points(&self) -> Vec<f32> {
        self.output.node_points.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn node_meta(&self) -> Vec<u32> {
        self.output.node_meta.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn lake_points(&self) -> Vec<f32> {
        self.output.lake_points.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn lake_offsets(&self) -> Vec<u32> {
        self.output.lake_offsets.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn lake_ring_meta(&self) -> Vec<u32> {
        self.output.lake_ring_meta.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn lake_meta(&self) -> Vec<f32> {
        self.output.lake_meta.clone()
    }
}

/// A square raster in meters. Cell centers are ((x + .5) * width / resolution, ...).
/// Array getters copy in a single batch: JS owns them independently of free().
#[wasm_bindgen]
pub struct TerrainOutput {
    terrain: magna_urbis_core::Terrain,
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
    generator: magna_urbis_core::TerrainGenerator,
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
        magna_urbis_core::TerrainGenerator::new_mixed_with_source(
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
        magna_urbis_core::TerrainGenerator::new_mixed_with_noise(
            seed,
            width,
            relief,
            erosion,
            motif_size,
            mountain_mix,
            Some(&magna_urbis_core::GenerationNoise { coarse, fine }),
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
        magna_urbis_core::TerrainGenerator::new_with_environment(
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
        magna_urbis_core::TerrainGenerator::prepare_environment(seed, width, relief, erosion, motif)
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

    pub fn set_coast(&mut self, mask: f64, mode: &str) -> Result<(), JsValue> {
        if !mask.is_finite() || mask.fract() != 0.0 || !(0.0..=255.0).contains(&mask) {
            return Err(JsValue::from_str(
                "Masque de côtes invalide (entier de 0 à 255).",
            ));
        }
        self.generator
            .set_coast(mask as u32, mode)
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn coast_parameters(&self) -> Vec<f32> {
        self.generator.coast_parameters()
    }

    pub fn configure_coast(&mut self, mask: f64, mode: &str) -> Result<(), JsValue> {
        if !mask.is_finite() || mask.fract() != 0.0 || !(0.0..=255.0).contains(&mask) {
            return Err(JsValue::from_str(
                "Masque de côtes invalide (entier de 0 à 255).",
            ));
        }
        self.generator
            .configure_coast(mask as u32, mode)
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn coast_erosion_parameters(&self) -> Vec<f32> {
        self.generator.coast_erosion_parameters()
    }

    pub fn set_coast_surface(&mut self, heights: &[f32]) -> Result<(), JsValue> {
        self.generator
            .set_coast_surface(heights)
            .map_err(|e| JsValue::from_str(&e))
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
    plan: magna_urbis_core::GenerationNoisePlan,
}

#[wasm_bindgen]
impl GenerationNoisePlan {
    pub fn generation(
        seed: &str,
        width: f64,
        relief: &str,
        motif: f64,
    ) -> Result<GenerationNoisePlan, JsValue> {
        magna_urbis_core::GenerationNoisePlan::generation(seed, width, relief, motif)
            .map(|plan| GenerationNoisePlan { plan })
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn finite_shape(
        seed: &str,
        motif: f64,
        relief: &str,
        erosion: f64,
    ) -> Result<GenerationNoisePlan, JsValue> {
        magna_urbis_core::GenerationNoisePlan::finite_shape(seed, motif, relief, erosion)
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
        magna_urbis_core::GenerationNoisePlan::erosion(seed, width, relief, erosion, motif, mix)
            .map(|plan| GenerationNoisePlan { plan })
            .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen(constructor)]
    pub fn new(seed: &str, width: f64, motif: f64) -> Result<GenerationNoisePlan, JsValue> {
        magna_urbis_core::GenerationNoisePlan::new(seed, width, motif)
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
    magna_urbis_core::generate_terrain(seed, width, relief, erosion, raster_resolution(resolution)?)
        .map(|terrain| TerrainOutput { terrain })
        .map_err(|error| JsValue::from_str(&error))
}
