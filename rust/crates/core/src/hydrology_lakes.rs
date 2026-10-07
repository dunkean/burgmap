//! Retain whole spill basins: reducing a water level alone would invent a false outlet.
//! Rejected basins stay in the drainage diagnostics and are filled in the derived surface.
use super::HydrologyConfig;

pub(super) struct Candidate {
    pub cells: Vec<usize>,
    pub level: f32,
    pub area: f32,
    pub max_depth: f32,
    pub mean_depth: f32,
    pub supply: f32,
    pub bounds: [usize; 4],
}

pub(super) fn select(
    candidates: &[Candidate],
    land_area: f32,
    cfg: &HydrologyConfig,
) -> Vec<usize> {
    let maximum = land_area * cfg.max_lake_area;
    let budget = f64::from(land_area) * f64::from(cfg.lake_coverage);
    let mut ranked: Vec<usize> = candidates
        .iter()
        .enumerate()
        .filter(|(_, lake)| lake.area <= maximum)
        .map(|(i, _)| i)
        .collect();
    // Persistent deeper basins with an actual contributing catchment outrank broad
    // shallow spill sheets. Geometry provides the tie-break, independent of scan order.
    let score =
        |lake: &Candidate| lake.mean_depth * (1.0 + (lake.supply / lake.area).max(1.0).ln());
    ranked.sort_unstable_by(|&a, &b| {
        score(&candidates[b])
            .total_cmp(&score(&candidates[a]))
            .then_with(|| candidates[a].cells[0].cmp(&candidates[b].cells[0]))
    });
    let mut count = (ranked.len() as f32 * cfg.lake_abundance * 0.5).ceil() as usize;
    if cfg.lakes == "some" {
        count = count.min((6.0 * cfg.lake_abundance).ceil() as usize);
    }
    let mut retained = Vec::with_capacity(count);
    let mut area = 0.0_f64;
    for i in ranked {
        if retained.len() == count {
            break;
        }
        let next_area = area + f64::from(candidates[i].area);
        if next_area <= budget {
            retained.push(i);
            area = next_area;
        }
    }
    retained
}
