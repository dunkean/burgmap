//! Isolated hydrology stage. Drainage is raster based; retained water geometry is vectorial.
//! Heights, coordinates, widths and areas are metres / square metres. No renderer types.
use crate::rng::Rng;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};

#[path = "hydrology_meanders.rs"]
mod meanders;

#[path = "hydrology_lakes.rs"]
mod lake_policy;

#[path = "hydrology_flats.rs"]
mod flats;

#[path = "hydrology_depressions.rs"]
mod depressions;

const OUT: u32 = u32::MAX;
const D8: [(isize, isize); 8] = [
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
    (0, -1),
    (1, -1),
];

pub struct HydrologyConfig {
    pub main: String,
    pub density: f32,
    pub wetness: f32,
    pub lakes: String,
    pub meanders: String,
    pub meander_intensity: f32,
    pub estuary: String,
    pub width_scale: f32,
    pub incision: f32,
    pub min_lake_area: f32,
    /// Retention intensity, 0..2 (2 retains all suitable natural basins).
    pub lake_abundance: f32,
    /// Maximum combined lake area as a fraction of dry land.
    pub lake_coverage: f32,
    /// Maximum area of one lake as a fraction of dry land.
    pub max_lake_area: f32,
    /// Rejected depressions: bounded local opening, or keep the existing fill policy.
    pub depression_policy: String,
    pub max_breach_depth: f32,
    pub max_breach_length: f32,
}

impl Default for HydrologyConfig {
    fn default() -> Self {
        Self {
            main: "auto".into(),
            density: 1.0,
            wetness: 1.0,
            lakes: "auto".into(),
            meanders: "natural".into(),
            meander_intensity: 1.0,
            estuary: "auto".into(),
            width_scale: 1.0,
            incision: 1.0,
            min_lake_area: 2500.0,
            lake_abundance: 0.5,
            lake_coverage: 0.05,
            max_lake_area: 0.02,
            depression_policy: "auto".into(),
            max_breach_depth: 12.0,
            max_breach_length: 1000.0,
        }
    }
}

impl HydrologyConfig {
    fn validate(&self) -> Result<(), String> {
        for (value, allowed) in [
            (
                &self.main,
                &["auto", "none", "stream", "river", "major"][..],
            ),
            (&self.lakes, &["auto", "none", "some"][..]),
            (&self.meanders, &["natural", "reduced", "none"][..]),
            (&self.depression_policy, &["auto", "fill"][..]),
            (
                &self.estuary,
                &["auto", "simple", "widening", "funnel", "tidal"][..],
            ),
        ] {
            if !allowed.contains(&value.as_str()) {
                return Err(format!("Option hydrologique inconnue : {value}."));
            }
        }
        for (value, min, max) in [
            (self.density, 0.0, 2.0),
            (self.wetness, 0.1, 2.0),
            (self.meander_intensity, 0.0, 2.0),
            (self.width_scale, 0.5, 2.0),
            (self.incision, 0.0, 2.0),
            (self.min_lake_area, 0.0, 1.0e10),
            (self.lake_abundance, 0.0, 2.0),
            (self.lake_coverage, 0.0, 1.0),
            (self.max_lake_area, 0.0, 1.0),
            (self.max_breach_depth, 0.0, 200.0),
            (self.max_breach_length, 0.0, 100_000.0),
        ] {
            if !value.is_finite() || !(min..=max).contains(&value) {
                return Err("Paramètre hydrologique hors limites.".into());
            }
        }
        Ok(())
    }
}

/// All buffers are owned snapshots. Offset arrays count vertices, not scalar elements.
pub struct HydrologyOutput {
    pub width: f32,
    pub resolution: usize,
    pub receivers: Vec<u32>,
    pub accumulation: Vec<f32>,
    pub basins: Vec<u32>,
    /// Prepared CPU/GPU drainage before flat resolution and lake aggregation.
    pub raw_receivers: Vec<u32>,
    pub raw_accumulation: Vec<f32>,
    pub raw_basins: Vec<u32>,
    pub raw_filled: Vec<f32>,
    pub raw_drainage_height: Vec<f32>,
    /// Exact connected equal-F components, 1-based; 0 outside a multi-cell flat.
    pub flat_labels: Vec<u32>,
    /// Metric solver's settled order, independent of physical height/water level.
    /// Strictly descending inside each flat before retained-lake aggregation.
    pub flat_rank: Vec<u32>,
    /// Additional contributing area equivalent at the externally fed main source.
    pub external_inflow_area: f32,
    pub breach_count: u32,
    pub breach_cut_volume_m3: f32,
    pub avoided_fill_volume_m3: f32,
    pub filled: Vec<f32>,
    pub lake_depth: Vec<f32>,
    pub lake_labels: Vec<u32>,
    /// Physical surface after optional lake preparation, before the river bed incision.
    pub drainage_height: Vec<f32>,
    /// Physical surface after rejecting/filling ponds, before any vector river incision.
    pub surface_height: Vec<f32>,
    pub adjusted_height: Vec<f32>,
    /// x, y, full width, water surface elevation; stride 4.
    pub river_points: Vec<f32>,
    pub river_offsets: Vec<u32>,
    /// id, from node, to node, downstream river + 1 (0 if terminal), flags, estuary; stride 6.
    /// Flags: 1 main, 2 externally fed, 4 sea mouth, 8 lake inlet, 16 lake outlet.
    /// Estuary: 0 inland, 1 simple, 2 widening, 3 funnel, 4 tidal aspect.
    pub river_meta: Vec<u32>,
    /// x, y; stride 2. Nodes use zero-based indices.
    pub node_points: Vec<f32>,
    /// cell, lake id (0 if absent), kind; stride 3.
    /// Kinds: 0 source, 1 confluence, 2 sea, 3 map edge, 4 lake inlet, 5 lake outlet, 6 external.
    pub node_meta: Vec<u32>,
    pub lake_points: Vec<f32>,
    pub lake_offsets: Vec<u32>,
    /// lake id, hole flag (1 = island); stride 2, one record per ring.
    pub lake_ring_meta: Vec<u32>,
    /// lake id, elevation, area, max depth, outlet x, outlet y; stride 6.
    pub lake_meta: Vec<f32>,
}

#[derive(Clone)]
struct Drainage {
    filled: Vec<f32>,
    receivers: Vec<u32>,
    accumulation: Vec<f32>,
    order: Vec<usize>,
}

/// Keeps the base terrain and its drainage independently of hydrology options.
pub struct HydrologyEngine {
    seed: String,
    width: f32,
    n: usize,
    height: Vec<f32>,
    sea: Vec<bool>,
    drainage: Drainage,
}

#[derive(Clone, Copy)]
struct HeapCell {
    z: f32,
    tie: u32,
    cell: usize,
}
impl PartialEq for HeapCell {
    fn eq(&self, other: &Self) -> bool {
        self.cell == other.cell
    }
}
impl Eq for HeapCell {}
impl PartialOrd for HeapCell {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for HeapCell {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .z
            .total_cmp(&self.z)
            .then_with(|| other.tie.cmp(&self.tie))
            .then_with(|| other.cell.cmp(&self.cell))
    }
}

fn neighbor(i: usize, d: usize, n: usize) -> Option<usize> {
    let x = (i % n) as isize + D8[d].0;
    let y = (i / n) as isize + D8[d].1;
    (x >= 0 && y >= 0 && x < n as isize && y < n as isize).then_some((y * n as isize + x) as usize)
}
fn border(i: usize, n: usize) -> bool {
    i.is_multiple_of(n) || i % n == n - 1 || i / n == 0 || i / n == n - 1
}
fn sea_mask(height: &[f32], n: usize, enabled: bool) -> Vec<bool> {
    let mut sea = vec![false; height.len()];
    if !enabled {
        return sea;
    }
    let mut seen = vec![false; height.len()];
    let mut component = Vec::new();
    for start in 0..height.len() {
        if !border(start, n) || height[start] > 0.0 || seen[start] {
            continue;
        }
        component.clear();
        component.push(start);
        seen[start] = true;
        let mut resolved = false;
        let mut k = 0;
        while k < component.len() {
            let i = component[k];
            k += 1;
            // A connected ocean needs an area resolved in both grid axes.
            // Narrow inlets still qualify through their parent ocean; isolated
            // one-cell boundary grooves remain land/open river exits. No datum
            // threshold or physical terrain alteration is involved.
            resolved |= i % n + 1 < n
                && i / n + 1 < n
                && height[i + 1] <= 0.0
                && height[i + n] <= 0.0
                && height[i + n + 1] <= 0.0;
            for d in 0..8 {
                if let Some(j) = neighbor(i, d, n)
                    && !seen[j]
                    && height[j] <= 0.0
                {
                    seen[j] = true;
                    component.push(j);
                }
            }
        }
        if resolved {
            for &i in &component {
                sea[i] = true;
            }
        }
    }
    sea
}
fn hash(mut value: u32) -> u32 {
    value ^= value >> 16;
    value = value.wrapping_mul(0x7feb352d);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846ca68b);
    value ^ (value >> 16)
}

fn drain(height: &[f32], sea: &[bool], n: usize, width: f32, seed: &str) -> Drainage {
    drain_neighbors(height, sea, n, width, seed, true)
}
fn fill_cardinal(height: &[f32], sea: &[bool], n: usize, seed: &str) -> Vec<f32> {
    flood_neighbors(height, sea, n, seed, false, false).0
}
fn drain_neighbors(
    height: &[f32],
    sea: &[bool],
    n: usize,
    width: f32,
    seed: &str,
    diagonals: bool,
) -> Drainage {
    let (filled, mut receivers, order) = flood_neighbors(height, sea, n, seed, diagonals, true);
    let mut rank = vec![0; height.len()];
    for (k, &i) in order.iter().enumerate() {
        rank[i] = k;
    }
    for &i in &order {
        if receivers[i] == OUT {
            continue;
        }
        let mut best = 0.0;
        for d in 0..8 {
            if let Some(j) = neighbor(i, d, n) {
                if rank[j] >= rank[i] {
                    continue;
                }
                let gradient = (filled[i] - filled[j])
                    / if d % 2 == 0 {
                        1.0
                    } else {
                        std::f32::consts::SQRT_2
                    };
                if gradient > best {
                    best = gradient;
                    receivers[i] = j as u32;
                }
            }
        }
    }
    let cell_area = (width / n as f32).powi(2);
    let mut accumulation: Vec<f32> = sea
        .iter()
        .map(|&is_sea| if is_sea { 0.0 } else { cell_area })
        .collect();
    for &i in order.iter().rev() {
        let j = receivers[i];
        if j != OUT {
            accumulation[j as usize] += accumulation[i];
        }
    }
    Drainage {
        filled,
        receivers,
        accumulation,
        order,
    }
}

/// Shared priority flood; fill-only callers do not build discarded graph data.
fn flood_neighbors(
    height: &[f32],
    sea: &[bool],
    n: usize,
    seed: &str,
    diagonals: bool,
    graph: bool,
) -> (Vec<f32>, Vec<u32>, Vec<usize>) {
    let mut rng = Rng::new(seed).fork("hydrology-flat-order");
    let salt = (rng.float() * u32::MAX as f64) as u32;
    let mut filled = height.to_vec();
    let mut receivers = vec![OUT; if graph { height.len() } else { 0 }];
    let mut seen = vec![false; height.len()];
    let mut heap = BinaryHeap::new();
    for i in 0..height.len() {
        if border(i, n) || sea[i] {
            seen[i] = true;
            heap.push(HeapCell {
                z: height[i],
                tie: hash(i as u32 ^ salt),
                cell: i,
            });
        }
    }
    let mut order = Vec::with_capacity(if graph { height.len() } else { 0 });
    let mut pond = VecDeque::new();
    while !heap.is_empty() || !pond.is_empty() {
        let cell = if let Some(i) = pond.pop_front() {
            i
        } else {
            heap.pop().unwrap().cell
        };
        if graph {
            order.push(cell);
        }
        // Rotate the visit order deterministically, avoiding a preferred flat direction.
        let first = if diagonals {
            (hash(cell as u32 ^ salt) & 7) as usize
        } else {
            ((hash(cell as u32 ^ salt) & 3) * 2) as usize
        };
        for step in 0..if diagonals { 8 } else { 4 } {
            let direction = (first + step * if diagonals { 1 } else { 2 }) % 8;
            if let Some(j) = neighbor(cell, direction, n) {
                if seen[j] {
                    continue;
                }
                seen[j] = true;
                filled[j] = height[j].max(filled[cell]);
                if graph {
                    receivers[j] = cell as u32;
                }
                if filled[j] <= filled[cell] {
                    pond.push_back(j);
                } else {
                    heap.push(HeapCell {
                        z: filled[j],
                        tie: hash(j as u32 ^ salt),
                        cell: j,
                    });
                }
            }
        }
    }
    (filled, receivers, order)
}

impl HydrologyEngine {
    pub fn new(
        seed: &str,
        width: f64,
        n: usize,
        height: &[f32],
        sea_enabled: bool,
    ) -> Result<Self, String> {
        validate_field(width, n, height)?;
        let sea = sea_mask(height, n, sea_enabled);
        let drainage = drain(height, &sea, n, width as f32, seed);
        Ok(Self {
            seed: seed.into(),
            width: width as f32,
            n,
            height: height.to_vec(),
            sea,
            drainage,
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn with_drainage(
        seed: &str,
        width: f64,
        n: usize,
        height: &[f32],
        sea_enabled: bool,
        filled: &[f32],
        receivers: &[u32],
        accumulation: &[f32],
    ) -> Result<Self, String> {
        validate_field(width, n, height)?;
        let len = n * n;
        if filled.len() != len || receivers.len() != len || accumulation.len() != len {
            return Err("Tailles des champs GPU hydrologiques incohérentes.".into());
        }
        let sea = sea_mask(height, n, sea_enabled);
        let mut indegree = vec![0_u8; len];
        for i in 0..len {
            if !filled[i].is_finite()
                || !accumulation[i].is_finite()
                || accumulation[i] < 0.0
                || filled[i] + 0.001 < height[i]
            {
                return Err("Champ GPU hydrologique invalide.".into());
            }
            let j = receivers[i];
            if j == OUT {
                if !border(i, n) && !sea[i] {
                    return Err("Exutoire GPU intérieur non connecté.".into());
                }
                continue;
            }
            let j = j as usize;
            if j >= len
                || j == i
                || (i % n).abs_diff(j % n) > 1
                || (i / n).abs_diff(j / n) > 1
                || filled[j] > filled[i] + 0.001
            {
                return Err("Récepteur GPU non adjacent ou remontant.".into());
            }
            indegree[j] += 1;
        }
        let mut order: Vec<usize> = (0..len).filter(|&i| indegree[i] == 0).collect();
        let mut k = 0;
        while k < order.len() {
            let j = receivers[order[k]];
            k += 1;
            if j != OUT {
                let j = j as usize;
                indegree[j] -= 1;
                if indegree[j] == 0 {
                    order.push(j);
                }
            }
        }
        if order.len() != len {
            return Err("Cycle détecté dans le drainage GPU.".into());
        }
        order.reverse();
        Ok(Self {
            seed: seed.into(),
            width: width as f32,
            n,
            height: height.to_vec(),
            sea,
            drainage: Drainage {
                filled: filled.to_vec(),
                receivers: receivers.to_vec(),
                accumulation: accumulation.to_vec(),
                order,
            },
        })
    }
    pub fn filled(&self) -> &[f32] {
        &self.drainage.filled
    }
    pub fn receivers(&self) -> &[u32] {
        &self.drainage.receivers
    }
    pub fn accumulation(&self) -> &[f32] {
        &self.drainage.accumulation
    }

    pub fn generate(&self, cfg: &HydrologyConfig) -> Result<HydrologyOutput, String> {
        self.generate_profiled(cfg, &mut |_| {})
    }

    /// Optional stage observations; timing belongs to the caller, outside the engine.
    pub fn generate_profiled(
        &self,
        cfg: &HydrologyConfig,
        profile: &mut dyn FnMut(&'static str),
    ) -> Result<HydrologyOutput, String> {
        cfg.validate()?;
        let n = self.n;
        let cell = self.width / n as f32;
        let mut physical = self.height.clone();
        let mut drainage = self.drainage.clone();
        if cfg.lakes == "some"
            && cfg.lake_abundance > 0.0
            && cfg.lake_coverage > 0.0
            && cfg.max_lake_area > 0.0
            && carve_some_lakes(
                &mut physical,
                &self.sea,
                &drainage,
                n,
                self.width,
                &self.seed,
            )
        {
            drainage = drain(&physical, &self.sea, n, self.width, &self.seed);
        }
        let mut output = HydrologyOutput {
            width: self.width,
            resolution: n,
            receivers: vec![],
            accumulation: vec![],
            basins: vec![],
            raw_receivers: drainage.receivers.clone(),
            raw_accumulation: drainage.accumulation.clone(),
            raw_basins: basins(&drainage, &self.sea),
            raw_filled: drainage.filled.clone(),
            raw_drainage_height: physical.clone(),
            flat_labels: vec![],
            flat_rank: vec![],
            external_inflow_area: 0.0,
            breach_count: 0,
            breach_cut_volume_m3: 0.0,
            avoided_fill_volume_m3: 0.0,
            filled: drainage.filled.clone(),
            lake_depth: physical
                .iter()
                .enumerate()
                .map(|(i, &h)| {
                    if self.sea[i] {
                        0.0
                    } else {
                        (drainage.filled[i] - h).max(0.0)
                    }
                })
                .collect(),
            lake_labels: vec![0; n * n],
            drainage_height: physical.clone(),
            surface_height: vec![],
            adjusted_height: physical.clone(),
            river_points: vec![],
            river_offsets: vec![0],
            river_meta: vec![],
            node_points: vec![],
            node_meta: vec![],
            lake_points: vec![],
            lake_offsets: vec![0],
            lake_ring_meta: vec![],
            lake_meta: vec![],
        };
        // GPU/CPU D8 preparation remains available unchanged in raw_*.
        // Condition the derived graph for the continuous terrain it will use:
        // rejected ponds later raise the dry surface to these final F levels.
        let bank_budget = channel_bank_clearance(0.0, cfg);
        profile("snapshots");
        drainage = flats::condition(
            drainage,
            &physical,
            &self.sea,
            n,
            self.width,
            &self.seed,
            bank_budget,
        );
        output.filled.clone_from(&drainage.filled);
        profile("conditioning");
        for (i, depth) in output.lake_depth.iter_mut().enumerate() {
            *depth = if self.sea[i] {
                0.0
            } else {
                (drainage.filled[i] - physical[i]).max(0.0)
            };
        }
        let mask = flats::resolve(
            &drainage.filled,
            &physical,
            &self.sea,
            n,
            cell,
            &mut drainage.receivers,
            bank_budget,
        )?;
        output.flat_labels = mask.labels;
        output.flat_rank = mask.rank;
        rebuild_drainage(&mut drainage, &self.sea, cell)?;
        profile("flat-routing");
        let lakes = identify_lakes(&mut output, &physical, &drainage, &self.sea, cfg);
        profile("lake-selection");
        let plan = depressions::plan(
            &physical,
            &drainage.filled,
            &self.sea,
            &output.lake_labels,
            n,
            self.width,
            &depressions::Options {
                mode: &cfg.depression_policy,
                max_depth_m: cfg.max_breach_depth,
                max_length_m: cfg.max_breach_length,
            },
        );
        profile("breach-search");
        if let Some(proposal) = plan.physical {
            let proposed = drain(&proposal, &self.sea, n, self.width, &self.seed);
            profile("breach-drain");
            let mut candidate = flats::condition(
                proposed,
                &proposal,
                &self.sea,
                n,
                self.width,
                &self.seed,
                bank_budget,
            );
            profile("breach-conditioning");
            // Storage levels belong to the selected lakes. If a proposed notch
            // changes one, keep the complete previous surface and drainage.
            let preserves_lakes = output
                .lake_labels
                .iter()
                .enumerate()
                .all(|(i, &lake)| lake == 0 || candidate.filled[i] == drainage.filled[i]);
            if preserves_lakes {
                let mask = flats::resolve(
                    &candidate.filled,
                    &proposal,
                    &self.sea,
                    n,
                    cell,
                    &mut candidate.receivers,
                    bank_budget,
                )?;
                rebuild_drainage(&mut candidate, &self.sea, cell)?;
                profile("breach-routing");
                let fill_delta: f64 = (0..physical.len())
                    .filter(|&i| !self.sea[i] && output.lake_labels[i] == 0)
                    .map(|i| {
                        f64::from((drainage.filled[i] - physical[i]).max(0.0))
                            - f64::from((candidate.filled[i] - proposal[i]).max(0.0))
                    })
                    .sum();
                output.breach_count = plan.stats.breach_count;
                output.breach_cut_volume_m3 = plan.stats.breach_cut_volume_m3 as f32;
                output.avoided_fill_volume_m3 =
                    (fill_delta.max(0.0) * f64::from(cell) * f64::from(cell)) as f32;
                physical = proposal;
                drainage = candidate;
                output.flat_labels = mask.labels;
                output.flat_rank = mask.rank;
                output.filled.clone_from(&drainage.filled);
                output.drainage_height.clone_from(&physical);
                output.adjusted_height.clone_from(&physical);
            }
        }
        profile("depressions");
        if !lakes.is_empty() {
            flats::aggregate_lakes(&mut drainage, &output.lake_labels, n, bank_budget)?;
            rebuild_drainage(&mut drainage, &self.sea, cell)?;
            update_lake_outlets(&mut output, &drainage, cell)?;
        }
        let labels = output.lake_labels.clone();
        for lake in &lakes {
            lake_rings(lake, &physical, &labels, n, cell, &mut output);
        }
        for (i, depth) in output.lake_depth.iter_mut().enumerate() {
            if output.lake_labels[i] == 0 {
                *depth = 0.0;
                if !self.sea[i] {
                    // Bare drainage corridors cannot float over rejected ponds. Fill
                    // their entire depression in this derived hydrological surface.
                    output.adjusted_height[i] = drainage.filled[i];
                }
            }
        }
        let channel_ground = output.adjusted_height.clone();
        profile("water-surfaces");
        let (main_source, external) = principal_source(
            &channel_ground,
            &self.sea,
            &drainage,
            cfg,
            n,
            cell,
            self.width,
        );
        let extra = external_inflow(cfg, external);
        if let Some(source) = main_source.filter(|_| extra > 0.0) {
            let mut maximum = 0.0_f32;
            let mut i = source;
            loop {
                maximum = maximum.max(drainage.accumulation[i]);
                let j = drainage.receivers[i];
                if j == OUT || self.sea[i] {
                    break;
                }
                i = j as usize;
            }
            let maximum_width = channel_width(maximum + extra, cfg);
            let radius = (maximum_width * 0.75 + cell * 2.0).max(80.0);
            let bank_radius = maximum_width * 0.5 + cell + 3.0;
            flats::capture_external(
                &mut drainage,
                &self.sea,
                n,
                cell,
                &output.flat_labels,
                source,
                extra,
                radius,
                bank_radius,
                bank_budget,
            )?;
            rebuild_drainage(&mut drainage, &self.sea, cell)?;
            if !lakes.is_empty() {
                update_lake_outlets(&mut output, &drainage, cell)?;
            }
        }
        output.basins = basins(&drainage, &self.sea);
        profile("main-river");
        rivers(
            &mut output,
            &channel_ground,
            &self.sea,
            &drainage,
            cfg,
            &self.seed,
            main_source,
            external,
            profile,
        )?;
        output.receivers = drainage.receivers;
        // rivers() adds any explicitly identified external input to this copy.
        if output.accumulation.is_empty() {
            output.accumulation = drainage.accumulation;
        }
        output.surface_height = channel_ground;
        profile("packing");
        Ok(output)
    }
}

/// The authoritative graph is accumulated once with integer local cell counts.
/// Its reverse topological order is shared by all downstream extraction stages.
fn rebuild_drainage(drainage: &mut Drainage, sea: &[bool], cell: f32) -> Result<(), String> {
    let len = drainage.receivers.len();
    let mut indegree = vec![0_u8; len];
    for &j in &drainage.receivers {
        if j != OUT {
            indegree[j as usize] += 1;
        }
    }
    let mut order: Vec<usize> = (0..len).filter(|&i| indegree[i] == 0).collect();
    let mut counts: Vec<u32> = sea.iter().map(|&is_sea| u32::from(!is_sea)).collect();
    let mut k = 0;
    while k < order.len() {
        let i = order[k];
        k += 1;
        let j = drainage.receivers[i];
        if j != OUT {
            let j = j as usize;
            counts[j] += counts[i];
            indegree[j] -= 1;
            if indegree[j] == 0 {
                order.push(j);
            }
        }
    }
    if order.len() != len {
        return Err("Cycle détecté dans le drainage convergent.".into());
    }
    let total: u32 = drainage
        .receivers
        .iter()
        .enumerate()
        .filter(|&(_, &j)| j == OUT)
        .map(|(i, _)| counts[i])
        .sum();
    if total as usize != sea.iter().filter(|&&is_sea| !is_sea).count() {
        return Err("Apports perdus dans le drainage convergent.".into());
    }
    order.reverse();
    drainage.order = order;
    drainage.accumulation = counts
        .into_iter()
        .map(|count| count as f32 * cell * cell)
        .collect();
    Ok(())
}

fn update_lake_outlets(
    out: &mut HydrologyOutput,
    drainage: &Drainage,
    cell: f32,
) -> Result<(), String> {
    let mut outlets = vec![OUT; out.lake_meta.len() / 6];
    for (i, &lake) in out.lake_labels.iter().enumerate() {
        let j = drainage.receivers[i];
        if lake != 0 && (j == OUT || out.lake_labels[j as usize] != lake) {
            let outlet = &mut outlets[lake as usize - 1];
            if *outlet != OUT {
                return Err("Plusieurs exutoires pour un lac agrégé.".into());
            }
            *outlet = i as u32;
            let p = point(if j == OUT { i } else { j as usize }, out.resolution, cell);
            out.lake_meta[(lake as usize - 1) * 6 + 4] = p.0;
            out.lake_meta[(lake as usize - 1) * 6 + 5] = p.1;
        }
    }
    if outlets.contains(&OUT) {
        return Err("Lac sans exutoire connecté.".into());
    }
    Ok(())
}

fn validate_field(width: f64, n: usize, height: &[f32]) -> Result<(), String> {
    if !width.is_finite()
        || !(1.0..=1.0e6).contains(&width)
        || !(64..=1024).contains(&n)
        || height.len() != n * n
        || height.iter().any(|h| !h.is_finite())
    {
        return Err(
            "Terrain hydrologique invalide (grille de 64 à 1024, altitudes finies).".into(),
        );
    }
    Ok(())
}

fn basins(drainage: &Drainage, sea: &[bool]) -> Vec<u32> {
    let mut labels = vec![0; sea.len()];
    let mut roots = HashMap::new();
    for &i in &drainage.order {
        if sea[i] {
            continue;
        }
        let j = drainage.receivers[i];
        if j == OUT || sea[j as usize] {
            let key = if j == OUT { i } else { j as usize };
            let next = roots.len() as u32 + 1;
            labels[i] = *roots.entry(key).or_insert(next);
        } else {
            labels[i] = labels[j as usize];
        }
    }
    labels
}

fn sample(h: &[f32], n: usize, cell: f32, x: f32, y: f32) -> f32 {
    let gx = (x / cell - 0.5).clamp(0.0, (n - 1) as f32);
    let gy = (y / cell - 0.5).clamp(0.0, (n - 1) as f32);
    let ix = gx.floor() as usize;
    let iy = gy.floor() as usize;
    let jx = (ix + 1).min(n - 1);
    let jy = (iy + 1).min(n - 1);
    let tx = gx - ix as f32;
    let ty = gy - iy as f32;
    (h[iy * n + ix] * (1.0 - tx) + h[iy * n + jx] * tx) * (1.0 - ty)
        + (h[jy * n + ix] * (1.0 - tx) + h[jy * n + jx] * tx) * ty
}
fn point(i: usize, n: usize, cell: f32) -> (f32, f32) {
    (
        (i % n) as f32 * cell + cell * 0.5,
        (i / n) as f32 * cell + cell * 0.5,
    )
}

fn carve_some_lakes(
    h: &mut [f32],
    sea: &[bool],
    drainage: &Drainage,
    n: usize,
    width: f32,
    seed: &str,
) -> bool {
    let cell = width / n as f32;
    let mut rng = Rng::new(seed).fork("hydrology-managed-lakes");
    let radius = (width * 0.012).max(cell * 2.5).min(width * 0.035);
    let mut chosen = Vec::new();
    for _ in 0..220 {
        let x = rng.range(0.12, 0.88) * n as f64;
        let y = rng.range(0.12, 0.88) * n as f64;
        let i = y as usize * n + x as usize;
        if sea[i]
            || h[i] < 1.0
            || drainage.accumulation[i] < width * width * 0.00015
            || drainage.filled[i] - h[i] > 0.3
        {
            continue;
        }
        let (cx, cy) = point(i, n, cell);
        let safety = (radius / cell).ceil() as isize + 1;
        if (-safety..=safety).any(|dy| {
            (-safety..=safety).any(|dx| {
                let x = (i % n) as isize + dx;
                let y = (i / n) as isize + dy;
                x < 0
                    || y < 0
                    || x >= n as isize
                    || y >= n as isize
                    || sea[y as usize * n + x as usize]
            })
        }) {
            continue;
        }
        if chosen
            .iter()
            .any(|&(px, py): &(f32, f32)| (cx - px).hypot(cy - py) < radius * 5.0)
        {
            continue;
        }
        let gx = (sample(h, n, cell, cx + radius, cy) - sample(h, n, cell, cx - radius, cy))
            / (2.0 * radius);
        let gy = (sample(h, n, cell, cx, cy + radius) - sample(h, n, cell, cx, cy - radius))
            / (2.0 * radius);
        if gx.hypot(gy) > 0.035 {
            continue;
        }
        let bottom = (radius * 0.018).clamp(0.8, 6.0);
        let elevation = h[i];
        let reach = (radius / cell).ceil() as isize;
        for dy in -reach..=reach {
            for dx in -reach..=reach {
                let xx = i % n;
                let yy = i / n;
                let j = (yy as isize + dy) as usize * n + (xx as isize + dx) as usize;
                let t = (dx as f32 * cell).hypot(dy as f32 * cell) / radius;
                if t >= 1.0 {
                    continue;
                }
                let blend = (1.0 - t * t).powi(2);
                // A bounded depression, never a forced connection or a lifted surrounding rim.
                h[j] -= (h[j] - (elevation + gx * dx as f32 * cell + gy * dy as f32 * cell))
                    .max(0.0)
                    * blend
                    + bottom * blend;
            }
        }
        chosen.push((cx, cy));
        if chosen.len() == 3 {
            break;
        }
    }
    !chosen.is_empty()
}

struct Lake {
    id: u32,
    level: f32,
    min_x: usize,
    min_y: usize,
    max_x: usize,
    max_y: usize,
}
fn identify_lakes(
    out: &mut HydrologyOutput,
    h: &[f32],
    drainage: &Drainage,
    sea: &[bool],
    cfg: &HydrologyConfig,
) -> Vec<Lake> {
    let n = out.resolution;
    let cell = out.width / n as f32;
    let mut seen = vec![false; h.len()];
    let mut lakes = Vec::new();
    if cfg.lakes == "none"
        || cfg.lake_abundance == 0.0
        || cfg.lake_coverage == 0.0
        || cfg.max_lake_area == 0.0
    {
        return lakes;
    }
    let mut candidates = Vec::new();
    for start in 0..h.len() {
        if seen[start] || sea[start] || out.lake_depth[start] < 0.025 {
            continue;
        }
        let level = drainage.filled[start];
        let mut cells = vec![start];
        seen[start] = true;
        let mut k = 0;
        let mut max_depth: f32 = 0.0;
        let mut total_depth = 0.0_f64;
        let mut supply: f32 = 0.0;
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (n, n, 0, 0);
        while k < cells.len() {
            let i = cells[k];
            k += 1;
            max_depth = max_depth.max(out.lake_depth[i]);
            total_depth += f64::from(out.lake_depth[i]);
            supply = supply.max(drainage.accumulation[i]);
            min_x = min_x.min(i % n);
            max_x = max_x.max(i % n);
            min_y = min_y.min(i / n);
            max_y = max_y.max(i / n);
            for d in 0..8 {
                if let Some(j) = neighbor(i, d, n)
                    && !seen[j]
                    && !sea[j]
                    && out.lake_depth[j] >= 0.025
                    && (drainage.filled[j] - level).abs() < 0.005
                    && flats::diagonal_open(
                        i,
                        j,
                        &drainage.filled,
                        n,
                        channel_bank_clearance(0.0, cfg),
                    )
                {
                    seen[j] = true;
                    cells.push(j);
                }
            }
        }
        let area = cells.len() as f32 * cell * cell;
        if area < cfg.min_lake_area.max(cell * cell * 3.0) || max_depth < 0.25 {
            continue;
        }
        candidates.push(lake_policy::Candidate {
            mean_depth: (total_depth / cells.len() as f64) as f32,
            cells,
            area,
            level,
            max_depth,
            supply,
            bounds: [min_x, min_y, max_x, max_y],
        });
    }
    let land_area = sea.iter().filter(|&&is_sea| !is_sea).count() as f32 * cell * cell;
    for index in lake_policy::select(&candidates, land_area, cfg) {
        let candidate = &candidates[index];
        let cells = &candidate.cells;
        let id = lakes.len() as u32 + 1;
        for &i in cells {
            out.lake_labels[i] = id;
        }
        let mut outlet = cells[0];
        let mut largest = -1.0;
        for &i in cells {
            let j = drainage.receivers[i];
            if j != OUT && out.lake_labels[j as usize] != id && drainage.accumulation[i] > largest {
                largest = drainage.accumulation[i];
                outlet = j as usize;
            }
        }
        let (ox, oy) = point(outlet, n, cell);
        out.lake_meta.extend([
            id as f32,
            candidate.level,
            candidate.area,
            candidate.max_depth,
            ox,
            oy,
        ]);
        let [min_x, min_y, max_x, max_y] = candidate.bounds;
        lakes.push(Lake {
            id,
            level: candidate.level,
            min_x,
            min_y,
            max_x,
            max_y,
        });
    }
    lakes
}

/// Marching squares on physical heights, restricted to the lake's connected depression.
fn lake_rings(
    lake: &Lake,
    h: &[f32],
    labels: &[u32],
    n: usize,
    cell: f32,
    out: &mut HydrologyOutput,
) {
    type Vertex = (f32, f32);
    let mut vertices: Vec<Vertex> = Vec::new();
    let mut indices = HashMap::new();
    let mut links: Vec<Vec<usize>> = Vec::new();
    let xmin = lake.min_x.saturating_sub(1);
    let ymin = lake.min_y.saturating_sub(1);
    for y in ymin..=(lake.max_y.min(n - 2)) {
        for x in xmin..=(lake.max_x.min(n - 2)) {
            let cells = [
                y * n + x,
                y * n + x + 1,
                (y + 1) * n + x + 1,
                (y + 1) * n + x,
            ];
            let values = cells.map(|i| {
                if labels[i] == lake.id {
                    (lake.level - h[i]).max(0.001)
                } else {
                    -(h[i] - lake.level).abs().max(0.001)
                }
            });
            let mut cuts = Vec::with_capacity(4);
            for edge in 0..4 {
                let a = edge;
                let b = (edge + 1) % 4;
                if (values[a] > 0.0) == (values[b] > 0.0) {
                    continue;
                }
                let low = cells[a].min(cells[b]);
                let high = cells[a].max(cells[b]);
                let key = (low as u64) << 32 | high as u64;
                let index = *indices.entry(key).or_insert_with(|| {
                    let t = values[a] / (values[a] - values[b]);
                    let pa = point(cells[a], n, cell);
                    let pb = point(cells[b], n, cell);
                    let index = vertices.len();
                    vertices.push((pa.0 + (pb.0 - pa.0) * t, pa.1 + (pb.1 - pa.1) * t));
                    links.push(Vec::with_capacity(2));
                    index
                });
                cuts.push((edge, index));
            }
            if cuts.len() == 2 {
                let a = cuts[0].1;
                let b = cuts[1].1;
                links[a].push(b);
                links[b].push(a);
            } else if cuts.len() == 4 {
                // Keep each dry corner as an island when the cell centre is water.
                let positive = values.iter().sum::<f32>() > 0.0;
                let shift = usize::from((values[0] > 0.0) == positive);
                for pair in 0..2 {
                    let a = cuts[(pair * 2 + shift) % 4].1;
                    let b = cuts[(pair * 2 + shift + 1) % 4].1;
                    links[a].push(b);
                    links[b].push(a);
                }
            }
        }
    }
    let mut seen = vec![false; vertices.len()];
    let mut rings: Vec<Vec<Vertex>> = Vec::new();
    for start in 0..vertices.len() {
        if seen[start] || links[start].len() != 2 {
            continue;
        }
        let mut ring = Vec::new();
        let mut prev = usize::MAX;
        let mut current = start;
        while !seen[current] {
            seen[current] = true;
            ring.push(vertices[current]);
            let Some(&next) = links[current].iter().find(|&&v| v != prev) else {
                break;
            };
            prev = current;
            current = next;
        }
        if current == start && ring.len() >= 3 {
            rings.push(ring);
        }
    }
    for (index, ring) in rings.iter().enumerate() {
        let p = ring[0];
        let mut nesting = 0;
        for (j, other) in rings.iter().enumerate() {
            if j != index && inside(p, other) {
                nesting += 1;
            }
        }
        for &(x, y) in ring {
            out.lake_points.extend([x, y]);
        }
        out.lake_offsets.push((out.lake_points.len() / 2) as u32);
        out.lake_ring_meta.extend([lake.id, nesting % 2]);
    }
}
fn inside(p: (f32, f32), ring: &[(f32, f32)]) -> bool {
    let mut odd = false;
    for i in 0..ring.len() {
        let a = ring[i];
        let b = ring[(i + 1) % ring.len()];
        if (a.1 > p.1) != (b.1 > p.1) && p.0 < (b.0 - a.0) * (p.1 - a.1) / (b.1 - a.1) + a.0 {
            odd = !odd;
        }
    }
    odd
}

struct River {
    cells: Vec<usize>,
    from: u32,
    to: u32,
    flags: u32,
    estuary: u32,
}
#[derive(Clone, Copy)]
struct RiverPoint {
    x: f32,
    y: f32,
    width: f32,
    z: f32,
}

// Immediate parent course, original junction cell, and its local approach reach.
type CourseLink = Option<(u32, usize, f32)>;

struct CourseGeometry {
    points: Vec<RiverPoint>,
    cuts: Vec<usize>,
}

fn external_inflow(cfg: &HydrologyConfig, external: bool) -> f32 {
    if !external {
        return 0.0;
    }
    match cfg.main.as_str() {
        "stream" => 200_000.0,
        "river" => 12_000_000.0,
        "major" => 400_000_000.0,
        _ => 0.0,
    }
}

#[allow(clippy::too_many_arguments)]
fn principal_source(
    h: &[f32],
    sea: &[bool],
    drainage: &Drainage,
    cfg: &HydrologyConfig,
    n: usize,
    cell: f32,
    width: f32,
) -> (Option<usize>, bool) {
    let area = width * width;
    let threshold = 1_800_000.0 / cfg.density.max(0.15).powf(1.5) / cfg.wetness;
    let mut distance = vec![0.0_f32; h.len()];
    for &i in &drainage.order {
        let j = drainage.receivers[i];
        if j != OUT {
            let p = point(i, n, cell);
            let q = point(j as usize, n, cell);
            distance[i] = distance[j as usize] + (q.0 - p.0).hypot(q.1 - p.1);
        }
    }
    let mut main_source = None;
    let mut external = false;
    let mut best = -1.0;
    if matches!(cfg.main.as_str(), "stream" | "river" | "major") {
        // Incoming rivers use a land boundary and a real interior drainage corridor.
        // The short entrance is accepted only when it can run downhill from that boundary.
        for i in 0..h.len() {
            if sea[i]
                || (i % n).min(n - 1 - i % n).min((i / n).min(n - 1 - i / n)) != 2
                || distance[i] < width * 0.3
            {
                continue;
            }
            let b = boundary_cell(i, n);
            let between = (((b % n + i % n) / 2), ((b / n + i / n) / 2));
            let middle = between.1 * n + between.0;
            if sea[b]
                || sea[middle]
                || h[b] + 0.03 < drainage.filled[middle]
                || drainage.filled[middle] + 0.03 < drainage.filled[i]
            {
                continue;
            }
            let score = distance[i];
            if score > best {
                best = score;
                main_source = Some(i);
                external = true;
            }
        }
    }
    if main_source.is_none() && cfg.main != "none" {
        // Natural principal: maximize length first, avoiding a forced straight crossing.
        for i in 0..h.len() {
            if sea[i]
                || drainage.accumulation[i] < threshold.min(area * 0.002)
                || distance[i] < cell * 4.0
            {
                continue;
            }
            let score = distance[i] * (0.55 + (drainage.accumulation[i] / area).sqrt());
            if score > best {
                best = score;
                main_source = Some(i);
            }
        }
    }
    (main_source, external)
}

#[allow(clippy::too_many_arguments)]
fn rivers(
    out: &mut HydrologyOutput,
    h: &[f32],
    sea: &[bool],
    drainage: &Drainage,
    cfg: &HydrologyConfig,
    seed: &str,
    main_source: Option<usize>,
    external: bool,
    profile: &mut dyn FnMut(&'static str),
) -> Result<(), String> {
    let n = out.resolution;
    let cell = out.width / n as f32;
    // Initiation uses a physical catchment, independent of the map extent.
    // Steeper slopes support smaller torrents; plains require more supply.
    let threshold = 1_800_000.0 / cfg.density.max(0.15).powf(1.5) / cfg.wetness;
    // A discarded pond becomes an alluvial plain, not hundreds of new sources
    // along the arbitrary flood-fill tree. Keep channels fed from its slopes.
    let mut source_area: Vec<f32> = (0..h.len())
        .map(|i| {
            if sea[i] || drainage.filled[i] - out.drainage_height[i] > 0.4 {
                0.0
            } else {
                cell * cell
            }
        })
        .collect();
    for &i in drainage.order.iter().rev() {
        let j = drainage.receivers[i];
        if j != OUT {
            source_area[j as usize] += source_area[i];
        }
    }
    let mut distance = vec![0.0_f32; h.len()];
    for &i in &drainage.order {
        let j = drainage.receivers[i];
        if j != OUT {
            let p = point(i, n, cell);
            let q = point(j as usize, n, cell);
            distance[i] = distance[j as usize] + (q.0 - p.0).hypot(q.1 - p.1);
        }
    }
    let mut selected: Vec<bool> = (0..h.len())
        .map(|i| {
            let j = drainage.receivers[i];
            let slope = if j == OUT {
                0.0
            } else {
                let p = point(i, n, cell);
                let q = point(j as usize, n, cell);
                (drainage.filled[i] - drainage.filled[j as usize]).max(0.0)
                    / (q.0 - p.0).hypot(q.1 - p.1)
            };
            let initiation = (threshold / (1.0 + slope / 0.02).powf(0.35))
                .max(300_000.0 / cfg.density.max(0.15) / cfg.wetness)
                .max(cell * cell * 24.0);
            !sea[i] && cfg.density > 0.0 && source_area[i] >= initiation
        })
        .collect();
    // Once initiated, a torrent remains connected when its slope decreases.
    for &i in drainage.order.iter().rev() {
        let j = drainage.receivers[i];
        if selected[i] && j != OUT && !sea[j as usize] {
            selected[j as usize] = true;
        }
    }
    let mut effective = drainage.accumulation.clone();
    let mut principal = vec![false; h.len()];
    let extra = external_inflow(cfg, external);
    out.external_inflow_area = extra;
    if let Some(source) = main_source {
        let mut i = source;
        loop {
            effective[i] += extra;
            if sea[i] {
                break;
            }
            selected[i] = true;
            principal[i] = true;
            let j = drainage.receivers[i];
            if j == OUT {
                break;
            }
            i = j as usize;
        }
    }
    let mut lake_outlets: HashMap<u32, usize> = HashMap::new();
    for (i, &lake) in out.lake_labels.iter().enumerate() {
        let j = drainage.receivers[i];
        if lake > 0 && j != OUT && out.lake_labels[j as usize] != lake {
            let previous = lake_outlets.entry(lake).or_insert(i);
            if drainage.accumulation[i] > drainage.accumulation[*previous] {
                *previous = i;
            }
        }
    }
    // Small lakes still have an explicit spill stream, independently of tributary density.
    // Sorted ids keep geometry and node ordering deterministic across native/WASM builds.
    let mut outlets: Vec<_> = lake_outlets.into_iter().collect();
    outlets.sort_unstable_by_key(|&(lake, _)| lake);
    for (lake, mut i) in outlets {
        loop {
            if sea[i] {
                break;
            }
            let was_selected = selected[i];
            selected[i] = true;
            let j = drainage.receivers[i];
            if j == OUT
                || (was_selected && out.lake_labels[i] != lake)
                || (out.lake_labels[i] > 0 && out.lake_labels[i] != lake)
            {
                break;
            }
            i = j as usize;
        }
    }
    // Remove short isolated tributaries while retaining their confluence and the principal.
    for _ in 0..2 {
        let incoming = incoming_counts(&selected, &drainage.receivers);
        for start in 0..h.len() {
            if !selected[start]
                || incoming[start] != 0
                || principal[start]
                || out.lake_labels[start] > 0
            {
                continue;
            }
            let mut cells = vec![start];
            let mut i = start;
            while drainage.receivers[i] != OUT {
                let j = drainage.receivers[i] as usize;
                if !selected[j] || incoming[j] != 1 || principal[j] {
                    break;
                }
                cells.push(j);
                i = j;
            }
            if cells.len() < 4 || distance[start] - distance[i] < out.width * 0.005 {
                for i in cells {
                    selected[i] = false;
                }
            }
        }
    }
    let incoming = incoming_counts(&selected, &drainage.receivers);
    let mut upstream = vec![OUT; h.len()];
    for (i, &yes) in selected.iter().enumerate() {
        let j = drainage.receivers[i];
        if yes && j != OUT {
            upstream[j as usize] = i as u32;
        }
    }
    let mut node_at = vec![OUT; h.len()];
    for i in 0..h.len() {
        if !selected[i] {
            continue;
        }
        let j = drainage.receivers[i];
        let u = upstream[i];
        let lake = out.lake_labels[i];
        let transition = (j != OUT && out.lake_labels[j as usize] != lake)
            || (u != OUT && out.lake_labels[u as usize] != lake);
        if incoming[i] != 1
            || j == OUT
            || (j != OUT && !selected[j as usize] && !sea[j as usize])
            || transition
            || main_source == Some(i)
        {
            let kind = if main_source == Some(i) && external {
                6
            } else if (lake > 0 && incoming[i] == 0)
                || (u != OUT && out.lake_labels[u as usize] > 0 && lake == 0)
            {
                5
            } else if lake > 0 && u != OUT && out.lake_labels[u as usize] == 0 {
                4
            } else if j == OUT {
                3
            } else if incoming[i] > 1 {
                1
            } else {
                0
            };
            node_at[i] = add_node(out, i, lake, kind, cell);
            if kind == 6 {
                let b = boundary_point(i, n, cell, out.width);
                let offset = node_at[i] as usize * 2;
                out.node_points[offset] = b.0;
                out.node_points[offset + 1] = b.1;
            }
        }
    }
    let mut edges = Vec::new();
    for start in 0..h.len() {
        if !selected[start] || node_at[start] == OUT {
            continue;
        }
        let mut i = start;
        let mut cells = vec![start];
        let mut to = OUT;
        while drainage.receivers[i] != OUT {
            let j = drainage.receivers[i] as usize;
            cells.push(j);
            if sea[j] {
                // Distinct shore entries can drain to the same ocean cell.
                // Their clipped coastal endpoints are independent terminals.
                to = add_node(out, j, 0, 2, cell);
                break;
            }
            if !selected[j] {
                break;
            }
            if node_at[j] != OUT {
                to = node_at[j];
                break;
            }
            i = j;
        }
        if to == OUT || cells.len() < 2 {
            continue;
        }
        let end = *cells.last().unwrap();
        let mut flags = u32::from(principal[start]);
        if principal[start] && external {
            flags |= 2;
        }
        if sea[end] {
            flags |= 4;
        }
        if out.lake_labels[end] > 0 && out.lake_labels[start] == 0 {
            flags |= 8;
        }
        if out.lake_labels[start] > 0 && out.lake_labels[end] == 0 && !sea[end] {
            flags |= 16;
        }
        let estuary = if sea[end] {
            choose_estuary(cfg, h, n, cell, &cells, seed)
        } else {
            0
        };
        edges.push(River {
            cells,
            from: node_at[start],
            to,
            flags,
            estuary,
        });
    }
    let mut edge_from_node = HashMap::new();
    for (index, edge) in edges.iter().enumerate() {
        edge_from_node.insert(edge.from, index as u32 + 1);
    }
    // A confluence splits the graph, not the shape of its dominant watercourse.
    // Vectorize whole courses first, then restore those graph boundaries.
    let mut dominant = vec![None; edges.len()];
    for (id, edge) in edges.iter().enumerate() {
        let Some(&next) = edge_from_node.get(&edge.to) else {
            continue;
        };
        let next = next as usize - 1;
        let kind = out.node_meta[edge.to as usize * 3 + 2];
        if !matches!(kind, 0 | 1) {
            continue;
        }
        let score = |e: &River| {
            let i = e.cells[e.cells.len().saturating_sub(2)];
            (e.flags & 1, effective[i])
        };
        if dominant[next].is_none_or(|old| score(edge) > score(&edges[old])) {
            dominant[next] = Some(id);
        }
    }
    let mut courses = Vec::new();
    let mut course_at = vec![OUT; edges.len()];
    for start in 0..edges.len() {
        if dominant[start].is_some() {
            continue;
        }
        let mut course = vec![start];
        let mut id = start;
        while let Some(&next) = edge_from_node.get(&edges[id].to) {
            let next = next as usize - 1;
            if dominant[next] != Some(id) {
                break;
            }
            course.push(next);
            id = next;
        }
        let owner = courses.len() as u32;
        for &id in &course {
            course_at[id] = owner;
        }
        courses.push(course);
    }
    courses.sort_unstable_by(|a, b| {
        let score = |course: &Vec<usize>| {
            let first = &edges[course[0]];
            let last = &edges[*course.last().unwrap()];
            (first.flags & 1, effective[last.cells[last.cells.len() - 2]])
        };
        score(b).partial_cmp(&score(a)).unwrap_or(Ordering::Equal)
    });
    for (owner, course) in courses.iter().enumerate() {
        for &id in course {
            course_at[id] = owner as u32;
        }
    }
    let links: Vec<CourseLink> = courses
        .iter()
        .map(|course| {
            let last = &edges[*course.last().unwrap()];
            edge_from_node.get(&last.to).map(|&host| {
                let junction = *last.cells.last().unwrap();
                (
                    course_at[host as usize - 1],
                    junction,
                    (channel_width(effective[junction], cfg) * 5.0).max(cell * 8.0),
                )
            })
        })
        .collect();
    let mut occupied = vec![OUT; h.len()];
    for (id, edge) in edges.iter().enumerate() {
        for &i in &edge.cells {
            occupied[i] = if occupied[i] == OUT || occupied[i] == course_at[id] {
                course_at[id]
            } else {
                OUT - 1 // The shared graph junction itself is free to move.
            };
        }
    }
    profile("river-graph");
    let mut curves = vec![Vec::new(); edges.len()];
    let mut geometry_index = RiverGeometryIndex::new(cell, courses.len());
    geometry_index.configure_junctions(&edges, &course_at, &effective, n, cfg, None);
    geometry_index.configure_lakes(&out.lake_labels, n);
    for (id, edge) in edges.iter().enumerate() {
        let guide: Vec<_> = edge
            .cells
            .iter()
            .map(|&i| {
                let (x, y) = point(i, n, cell);
                RiverPoint {
                    x,
                    y,
                    width: channel_width(effective[i], cfg),
                    z: drainage.filled[i],
                }
            })
            .collect();
        geometry_index.insert(course_at[id], &guide);
    }
    for (owner, course) in courses.iter().enumerate() {
        let first = &edges[course[0]];
        let last = &edges[*course.last().unwrap()];
        let mut combined = River {
            cells: first.cells.clone(),
            from: first.from,
            to: last.to,
            flags: (first.flags & (2 | 16))
                | (last.flags & (4 | 8))
                | u32::from(course.iter().any(|&id| edges[id].flags & 1 != 0)),
            estuary: last.estuary,
        };
        let mut spans = vec![(course[0], 0, first.cells.len() - 1)];
        for &id in course.iter().skip(1) {
            let start = combined.cells.len() - 1;
            combined.cells.extend_from_slice(&edges[id].cells[1..]);
            spans.push((id, start, combined.cells.len() - 1));
        }
        let geometry = vector_course(
            &combined,
            &effective,
            h,
            &out.drainage_height,
            drainage,
            n,
            cell,
            cfg,
            seed,
            owner as u32,
            &occupied,
            &geometry_index,
            &links,
            &node_at,
            &out.lake_labels,
            sea,
            out.width,
        );
        let points = geometry.points;
        // Later courses see the retained vectors, not just the old D8 centreline.
        for &i in &combined.cells {
            if occupied[i] == owner as u32 {
                occupied[i] = OUT;
            }
        }
        occupy_curve(&points, &mut occupied, owner as u32, n, cell);
        geometry_index.replace(owner as u32, &points);
        for (id, start, end) in spans {
            curves[id] = points[geometry.cuts[start]..=geometry.cuts[end]].to_vec();
        }
    }
    profile("river-curves");
    join_confluences(
        &mut curves,
        &edges,
        &dominant,
        &edge_from_node,
        &course_at,
        &mut occupied,
        &out.node_meta,
        h,
        &out.drainage_height,
        n,
        cell,
        out.width,
        &out.lake_labels,
        sea,
        &distance,
        &effective,
        cfg,
    )?;
    // Keep the authoritative drainage as a local geometrical fallback. Raster
    // occupancy is intentionally permissive at junctions; vector axes must still
    // meet only at their shared graph node.
    let references: Vec<Vec<RiverPoint>> = edges
        .iter()
        .enumerate()
        .map(|(id, edge)| {
            let mut points: Vec<_> = edge
                .cells
                .iter()
                .map(|&i| {
                    let (x, y) = point(i, n, cell);
                    RiverPoint {
                        x,
                        y,
                        width: channel_width(effective[i], cfg),
                        z: drainage.filled[i],
                    }
                })
                .collect();
            if let (Some(first), Some(last)) = (curves[id].first(), curves[id].last()) {
                points[0] = *first;
                let end = points.len() - 1;
                points[end] = *last;
                let mut previous = first.z;
                for p in &mut points {
                    p.z = p.z.max(last.z).min(previous);
                    previous = p.z;
                }
            }
            points
        })
        .collect();
    profile("confluences");
    let compact = compact_network(
        &curves,
        &references,
        &edges,
        &effective,
        n,
        cell,
        cfg,
        &out.lake_labels,
        &course_at,
        h,
        sea,
    )?;
    profile("network-clearance");
    for (id, edge) in edges.iter().enumerate() {
        let mut points = compact[id].clone();
        if edge.flags & 4 != 0 {
            widen_mouth(&mut points, edge.estuary, out.width);
        }
        if main_source == Some(edge.cells[0]) && external && !points.is_empty() {
            let b = boundary_point(edge.cells[0], n, cell, out.width);
            let first = points[0];
            let hb = sample(h, n, cell, b.0, b.1);
            points.insert(
                0,
                RiverPoint {
                    x: b.0,
                    y: b.1,
                    width: first.width,
                    z: hb.max(first.z),
                },
            );
        }
        for (node, p) in [(edge.from, points.first()), (edge.to, points.last())] {
            if let Some(p) = p {
                out.node_points[node as usize * 2] = p.x;
                out.node_points[node as usize * 2 + 1] = p.y;
            }
        }
        for p in &points {
            out.river_points.extend([p.x, p.y, p.width, p.z]);
        }
        out.river_offsets.push((out.river_points.len() / 4) as u32);
        out.river_meta.extend([
            id as u32,
            edge.from,
            edge.to,
            *edge_from_node.get(&edge.to).unwrap_or(&0),
            edge.flags,
            edge.estuary,
        ]);
        carve_bed(
            &points,
            h,
            &mut out.adjusted_height,
            n,
            cell,
            cfg.incision,
            edge.estuary,
        );
    }
    out.accumulation = effective;
    Ok(())
}

fn incoming_counts(selected: &[bool], receivers: &[u32]) -> Vec<u8> {
    let mut incoming = vec![0; selected.len()];
    for (i, &yes) in selected.iter().enumerate() {
        let j = receivers[i];
        if yes && j != OUT {
            incoming[j as usize] += 1;
        }
    }
    incoming
}
fn add_node(out: &mut HydrologyOutput, i: usize, lake: u32, kind: u32, cell: f32) -> u32 {
    let id = (out.node_points.len() / 2) as u32;
    let p = point(i, out.resolution, cell);
    out.node_points.extend([p.0, p.1]);
    out.node_meta.extend([i as u32, lake, kind]);
    id
}
fn boundary_cell(i: usize, n: usize) -> usize {
    let x = i % n;
    let y = i / n;
    let ds = [x, n - 1 - x, y, n - 1 - y];
    let direction = ds.iter().enumerate().min_by_key(|&(_, d)| d).unwrap().0;
    match direction {
        0 => y * n,
        1 => y * n + n - 1,
        2 => x,
        _ => (n - 1) * n + x,
    }
}
fn boundary_point(i: usize, n: usize, cell: f32, width: f32) -> (f32, f32) {
    let b = boundary_cell(i, n);
    let (x, y) = point(b, n, cell);
    if b.is_multiple_of(n) {
        (0.0, y)
    } else if b % n == n - 1 {
        (width, y)
    } else if b / n == 0 {
        (x, 0.0)
    } else {
        (x, width)
    }
}
fn channel_width(accumulation: f32, cfg: &HydrologyConfig) -> f32 {
    (5.0 * (accumulation * cfg.wetness / 1.0e6).max(0.001).powf(0.45)).clamp(0.7, 240.0)
        * cfg.width_scale
}

// The bed cut is bounded by 2 * depth + 0.75 below terrain. Its target is
// water - depth, so planform rounding may cross a bank head of depth + 0.75.
fn channel_bank_clearance(width: f32, cfg: &HydrologyConfig) -> f32 {
    if cfg.incision == 0.0 {
        width * 0.06 + 0.2
    } else {
        (width * 0.11).clamp(0.35, 12.0) * cfg.incision + 0.75
    }
}

#[allow(clippy::too_many_arguments)]
fn vector_course(
    edge: &River,
    effective: &[f32],
    h: &[f32],
    valley: &[f32],
    drainage: &Drainage,
    n: usize,
    cell: f32,
    cfg: &HydrologyConfig,
    seed: &str,
    id: u32,
    occupied: &[u32],
    geometry_index: &RiverGeometryIndex,
    links: &[CourseLink],
    node_at: &[u32],
    lakes: &[u32],
    sea: &[bool],
    width: f32,
) -> CourseGeometry {
    let mut points: Vec<RiverPoint> = edge
        .cells
        .iter()
        .map(|&i| {
            let (x, y) = point(i, n, cell);
            RiverPoint {
                x,
                y,
                width: channel_width(effective[i], cfg),
                z: drainage.filled[i],
            }
        })
        .collect();
    if edge.flags & 4 != 0 && points.len() > 1 {
        let end = points.len() - 1;
        let a = points[end - 1];
        let b = points[end];
        let mut left = 0.0;
        let mut right = 1.0;
        for _ in 0..16 {
            let t = (left + right) * 0.5;
            if sample(h, n, cell, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) > 0.0 {
                left = t;
            } else {
                right = t;
            }
        }
        points[end].x = a.x + (b.x - a.x) * right;
        points[end].y = a.y + (b.y - a.y) * right;
        points[end].z = 0.0;
    }
    if points.len() > 1 && edge.flags & 4 == 0 {
        let last = points.len() - 1;
        // Each incoming branch keeps its own flow up to the junction. The host
        // begins with the combined catchment, including any external main inflow.
        points[last].width = channel_width(effective[edge.cells[last - 1]] + cell * cell, cfg);
    }
    smooth_widths(&mut points, cell);

    // Two bounded corner-cutting passes remove D8 stairsteps without wandering out of valleys.
    for _ in 0..2 {
        let original = points.clone();
        for k in 1..points.len().saturating_sub(1) {
            if node_at[edge.cells[k]] != OUT {
                continue;
            }
            let before = original[k - 1];
            let p = original[k];
            let after = original[k + 1];
            let target = (
                (before.x + p.x * 2.0 + after.x) * 0.25,
                (before.y + p.y * 2.0 + after.y) * 0.25,
            );
            // A full grid-scale corner cut can exceed a narrow channel's bank
            // budget. Shorten that same step rather than retaining a D8 angle.
            for fraction in [1.0, 0.5, 0.25] {
                let candidate = RiverPoint {
                    x: p.x + (target.0 - p.x) * fraction,
                    y: p.y + (target.1 - p.y) * fraction,
                    ..p
                };
                if sample(h, n, cell, candidate.x, candidate.y)
                    <= p.z + channel_bank_clearance(p.width, cfg)
                    && sample(valley, n, cell, candidate.x, candidate.y)
                        <= sample(valley, n, cell, p.x, p.y).max(p.z) + p.width.mul_add(0.1, 0.3)
                    && clear_segment(points[k - 1], candidate, id, occupied, links, n, cell)
                    && clear_segment(candidate, after, id, occupied, links, n, cell)
                    && geometry_index.clear(points[k - 1], candidate, id)
                    && geometry_index.clear(candidate, after, id)
                {
                    points[k] = candidate;
                    break;
                }
            }
        }
    }
    let mut geometry = natural_course(
        &points,
        &edge.cells,
        node_at,
        h,
        n,
        cell,
        cfg,
        seed,
        id,
        occupied,
        geometry_index,
        links,
        lakes,
        sea,
        width,
        edge.flags & 1 != 0,
    );
    let mut points = geometry.points;
    // Clip the mouth to the zero-height crossing; sea bathymetry is not a water slope.
    if edge.flags & 4 != 0 && points.len() >= 2 {
        let end = points.len() - 1;
        let a = points[end - 1];
        let b = points[end];
        let za = sample(h, n, cell, a.x, a.y);
        let zb = sample(h, n, cell, b.x, b.y);
        let t = if za > 0.0 && zb <= 0.0 {
            (za / (za - zb)).clamp(0.0, 1.0)
        } else {
            1.0
        };
        points[end].x = a.x + (b.x - a.x) * t;
        points[end].y = a.y + (b.y - a.y) * t;
        points[end].z = 0.0;
    } else if edge.flags & 4 == 0 && drainage.receivers[*edge.cells.last().unwrap()] == OUT {
        let end = points.len() - 1;
        let b = boundary_point(*edge.cells.last().unwrap(), n, cell, width);
        points[end].x = b.0;
        points[end].y = b.1;
    }
    geometry.points = points;
    geometry
}
fn point_distance(a: RiverPoint, b: RiverPoint) -> f32 {
    (a.x - b.x).hypot(a.y - b.y)
}

fn profile_at(points: &[RiverPoint], stations: &[f32], s: f32) -> RiverPoint {
    let k = stations
        .partition_point(|&v| v <= s)
        .saturating_sub(1)
        .min(points.len() - 2);
    let t = ((s - stations[k]) / (stations[k + 1] - stations[k]).max(0.001)).clamp(0.0, 1.0);
    let a = points[k];
    let b = points[k + 1];
    RiverPoint {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        width: a.width + (b.width - a.width) * t,
        z: a.z + (b.z - a.z) * t,
    }
}

fn profile_knots(a: RiverPoint, b: RiverPoint, cell: f32, cfg: &HydrologyConfig) -> Vec<f32> {
    let mut splits = vec![0.0, 1.0];
    for (start, end) in [(a.x, b.x), (a.y, b.y)] {
        if (end - start).abs() < 0.0001 {
            continue;
        }
        let step = cell * 0.5;
        for knot in
            (start.min(end) / step).floor() as isize..=(start.max(end) / step).ceil() as isize
        {
            let t = (knot as f32 * step - start) / (end - start);
            if t > 0.0 && t < 1.0 {
                splits.push(t);
            }
        }
    }
    if cfg.incision > 0.0 && a.width != b.width {
        for threshold in [0.35 / 0.11, 12.0 / 0.11] {
            let t = (threshold - a.width) / (b.width - a.width);
            if t > 0.0 && t < 1.0 {
                splits.push(t);
            }
        }
    }
    splits.sort_unstable_by(f32::total_cmp);
    splits.dedup();
    splits
}

/// Minimum upstream water for a descending linear span with fixed downstream
/// water. Bilinear terrain minus the width-based incision allowance is quadratic
/// between knots; maxima of its required upstream height are solved exactly.
fn profile_requirement(a: RiverPoint, b: RiverPoint, context: &RiverPatchContext) -> (f32, f32) {
    let lower = |t: f32| {
        let p = river_point_lerp(a, b, t);
        f64::from(
            sample(context.ground, context.n, context.cell, p.x, p.y)
                - channel_bank_clearance(p.width, context.cfg),
        )
    };
    let mut required = f64::from(b.z);
    let mut crest = f64::NEG_INFINITY;
    for interval in profile_knots(a, b, context.cell, context.cfg).windows(2) {
        let start = f64::from(interval[0]);
        let length = f64::from(interval[1] - interval[0]);
        let first = lower(interval[0]);
        let last = lower(interval[1]);
        let middle = lower((interval[0] + interval[1]) * 0.5);
        let quadratic = 2.0 * (first + last - 2.0 * middle);
        let linear = last - first - quadratic;
        crest = crest.max(first).max(last);
        if quadratic < -1.0e-9 {
            let v = -linear / (2.0 * quadratic);
            if v > 0.0 && v < 1.0 {
                crest = crest.max(quadratic * v * v + linear * v + first);
            }
        }
        let numerator_linear = linear - length * f64::from(b.z);
        let numerator_first = first - start * f64::from(b.z);
        let denominator_first = 1.0 - start;
        let mut candidates = [0.0, 1.0, 0.0, 0.0];
        let mut count = 2;
        let qa = -quadratic * length;
        let qb = 2.0 * quadratic * denominator_first;
        let qc = numerator_linear * denominator_first + length * numerator_first;
        if qa.abs() > 1.0e-12 {
            let discriminant = qb * qb - 4.0 * qa * qc;
            if discriminant >= 0.0 {
                candidates[2] = (-qb - discriminant.sqrt()) / (2.0 * qa);
                candidates[3] = (-qb + discriminant.sqrt()) / (2.0 * qa);
                count = 4;
            }
        } else if qb.abs() > 1.0e-12 {
            candidates[2] = -qc / qb;
            count = 3;
        }
        for &v in &candidates[..count] {
            if !(0.0..=1.0).contains(&v) {
                continue;
            }
            let denominator = denominator_first - length * v;
            if denominator > 1.0e-9 {
                let numerator = quadratic * v * v + numerator_linear * v + numerator_first;
                required = required.max(numerator / denominator);
            } else if last > f64::from(b.z) + 0.0005 {
                return (f32::INFINITY, crest as f32);
            } else if (last - f64::from(b.z)).abs() <= 0.0005 {
                // When downstream water meets the terrain lower bound, the
                // ratio has a finite one-sided limit. Omitting this endpoint
                // misses a concave bank immediately before the fixed node.
                required = required.max(f64::from(b.z) - (2.0 * quadratic + linear) / length);
            }
        }
    }
    (required as f32, crest as f32)
}

/// Fit upstream from each retained downstream node. A small crest raises the
/// preceding water before the crest instead of cutting below the budget and
/// then rising again. Only a final span that cannot express this with linear Z
/// gets local subdivision; graph node heights are never changed.
fn fit_channel_profile(
    points: &mut Vec<(RiverPoint, f32)>,
    anchors: &[f32],
    context: &RiverPatchContext,
) -> Result<(), f32> {
    for anchors in anchors.windows(2) {
        let start = points.partition_point(|p| p.1 < anchors[0]);
        let mut end = points.partition_point(|p| p.1 < anchors[1]);
        let ceiling = points[start].0.z;
        if points[end].0.z > ceiling + 0.001 {
            return Err(points[start].1);
        }
        let mut k = end;
        while k > start {
            let a = points[k - 1].0;
            let b = points[k].0;
            let (required, crest) = profile_requirement(a, b, context);
            if crest > ceiling + 0.001 {
                return Err(points[k - 1].1);
            }
            if required <= ceiling + 0.001 {
                if k - 1 > start {
                    points[k - 1].0.z = a.z.max(required).max(b.z).min(ceiling);
                }
                k -= 1;
            } else if k < end {
                // This interior station can hold the upstream water while the
                // downstream station stays lower. Raising it only improves the
                // already-fitted downstream span's terrain clearance.
                points[k].0.z = ceiling;
            } else {
                let t = (points[k - 1].1 + points[k].1) * 0.5;
                if t <= points[k - 1].1
                    || t >= points[k].1
                    || points[k].1 - points[k - 1].1 < 1.0 / 256.0
                {
                    return Err(points[k - 1].1);
                }
                points.insert(k, (river_point_lerp(a, b, 0.5), t));
                end += 1;
                k = end;
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn natural_course(
    original: &[RiverPoint],
    cells: &[usize],
    node_at: &[u32],
    ground: &[f32],
    n: usize,
    cell: f32,
    cfg: &HydrologyConfig,
    seed: &str,
    owner: u32,
    occupied: &[u32],
    geometry_index: &RiverGeometryIndex,
    links: &[CourseLink],
    lakes: &[u32],
    sea: &[bool],
    map_width: f32,
    principal: bool,
) -> CourseGeometry {
    let clear = |a: RiverPoint, b: RiverPoint| {
        clear_segment(a, b, owner, occupied, links, n, cell) && geometry_index.clear(a, b, owner)
    };
    let bank_clearance = |width: f32| channel_bank_clearance(width, cfg);
    let mut stations = vec![0.0];
    for pair in original.windows(2) {
        stations.push(stations.last().unwrap() + point_distance(pair[0], pair[1]));
    }
    let profile = |s: f32| {
        let mut p = profile_at(original, &stations, s);
        let k = stations
            .partition_point(|&v| v <= s)
            .saturating_sub(1)
            .min(original.len() - 2);
        let a = original[k];
        let b = original[k + 1];
        // Bilinear ground along a diagonal is not the linear interpolation of
        // its endpoint heights. Fractional event stations must use that ground,
        // too; otherwise every bend on some steep D8 diagonals is rejected.
        if s > stations[k]
            && s < stations[k + 1]
            && (a.z - b.z) / point_distance(a, b).max(1.0) > 0.002
        {
            p.z = sample(ground, n, cell, p.x, p.y).max(b.z).min(a.z);
        }
        p
    };
    let factor = match cfg.meanders.as_str() {
        "none" => 0.0,
        "reduced" => 0.35,
        _ => 1.0,
    } * cfg.meander_intensity;
    let mut rng = Rng::new(seed).fork(&format!("hydrology-course-{}", cells[0]));
    let course_scale = rng.range(0.95, 1.1) as f32;
    let phases = [
        rng.range(0.0, std::f64::consts::TAU) as f32,
        rng.range(0.0, std::f64::consts::TAU) as f32,
        rng.range(0.0, std::f64::consts::TAU) as f32,
    ];
    let total = *stations.last().unwrap();
    let mut anchors: Vec<usize> = (0..cells.len())
        .filter(|&k| node_at[cells[k]] != OUT)
        .collect();
    if anchors.first() != Some(&0) {
        anchors.insert(0, 0);
    }
    if anchors.last() != Some(&(cells.len() - 1)) {
        anchors.push(cells.len() - 1);
    }
    // Curvature belongs to the physical course, not graph pieces or drainage
    // cells. Its phase never restarts at a junction. The work bound is a sampling
    // limit only; it does not enlarge the physical wavelength on coarse rasters.
    let wavelength = |p: RiverPoint| (p.width * 30.0 * course_scale).max(8.0);
    let mut samples = stations.clone();
    let mut cursor = 0.0;
    while cursor < total {
        let step = (wavelength(profile(cursor)) / 20.0)
            .max(total / 12_000.0)
            .max(0.5);
        cursor = (cursor + step).min(total);
        samples.push(cursor);
    }
    samples.sort_unstable_by(f32::total_cmp);
    samples.dedup_by(|a, b| *a == *b);
    let raw: Vec<_> = samples.iter().map(|&s| profile(s)).collect();
    let mut offsets = Vec::with_capacity(samples.len());
    let mut envelopes = vec![1.0_f32; samples.len()];
    let mut wavelengths = Vec::with_capacity(samples.len());
    let mut phase = phases[0];
    let mut coordinate = phases[1];
    let variation_seed = phases[2].to_bits();
    for (k, (&s, &p)) in samples.iter().zip(&raw).enumerate() {
        let wave = wavelength(p);
        wavelengths.push(wave);
        if k > 0 {
            let local_wave = (wave + wavelengths[k - 1]) * 0.5;
            let increment = (s - samples[k - 1]) / local_wave;
            let frequency = 2.0_f32
                .powf((meanders::course_noise(coordinate * 0.38, variation_seed) - 0.5) * 0.7);
            coordinate += increment;
            phase += increment * frequency * std::f32::consts::TAU;
        }
        // Smooth frequency and amplitude modulation creates varied bends without
        // isolated sinusoidal events, quiet gaps, or hard slope regime boundaries.
        let signal = meanders::continuous_offset(phase, coordinate, variation_seed);
        let support = (wave * 0.2).max(cell * 1.1);
        let before = profile((s - support).max(0.0));
        let after = profile((s + support).min(total));
        let direction = normalized(after.x - before.x, after.y - before.y);
        let slope = (before.z - after.z).max(0.0) / point_distance(before, after).max(1.0);
        let radius = (p.width * 4.0).max(cell * 0.5);
        let centre = sample(ground, n, cell, p.x, p.y);
        let left = sample(
            ground,
            n,
            cell,
            p.x - direction.1 * radius,
            p.y + direction.0 * radius,
        );
        let right = sample(
            ground,
            n,
            cell,
            p.x + direction.1 * radius,
            p.y - direction.0 * radius,
        );
        let confinement = (left - centre).max(0.0).min((right - centre).max(0.0)) / radius;
        let mobility = 1.0 / (1.0 + slope / 0.025 + confinement / 0.04);
        let amplitude = p.width * if principal { 4.0 } else { 2.6 } * mobility.sqrt() * factor;
        let frequency =
            2.0_f32.powf((meanders::course_noise(coordinate * 0.38, variation_seed) - 0.5) * 0.7);
        let radius_bound = wave * wave
            / (meanders::COURSE_CURVATURE_BOUND * p.width.max(0.5) * 3.0 * frequency.powi(2));
        // Slope/confinement already reduce mobility continuously. A second
        // slope-only width cap made intensity ineffective even in a fully open
        // hillside corridor. Limit curvature by physical radius and actual banks.
        let amplitude = amplitude.min(radius_bound);
        let taper = |distance: f32| {
            let t = (distance / (wave * 0.6).max(1.0)).clamp(0.0, 1.0);
            t * t * (3.0 - 2.0 * t)
        };
        let offset = signal * amplitude * taper(s) * taper(total - s);
        offsets.push((-direction.1 * offset, direction.0 * offset));
    }
    // Keep shared graph nodes exact without restarting curvature or forcing
    // whole confluence spans quiet. Subtract only the node displacement with a
    // compact C1 correction; its non-overlapping support leaves the phase intact.
    for nodes in anchors.windows(3) {
        let station = stations[nodes[1]];
        let k = samples.binary_search_by(|v| v.total_cmp(&station)).unwrap();
        let correction = offsets[k];
        let support = (wavelengths[k] * 0.55)
            .min((station - stations[nodes[0]]) * 0.45)
            .min((stations[nodes[2]] - station) * 0.45);
        if support <= 0.0 {
            continue;
        }
        let begin = samples.partition_point(|&s| s < station - support);
        let end = samples.partition_point(|&s| s <= station + support);
        for j in begin..end {
            let u = (samples[j] - station) / support;
            let basis = (1.0 - u * u).powi(2);
            offsets[j].0 -= correction.0 * basis;
            offsets[j].1 -= correction.1 * basis;
        }
        offsets[k] = (0.0, 0.0);
    }
    let admissible = |k: usize, scale: f32| {
        // The retained drainage guide includes exact shore/lake endpoints.
        // A zero displacement keeps those already established connections.
        if scale == 0.0 || offsets[k] == (0.0, 0.0) {
            return true;
        }
        let p = raw[k];
        let x = p.x + offsets[k].0 * scale;
        let y = p.y + offsets[k].1 * scale;
        if x < 0.0 || y < 0.0 || x > map_width || y > map_width {
            return false;
        }
        let i =
            ((y / cell).floor() as usize).min(n - 1) * n + ((x / cell).floor() as usize).min(n - 1);
        let old = ((p.y / cell).floor() as usize).min(n - 1) * n
            + ((p.x / cell).floor() as usize).min(n - 1);
        !sea[i]
            && lakes[i] == lakes[old]
            && sample(ground, n, cell, x, y) <= p.z + bank_clearance(p.width)
            && clear(p, RiverPoint { x, y, ..p })
    };
    for (k, envelope) in envelopes.iter_mut().enumerate() {
        for _ in 0..9 {
            if admissible(k, *envelope) {
                break;
            }
            *envelope *= 0.5;
        }
        if !admissible(k, *envelope) {
            *envelope = 0.0;
        }
    }
    // A local obstacle reduces a broad, continuous envelope on both sides.
    // Taking minima preserves admissibility; independent point clipping would
    // instead produce hooks and zigzags at terrain or occupancy boundaries.
    let relax_envelope = |envelopes: &mut [f32]| {
        for k in 1..envelopes.len() {
            let rate = (samples[k] - samples[k - 1]) / (wavelengths[k] * 0.2).max(1.0);
            envelopes[k] = envelopes[k].min(envelopes[k - 1] + rate);
        }
        for k in (0..envelopes.len() - 1).rev() {
            let rate = (samples[k + 1] - samples[k]) / (wavelengths[k] * 0.2).max(1.0);
            envelopes[k] = envelopes[k].min(envelopes[k + 1] + rate);
        }
    };
    let make_points = |envelopes: &[f32]| {
        raw.iter()
            .enumerate()
            .map(|(k, &p)| {
                let t = envelopes[k];
                // Smoothstep below its input bound retains corridor clearance and
                // softens the shoulders of the bounded envelope.
                let scale = t * t * (2.0 - t);
                RiverPoint {
                    x: p.x + offsets[k].0 * scale,
                    y: p.y + offsets[k].1 * scale,
                    ..p
                }
            })
            .collect::<Vec<_>>()
    };
    let reduce_near = |envelopes: &mut [f32], centres: &[usize], force_zero: bool| {
        for &centre in centres {
            let support = wavelengths[centre] * 0.5;
            let begin = samples.partition_point(|&s| s < samples[centre] - support);
            let end = samples.partition_point(|&s| s <= samples[centre] + support);
            for k in begin..end {
                let u = ((samples[k] - samples[centre]).abs() / support).min(1.0);
                let taper = u * u * (3.0 - 2.0 * u);
                if force_zero {
                    envelopes[k] = envelopes[k].min(taper);
                } else {
                    envelopes[k] *= 0.5 + 0.5 * taper;
                }
            }
        }
    };
    relax_envelope(&mut envelopes);
    let mut points = make_points(&envelopes);
    // Process every collision on every pass. Handling only the first handful
    // previously reverted kilometres of open course for unrelated downstream
    // obstacles. All corrections now belong only to their local supports.
    for attempt in 0..6 {
        let mut centres: Vec<usize> = envelopes
            .iter()
            .enumerate()
            .filter_map(|(k, &t)| (!admissible(k, t * t * (2.0 - t))).then_some(k))
            .collect();
        for (k, pair) in points.windows(2).enumerate() {
            if !clear(pair[0], pair[1]) {
                centres.extend([k, k + 1]);
            }
        }
        if let Some((a, b)) = first_course_crossing(&points, cell) {
            centres.extend([a, a + 1, b, b + 1]);
        }
        if centres.is_empty() {
            break;
        }
        centres.sort_unstable();
        centres.dedup();
        reduce_near(&mut envelopes, &centres, attempt == 5);
        relax_envelope(&mut envelopes);
        points = make_points(&envelopes);
    }
    // Nonconvex corridors can expose another local obstruction as the envelope
    // shrinks. Restore only remaining obstructed supports, never the full course.
    for _ in 0..8 {
        let mut centres: Vec<usize> = envelopes
            .iter()
            .enumerate()
            .filter_map(|(k, &t)| (!admissible(k, t * t * (2.0 - t))).then_some(k))
            .collect();
        for (k, pair) in points.windows(2).enumerate() {
            if !clear(pair[0], pair[1]) {
                centres.extend([k, k + 1]);
            }
        }
        if let Some((a, b)) = first_course_crossing(&points, cell) {
            centres.extend([a, a + 1, b, b + 1]);
        }
        if centres.is_empty() {
            break;
        }
        centres.sort_unstable();
        centres.dedup();
        reduce_near(&mut envelopes, &centres, true);
        relax_envelope(&mut envelopes);
        points = make_points(&envelopes);
    }
    // Keep the established guide at any last obstructed sample/segment. Earlier
    // support reduction has already made these isolated residuals nearly zero.
    let mut residual = Vec::new();
    for (k, &t) in envelopes.iter().enumerate() {
        if !admissible(k, t * t * (2.0 - t)) {
            residual.push(k);
        }
    }
    for (k, pair) in points.windows(2).enumerate() {
        if !clear(pair[0], pair[1]) {
            residual.extend([k, k + 1]);
        }
    }
    for k in residual {
        envelopes[k] = 0.0;
    }
    points = make_points(&envelopes);
    // Only an unresolved genuine self-intersection may use a complete guide.
    if course_crosses(&points, cell) {
        points.clone_from(&raw);
    }
    let cuts: Vec<usize> = stations
        .iter()
        .map(|&s| samples.binary_search_by(|v| v.total_cmp(&s)).unwrap())
        .collect();
    let context = RiverPatchContext {
        ground,
        lakes,
        sea,
        n,
        cell,
        cfg,
    };
    let profile_anchors: Vec<f32> = anchors.iter().map(|&k| cuts[k] as f32).collect();
    let mut fitted = None;
    for attempt in 0..6 {
        let mut candidate: Vec<_> = points
            .iter()
            .copied()
            .zip((0..points.len()).map(|k| k as f32))
            .collect();
        let mut centres = Vec::new();
        if let Err(t) = fit_channel_profile(&mut candidate, &profile_anchors, &context) {
            let k = (t.floor() as usize).min(points.len() - 2);
            centres.extend([k, k + 1]);
        }
        for (k, pair) in points.windows(2).enumerate() {
            if !clear(pair[0], pair[1]) {
                centres.extend([k, k + 1]);
            }
        }
        if let Some((a, b)) = first_course_crossing(&points, cell) {
            centres.extend([a, a + 1, b, b + 1]);
        }
        if centres.is_empty() {
            fitted = Some(candidate);
            break;
        }
        centres.sort_unstable();
        centres.dedup();
        reduce_near(&mut envelopes, &centres, attempt >= 3);
        relax_envelope(&mut envelopes);
        points = make_points(&envelopes);
    }
    let fitted = fitted.unwrap_or_else(|| {
        let mut guide: Vec<_> = raw
            .iter()
            .copied()
            .zip((0..raw.len()).map(|k| k as f32))
            .collect();
        let _ = fit_channel_profile(&mut guide, &profile_anchors, &context);
        guide
    });
    let refined_cuts: Vec<_> = cuts
        .iter()
        .map(|&k| fitted.partition_point(|p| p.1 < k as f32))
        .collect();
    let refined_samples: Vec<_> = fitted
        .iter()
        .map(|&(_, t)| {
            let k = (t.floor() as usize).min(samples.len() - 2);
            samples[k] + (samples[k + 1] - samples[k]) * (t - k as f32).clamp(0.0, 1.0)
        })
        .collect();
    let points: Vec<_> = fitted.into_iter().map(|p| p.0).collect();
    let samples = refined_samples;
    let cuts = refined_cuts;
    // Nearly coincident physical/raster stations otherwise reduce the shared
    // Hermite tangent to centimetres on a much longer neighbouring segment.
    // Remove redundant controls at the retained error, keeping every graph
    // anchor. The original metric stations still carry width and water profiles.
    let mut controls = Vec::new();
    let mut control_stations = Vec::new();
    let mut control_indices = Vec::new();
    for pair in anchors.windows(2) {
        let begin = cuts[pair[0]];
        let end = cuts[pair[1]];
        let compact = compact_course_mode(&points[begin..=end], cell, false);
        let mut k = begin;
        for p in compact.into_iter().skip(usize::from(!controls.is_empty())) {
            while k < end
                && (points[k].x != p.x
                    || points[k].y != p.y
                    || points[k].z != p.z
                    || points[k].width != p.width)
            {
                k += 1;
            }
            controls.push((p.x, p.y));
            control_stations.push(samples[k]);
            control_indices.push(k);
        }
    }
    let mean_width = points.iter().map(|p| p.width).sum::<f32>() / points.len() as f32;
    let tolerance = (mean_width * 0.025).clamp(0.1, 1.0);
    let make_smooth = |scales: &[f32]| {
        meanders::smooth_polyline(&controls, tolerance, scales)
            .into_iter()
            .map(|(x, y, t)| {
                let k = (t.floor() as usize).min(controls.len() - 2);
                let f = (t - k as f32).clamp(0.0, 1.0);
                if f == 0.0 {
                    return (x, y, control_indices[k] as f32);
                }
                if f == 1.0 {
                    return (x, y, control_indices[k + 1] as f32);
                }
                let s = control_stations[k] + (control_stations[k + 1] - control_stations[k]) * f;
                let k = samples
                    .partition_point(|&v| v <= s)
                    .saturating_sub(1)
                    .min(points.len() - 2);
                let f =
                    ((s - samples[k]) / (samples[k + 1] - samples[k]).max(0.0001)).clamp(0.0, 1.0);
                (x, y, k as f32 + f)
            })
            .collect::<Vec<_>>()
    };
    let mut tangent_scales = vec![1.0_f32; controls.len()];
    let mut smooth = make_smooth(&tangent_scales);
    for _ in 0..6 {
        let mut rejected = vec![false; controls.len() - 1];
        let mut previous: Option<RiverPoint> = None;
        for &(x, y, t) in &smooth {
            let k = (t.floor() as usize).min(points.len() - 2);
            let f = (t - k as f32).clamp(0.0, 1.0);
            let a = points[k];
            let b = points[k + 1];
            let p = RiverPoint {
                x,
                y,
                width: a.width + (b.width - a.width) * f,
                z: a.z + (b.z - a.z) * f,
            };
            let span = control_indices
                .partition_point(|&v| (v as f32) < t)
                .saturating_sub(1)
                .min(controls.len() - 2);
            let i = (y / cell).floor().clamp(0.0, (n - 1) as f32) as usize * n
                + (x / cell).floor().clamp(0.0, (n - 1) as f32) as usize;
            let raw_x = a.x + (b.x - a.x) * f;
            let raw_y = a.y + (b.y - a.y) * f;
            let old = (raw_y / cell).floor().clamp(0.0, (n - 1) as f32) as usize * n
                + (raw_x / cell).floor().clamp(0.0, (n - 1) as f32) as usize;
            let valid = x >= 0.0
                && y >= 0.0
                && x <= map_width
                && y <= map_width
                && sea[i] == sea[old]
                && lakes[i] == lakes[old]
                && sample(ground, n, cell, x, y) <= p.z + bank_clearance(p.width) + 0.001
                && previous.is_none_or(|before| clear(before, p));
            if !valid {
                rejected[span] = true;
            }
            previous = Some(p);
        }
        if !rejected.iter().any(|&v| v) {
            break;
        }
        for (node, scale) in tangent_scales.iter_mut().enumerate() {
            if (node > 0 && rejected[node - 1]) || (node < rejected.len() && rejected[node]) {
                *scale *= 0.5;
            }
        }
        smooth = make_smooth(&tangent_scales);
    }
    let smooth = meanders::refine_profile(
        &smooth,
        (mean_width * 0.015).clamp(0.1, 0.75),
        |_x, _y, t| {
            let k = (t.floor() as usize).min(points.len() - 2);
            let f = (t - k as f32).clamp(0.0, 1.0);
            let a = points[k];
            let b = points[k + 1];
            a.z + (b.z - a.z) * f
        },
    );
    // Validate whole compact spline spans. One obstructed bank or shore station
    // falls back only to that span's dense retained geometry, preserving smooth
    // curves everywhere else and keeping both shared endpoints exact.
    let mut spans: Vec<Vec<(RiverPoint, f32)>> = Vec::with_capacity(controls.len() - 1);
    let raw_span = |span: usize| {
        (control_indices[span]..=control_indices[span + 1])
            .map(|k| (points[k], k as f32))
            .collect::<Vec<_>>()
    };
    for span in 0..controls.len() - 1 {
        let start = control_indices[span] as f32;
        let end = control_indices[span + 1] as f32;
        let begin = smooth.partition_point(|&(_, _, t)| t < start);
        let finish = smooth.partition_point(|&(_, _, t)| t <= end);
        let mut candidate: Vec<(RiverPoint, f32)> = Vec::with_capacity(finish - begin);
        let mut safe = true;
        for &(x, y, t) in &smooth[begin..finish] {
            let k = (t.floor() as usize).min(points.len() - 2);
            let f = (t - k as f32).clamp(0.0, 1.0);
            let a = points[k];
            let b = points[k + 1];
            let linear = RiverPoint {
                x: a.x + (b.x - a.x) * f,
                y: a.y + (b.y - a.y) * f,
                width: a.width + (b.width - a.width) * f,
                z: a.z + (b.z - a.z) * f,
            };
            let p = RiverPoint { x, y, ..linear };
            if let Some(&(previous, _)) = candidate.last() {
                safe &= clear(previous, p);
            }
            let index = (y / cell).floor().clamp(0.0, (n - 1) as f32) as usize * n
                + (x / cell).floor().clamp(0.0, (n - 1) as f32) as usize;
            let raw_index = (linear.y / cell).floor().clamp(0.0, (n - 1) as f32) as usize * n
                + (linear.x / cell).floor().clamp(0.0, (n - 1) as f32) as usize;
            safe &= x >= 0.0
                && y >= 0.0
                && x <= map_width
                && y <= map_width
                && sea[index] == sea[raw_index]
                && lakes[index] == lakes[raw_index];
            candidate.push((p, t));
        }
        safe &= candidate.len() >= 2
            && candidate.first().is_some_and(|p| p.1 == start)
            && candidate.last().is_some_and(|p| p.1 == end)
            && fit_channel_profile(&mut candidate, &[start, end], &context).is_ok();
        if !safe
            || candidate.len() < 2
            || course_crosses(&candidate.iter().map(|p| p.0).collect::<Vec<_>>(), cell)
        {
            spans.push(raw_span(span));
        } else {
            spans.push(candidate);
        }
    }
    let assemble = |spans: &[Vec<(RiverPoint, f32)>]| {
        let mut detailed = Vec::new();
        let mut owners = Vec::new();
        for (span, course) in spans.iter().enumerate() {
            for &p in course.iter().skip(usize::from(span > 0)) {
                detailed.push(p);
                owners.push(span);
            }
        }
        (detailed, owners)
    };
    let (mut detailed, mut owners) = assemble(&spans);
    // Smooth spans may interact with another span after local replacement.
    // Restore only the two implicated spans, then rebuild the retained course.
    for _ in 0..8 {
        let xy: Vec<_> = detailed.iter().map(|p| p.0).collect();
        let Some((a, b)) = first_course_crossing(&xy, cell) else {
            break;
        };
        for span in [owners[a + 1], owners[b + 1]] {
            spans[span] = raw_span(span);
        }
        (detailed, owners) = assemble(&spans);
    }
    if course_crosses(&detailed.iter().map(|p| p.0).collect::<Vec<_>>(), cell) {
        return CourseGeometry { points, cuts };
    }
    let mut new_cuts = vec![0; cuts.len()];
    let mut cut_index = 0;
    for (index, &(_, t)) in detailed.iter().enumerate() {
        while cut_index < cuts.len() && t >= cuts[cut_index] as f32 {
            new_cuts[cut_index] = index;
            cut_index += 1;
        }
    }
    CourseGeometry {
        points: detailed.into_iter().map(|p| p.0).collect(),
        cuts: new_cuts,
    }
}

fn smooth_widths(points: &mut [RiverPoint], cell: f32) {
    let mut smoothed: Vec<f32> = points.iter().map(|p| p.width).collect();
    for k in 1..points.len() {
        let reach = (points[k].width * 2.0).max(cell * 2.0);
        let t = 1.0 - (-point_distance(points[k - 1], points[k]) / reach).exp();
        smoothed[k] = smoothed[k - 1] + (smoothed[k] - smoothed[k - 1]) * t;
    }
    for k in (0..points.len().saturating_sub(1)).rev() {
        let reach = (points[k].width * 2.0).max(cell * 2.0);
        let t = 1.0 - (-point_distance(points[k + 1], points[k]) / reach).exp();
        smoothed[k] = smoothed[k + 1] + (smoothed[k] - smoothed[k + 1]) * t;
    }
    for (p, width) in points.iter_mut().zip(smoothed) {
        p.width = width;
    }
}

#[allow(clippy::too_many_arguments)]
fn clear_segment(
    a: RiverPoint,
    b: RiverPoint,
    owner: u32,
    occupied: &[u32],
    links: &[CourseLink],
    n: usize,
    cell: f32,
) -> bool {
    let steps = (point_distance(a, b) / (cell * 0.6)).ceil().max(1.0) as usize;
    (0..=steps).all(|k| {
        let t = k as f32 / steps as f32;
        let x = ((a.x + (b.x - a.x) * t) / cell)
            .floor()
            .clamp(0.0, (n - 1) as f32) as usize;
        let y = ((a.y + (b.y - a.y) * t) / cell)
            .floor()
            .clamp(0.0, (n - 1) as f32) as usize;
        let other = occupied[y * n + x];
        if other == OUT || other == OUT - 1 || other == owner {
            return true;
        }
        let near = |link: CourseLink, expected: u32| {
            link.is_some_and(|(host, junction, reach)| {
                let p = point(junction, n, cell);
                host == expected
                    && ((x as f32 + 0.5) * cell - p.0).hypot((y as f32 + 0.5) * cell - p.1)
                        <= reach.min(cell * 1.5)
            })
        };
        near(links[other as usize], owner) || near(links[owner as usize], other)
    })
}

fn occupy_curve(points: &[RiverPoint], occupied: &mut [u32], owner: u32, n: usize, cell: f32) {
    for pair in points.windows(2) {
        let steps = (point_distance(pair[0], pair[1]) / (cell * 0.45))
            .ceil()
            .max(1.0) as usize;
        for k in 0..=steps {
            let t = k as f32 / steps as f32;
            let x = ((pair[0].x + (pair[1].x - pair[0].x) * t) / cell)
                .floor()
                .clamp(0.0, (n - 1) as f32) as usize;
            let y = ((pair[0].y + (pair[1].y - pair[0].y) * t) / cell)
                .floor()
                .clamp(0.0, (n - 1) as f32) as usize;
            if occupied[y * n + x] == OUT {
                occupied[y * n + x] = owner;
            }
        }
    }
}

fn course_crosses(points: &[RiverPoint], cell: f32) -> bool {
    first_course_crossing(points, cell).is_some()
}

fn first_course_crossing(points: &[RiverPoint], cell: f32) -> Option<(usize, usize)> {
    let mut bins: HashMap<(isize, isize), Vec<usize>> = HashMap::new();
    let side = |a: RiverPoint, b: RiverPoint, p: RiverPoint| {
        (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    };
    for (id, pair) in points.windows(2).enumerate() {
        let a = pair[0];
        let b = pair[1];
        let xmin = (a.x.min(b.x) / cell).floor() as isize;
        let xmax = (a.x.max(b.x) / cell).floor() as isize;
        let ymin = (a.y.min(b.y) / cell).floor() as isize;
        let ymax = (a.y.max(b.y) / cell).floor() as isize;
        for y in ymin..=ymax {
            for x in xmin..=xmax {
                let nearby = bins.entry((x, y)).or_default();
                for &other in nearby.iter() {
                    if other + 1 >= id {
                        continue;
                    }
                    let c = points[other];
                    let d = points[other + 1];
                    if side(a, b, c) * side(a, b, d) < -0.0001
                        && side(c, d, a) * side(c, d, b) < -0.0001
                    {
                        return Some((other, id));
                    }
                }
                nearby.push(id);
            }
        }
    }
    None
}

fn curves_cross(a: &[RiverPoint], b: &[RiverPoint], cell: f32) -> bool {
    first_curves_crossing(a, b, cell).is_some()
}

fn first_curves_crossing(a: &[RiverPoint], b: &[RiverPoint], cell: f32) -> Option<(usize, usize)> {
    let mut bins: HashMap<(isize, isize), Vec<usize>> = HashMap::new();
    let bounds = |a: RiverPoint, b: RiverPoint| {
        (
            (a.x.min(b.x) / cell).floor() as isize,
            (a.x.max(b.x) / cell).floor() as isize,
            (a.y.min(b.y) / cell).floor() as isize,
            (a.y.max(b.y) / cell).floor() as isize,
        )
    };
    for (id, pair) in b.windows(2).enumerate() {
        let (xmin, xmax, ymin, ymax) = bounds(pair[0], pair[1]);
        for y in ymin..=ymax {
            for x in xmin..=xmax {
                bins.entry((x, y)).or_default().push(id);
            }
        }
    }
    for (aid, pair) in a.windows(2).enumerate() {
        let (xmin, xmax, ymin, ymax) = bounds(pair[0], pair[1]);
        for y in ymin..=ymax {
            for x in xmin..=xmax {
                let Some(nearby) = bins.get(&(x, y)) else {
                    continue;
                };
                for &id in nearby {
                    let c = b[id];
                    let d = b[id + 1];
                    // The common endpoint is allowed; crossing and then joining
                    // again is not. Only local graph neighbours are queried.
                    if river_segments_intersect(pair[0], pair[1], c, d) {
                        return Some((aid, id));
                    }
                }
            }
        }
    }
    None
}

fn compact_course(points: &[RiverPoint], cell: f32) -> Vec<RiverPoint> {
    compact_course_mode(points, cell, true)
}

fn compact_course_mode(points: &[RiverPoint], cell: f32, retain_profiles: bool) -> Vec<RiverPoint> {
    // Retain bends, confluence endpoints and material width changes after all joins.
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut ranges = vec![(0, points.len() - 1)];
    while let Some((start, end)) = ranges.pop() {
        let a = points[start];
        let b = points[end];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let mut worst = 1.0;
        let mut split = None;
        for (k, &p) in points.iter().enumerate().take(end).skip(start + 1) {
            let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy).max(0.001))
                .clamp(0.0, 1.0);
            let geometry =
                (p.x - a.x - dx * t).hypot(p.y - a.y - dy * t) / (p.width * 0.025).clamp(0.1, 1.0);
            let water = (p.z - (a.z + (b.z - a.z) * t)).abs() / (p.width * 0.015).clamp(0.1, 0.75);
            let width =
                (p.width - (a.width + (b.width - a.width) * t)).abs() / (p.width * 0.025).max(0.05);
            let error = if retain_profiles {
                geometry.max(water).max(width)
            } else {
                geometry
            };
            if error > worst {
                worst = error;
                split = Some(k);
            }
        }
        if let Some(k) = split {
            keep[k] = true;
            ranges.extend([(start, k), (k, end)]);
        }
    }
    let _ = cell;
    points
        .iter()
        .zip(keep)
        .filter_map(|(&p, keep)| keep.then_some(p))
        .collect()
}

fn refine_shortcut(compact: &mut Vec<RiverPoint>, detailed: &[RiverPoint], segment: usize) -> bool {
    // Fitting the water profile can change retained Z without changing its
    // station on the detailed planform. Match that geometry, not the old Z.
    let same = |a: RiverPoint, b: RiverPoint| a.x == b.x && a.y == b.y && a.width == b.width;
    let Some(start) = detailed.iter().position(|&p| same(p, compact[segment])) else {
        return false;
    };
    let Some(offset) = detailed[start..]
        .iter()
        .position(|&p| same(p, compact[segment + 1]))
    else {
        return false;
    };
    if offset <= 1 {
        return false;
    }
    compact.splice(
        segment..=segment + 1,
        detailed[start..=start + offset].iter().copied(),
    );
    true
}

fn fit_compact_profile(
    points: &mut Vec<RiverPoint>,
    detailed: &[RiverPoint],
    context: &RiverPatchContext,
) -> Result<(), String> {
    for _ in 0..=detailed.len() {
        let mut candidate: Vec<_> = points
            .iter()
            .copied()
            .enumerate()
            .map(|(id, p)| (p, id as f32))
            .collect();
        let end = (points.len() - 1) as f32;
        match fit_channel_profile(&mut candidate, &[0.0, end], context) {
            Ok(()) => {
                *points = candidate.into_iter().map(|p| p.0).collect();
                return Ok(());
            }
            Err(station) => {
                let segment = (station.floor() as usize).min(points.len() - 2);
                if !refine_shortcut(points, detailed, segment) {
                    return Err(
                        "river profile clearance: shortcut exceeds fixed-node terrain budget"
                            .into(),
                    );
                }
            }
        }
    }
    Err("river profile clearance: local refinement did not converge".into())
}

struct IndexedRiverSegment {
    a: RiverPoint,
    b: RiverPoint,
    owner: u32,
    revision: u32,
    station: usize,
    arc: f32,
}

#[derive(Clone, Copy)]
struct BankJunction {
    x: f32,
    y: f32,
    radius: f32,
}

struct RiverGeometryBin {
    owner: u32,
    segments: Vec<usize>,
}

// Exact axis clearance is separate from the coarse occupancy raster. Near a
// confluence the raster permits neighbouring cells, but two axes may intersect
// only at the retained shared endpoint. Revisions replace one whole course
// without removing entries from every spatial bin.
type BankNodeIncidents = HashMap<u32, (usize, Vec<(u32, usize, bool)>)>;

struct RiverGeometryIndex<'a> {
    cell: f32,
    revisions: Vec<u32>,
    segments: Vec<IndexedRiverSegment>,
    bins: HashMap<(isize, isize), RiverGeometryBin>,
    junctions: HashMap<(u32, u32), Vec<BankJunction>>,
    lakes: &'a [u32],
    n: usize,
    bank_margin: f32,
    arc_base: f32,
    bank_same_course: bool,
    terminal_contacts: Vec<([f32; 2], [f32; 2])>,
}

impl<'a> RiverGeometryIndex<'a> {
    fn new(cell: f32, owners: usize) -> Self {
        Self {
            cell,
            revisions: vec![0; owners],
            segments: Vec::new(),
            bins: HashMap::new(),
            junctions: HashMap::new(),
            lakes: &[],
            n: 0,
            bank_margin: 3.0,
            arc_base: 0.0,
            bank_same_course: false,
            terminal_contacts: Vec::new(),
        }
    }

    fn configure_lakes(&mut self, lakes: &'a [u32], n: usize) {
        self.lakes = lakes;
        self.n = n;
    }

    fn configure_junctions(
        &mut self,
        edges: &[River],
        owners: &[u32],
        effective: &[f32],
        n: usize,
        cfg: &HydrologyConfig,
        curves: Option<&[Vec<RiverPoint>]>,
    ) {
        let mut nodes: BankNodeIncidents = HashMap::new();
        for (id, edge) in edges.iter().enumerate() {
            for (node, cell, incoming) in [
                (edge.from, edge.cells[0], false),
                (edge.to, *edge.cells.last().unwrap(), true),
            ] {
                nodes
                    .entry(node)
                    .or_insert_with(|| (cell, Vec::new()))
                    .1
                    .push((owners[id], id, incoming));
            }
        }
        for (_, (cell, mut incident)) in nodes {
            incident.sort_unstable();
            if incident.iter().all(|edge| edge.0 == incident[0].0) {
                continue;
            }
            let canonical = curves.map(|curves| {
                let (_, id, incoming) = incident[0];
                if incoming {
                    *curves[id].last().unwrap()
                } else {
                    curves[id][0]
                }
            });
            let (x, y) = canonical.map_or_else(|| point(cell, n, self.cell), |p| (p.x, p.y));
            let width = channel_width(effective[cell], cfg);
            let cap = width * 4.0 + self.cell;
            let guides: Vec<_> = incident
                .iter()
                .map(|&(_, id, incoming)| {
                    let mut guide = terminal_bank_guide(
                        &edges[id], incoming, effective, n, self.cell, cfg, cap,
                    );
                    if let Some(p) = canonical {
                        guide[0].x = p.x;
                        guide[0].y = p.y;
                    }
                    guide
                })
                .collect();
            for a in 0..incident.len() {
                for b in a + 1..incident.len() {
                    if incident[a].0 == incident[b].0 {
                        continue;
                    }
                    // Acute tributaries can share water before their axes meet.
                    // Reserve only the original guides' continuously joined
                    // terminal approach, stopping at the first clear banks.
                    let step = (self.cell * 0.25).min(width * 0.25).max(0.25);
                    let extent = terminal_bank_extent(&guides[a], &guides[b], step)
                        .max(terminal_bank_extent(&guides[b], &guides[a], step));
                    let junction = BankJunction {
                        x,
                        y,
                        radius: (extent + step * 2.0).max(width * 2.0).min(cap),
                    };
                    self.junctions
                        .entry((incident[a].0, incident[b].0))
                        .or_default()
                        .push(junction);
                }
            }
        }
    }

    fn insert(&mut self, owner: u32, points: &[RiverPoint]) {
        let mut arc = self.arc_base;
        for (station, pair) in points.windows(2).enumerate() {
            let id = self.segments.len();
            let a = pair[0];
            let b = pair[1];
            self.segments.push(IndexedRiverSegment {
                a,
                b,
                owner,
                revision: self.revisions[owner as usize],
                station,
                arc,
            });
            arc += point_distance(a, b);
            let pad = a.width.max(b.width) * 0.65 + 1.0;
            for y in ((a.y.min(b.y) - pad) / self.cell).floor() as isize
                ..=((a.y.max(b.y) + pad) / self.cell).floor() as isize
            {
                for x in ((a.x.min(b.x) - pad) / self.cell).floor() as isize
                    ..=((a.x.max(b.x) + pad) / self.cell).floor() as isize
                {
                    let bin = self.bins.entry((x, y)).or_insert_with(|| RiverGeometryBin {
                        owner,
                        segments: Vec::new(),
                    });
                    if bin.owner != owner {
                        bin.owner = OUT;
                    }
                    bin.segments.push(id);
                }
            }
        }
    }

    fn replace(&mut self, owner: u32, points: &[RiverPoint]) {
        self.revisions[owner as usize] += 1;
        self.insert(owner, points);
    }

    fn clear(&self, a: RiverPoint, b: RiverPoint, owner: u32) -> bool {
        self.first_conflict(a, b, owner).is_none()
    }

    fn first_conflict(&self, a: RiverPoint, b: RiverPoint, owner: u32) -> Option<(u32, usize)> {
        self.first_conflict_at(a, b, owner, None)
    }

    fn first_conflict_at(
        &self,
        a: RiverPoint,
        b: RiverPoint,
        owner: u32,
        arc: Option<f32>,
    ) -> Option<(u32, usize)> {
        let pad = a.width.max(b.width) * 0.65 + 1.0;
        for y in ((a.y.min(b.y) - pad) / self.cell).floor() as isize
            ..=((a.y.max(b.y) + pad) / self.cell).floor() as isize
        {
            for x in ((a.x.min(b.x) - pad) / self.cell).floor() as isize
                ..=((a.x.max(b.x) + pad) / self.cell).floor() as isize
            {
                let Some(nearby) = self.bins.get(&(x, y)) else {
                    continue;
                };
                if nearby.owner == owner {
                    continue;
                }
                for &id in &nearby.segments {
                    let segment = &self.segments[id];
                    if segment.owner != owner
                        && segment.revision == self.revisions[segment.owner as usize]
                    {
                        let junctions = self
                            .junctions
                            .get(&(owner.min(segment.owner), owner.max(segment.owner)));
                        if river_segments_intersect(a, b, segment.a, segment.b)
                            || (!self.same_lake(a, b, segment.a, segment.b)
                                && !arc.is_some_and(|start| {
                                    let (_, t, u) = river_bank_closest(a, b, segment.a, segment.b);
                                    let first = start + point_distance(a, b) * t;
                                    let second =
                                        segment.arc + point_distance(segment.a, segment.b) * u;
                                    (self.bank_same_course
                                        && (first - second).abs()
                                            <= a.width
                                                .max(b.width)
                                                .max(segment.a.width)
                                                .max(segment.b.width)
                                                * 3.0)
                                        || self.terminal_contacts.iter().any(|&(a, b)| {
                                            first >= a[0]
                                                && first <= a[1]
                                                && second >= b[0]
                                                && second <= b[1]
                                        })
                                })
                                && river_banks_contact(
                                    a,
                                    b,
                                    segment.a,
                                    segment.b,
                                    junctions.map_or(&[], Vec::as_slice),
                                    self.bank_margin,
                                ))
                        {
                            return Some((segment.owner, segment.station));
                        }
                    }
                }
            }
        }
        None
    }

    fn same_lake(&self, a: RiverPoint, b: RiverPoint, c: RiverPoint, d: RiverPoint) -> bool {
        if self.lakes.is_empty() {
            return false;
        }
        let label = |p: RiverPoint| {
            let x = (p.x / self.cell).floor().clamp(0.0, self.n as f32 - 1.0) as usize;
            let y = (p.y / self.cell).floor().clamp(0.0, self.n as f32 - 1.0) as usize;
            self.lakes[y * self.n + x]
        };
        let lake = label(a);
        lake != 0
            && [(a, b), (c, d)].into_iter().all(|(p, q)| {
                let count = (point_distance(p, q) / (self.cell * 0.25)).ceil().max(1.0) as usize;
                (0..=count).all(|i| label(river_point_lerp(p, q, i as f32 / count as f32)) == lake)
            })
    }
}

fn terminal_bank_guide(
    edge: &River,
    incoming: bool,
    effective: &[f32],
    n: usize,
    cell: f32,
    cfg: &HydrologyConfig,
    cap: f32,
) -> Vec<RiverPoint> {
    let mut guide = Vec::new();
    let mut station = 0.0;
    for offset in 0..edge.cells.len() {
        let id = if incoming {
            edge.cells.len() - 1 - offset
        } else {
            offset
        };
        let i = edge.cells[id];
        let (x, y) = point(i, n, cell);
        let area = if incoming && offset == 0 && id > 0 {
            effective[edge.cells[id - 1]] + cell * cell
        } else {
            effective[i]
        };
        let p = RiverPoint {
            x,
            y,
            width: channel_width(area, cfg),
            z: 0.0,
        };
        if let Some(&previous) = guide.last() {
            station += point_distance(previous, p);
        }
        guide.push(p);
        if station >= cap {
            break;
        }
    }
    guide
}

fn terminal_bank_extent(guide: &[RiverPoint], other: &[RiverPoint], step: f32) -> f32 {
    let mut extent: f32 = 0.0;
    for pair in guide.windows(2) {
        let samples = (point_distance(pair[0], pair[1]) / step).ceil().max(1.0) as usize;
        for sample in 1..=samples {
            let p = river_point_lerp(pair[0], pair[1], sample as f32 / samples as f32);
            let touching = other.windows(2).any(|segment| {
                let margin =
                    (p.width.max(segment[0].width).max(segment[1].width) * 0.15).clamp(1.0, 3.0);
                river_bank_gap(p, p, segment[0], segment[1]) < margin
            });
            if !touching {
                return extent;
            }
            extent = extent.max(point_distance(guide[0], p));
        }
    }
    extent
}

fn river_point_lerp(a: RiverPoint, b: RiverPoint, t: f32) -> RiverPoint {
    RiverPoint {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        width: a.width + (b.width - a.width) * t,
        z: a.z + (b.z - a.z) * t,
    }
}

fn river_bank_gap(a: RiverPoint, b: RiverPoint, c: RiverPoint, d: RiverPoint) -> f32 {
    river_bank_closest(a, b, c, d).0
}

fn river_bank_closest(
    a: RiverPoint,
    b: RiverPoint,
    c: RiverPoint,
    d: RiverPoint,
) -> (f32, f32, f32) {
    let mut closest = (f32::INFINITY, 0.0, 0.0);
    for (id, (p, x, y)) in [(a, c, d), (b, c, d), (c, a, b), (d, a, b)]
        .into_iter()
        .enumerate()
    {
        let dx = y.x - x.x;
        let dy = y.y - x.y;
        let t = (((p.x - x.x) * dx + (p.y - x.y) * dy) / (dx * dx + dy * dy).max(0.0001))
            .clamp(0.0, 1.0);
        let q = river_point_lerp(x, y, t);
        let gap = point_distance(p, q) - (p.width + q.width) * 0.5;
        if gap < closest.0 {
            closest = if id < 2 {
                (gap, id as f32, t)
            } else {
                (gap, t, (id - 2) as f32)
            };
        }
    }
    closest
}

fn outside_bank_junction(
    a: RiverPoint,
    b: RiverPoint,
    node: BankJunction,
) -> Vec<(RiverPoint, RiverPoint)> {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let x = a.x - node.x;
    let y = a.y - node.y;
    let l2 = dx * dx + dy * dy;
    let c = x * x + y * y - node.radius * node.radius;
    if l2 < 0.0001 {
        return if c >= 0.0 { vec![(a, b)] } else { Vec::new() };
    }
    let dot = x * dx + y * dy;
    let discriminant = dot * dot - l2 * c;
    if discriminant <= 0.0 {
        return vec![(a, b)];
    }
    let root = discriminant.sqrt();
    let enter = (-dot - root) / l2;
    let leave = (-dot + root) / l2;
    if leave <= 0.0 || enter >= 1.0 {
        return vec![(a, b)];
    }
    let mut pieces = Vec::with_capacity(2);
    if enter > 0.0 {
        pieces.push((a, river_point_lerp(a, b, enter)));
    }
    if leave < 1.0 {
        pieces.push((river_point_lerp(a, b, leave), b));
    }
    pieces
}

fn river_banks_contact(
    a: RiverPoint,
    b: RiverPoint,
    c: RiverPoint,
    d: RiverPoint,
    junctions: &[BankJunction],
    margin_cap: f32,
) -> bool {
    let margin = (a.width.max(b.width).max(c.width).max(d.width) * 0.15)
        .min(margin_cap)
        .max(margin_cap.min(1.0));
    if river_bank_gap(a, b, c, d) >= margin {
        return false;
    }
    if junctions.is_empty() {
        return true;
    }
    let mut first = vec![(a, b)];
    let mut second = vec![(c, d)];
    for &node in junctions {
        first = first
            .into_iter()
            .flat_map(|(a, b)| outside_bank_junction(a, b, node))
            .collect();
        second = second
            .into_iter()
            .flat_map(|(a, b)| outside_bank_junction(a, b, node))
            .collect();
    }
    first.iter().any(|&(a, b)| {
        second
            .iter()
            .any(|&(c, d)| river_bank_gap(a, b, c, d) < margin)
    })
}

#[allow(clippy::too_many_arguments)]
fn first_curves_bank_contact(
    a: &[RiverPoint],
    b: &[RiverPoint],
    cell: f32,
    junctions: &[BankJunction],
    lakes: &[u32],
    n: usize,
    course_gap: Option<(bool, f32)>,
    context: &BankPairContext,
) -> Option<(usize, usize)> {
    let mut index = RiverGeometryIndex::new(cell, 2);
    // Candidate geometry prefers a visible bank berm. Export additionally
    // accepts narrow positive corridors inherited from authoritative drainage.
    index.bank_margin = 0.0;
    index.bank_same_course = course_gap.is_some();
    let length = |curve: &[RiverPoint]| {
        curve
            .windows(2)
            .map(|p| point_distance(p[0], p[1]))
            .sum::<f32>()
    };
    let mut arc = match course_gap {
        Some((true, gap)) => {
            index.arc_base = length(a) + gap;
            Some(0.0)
        }
        Some((false, gap)) => Some(length(b) + gap),
        None => Some(0.0),
    };
    index.configure_lakes(lakes, n);
    for &node in junctions {
        let extended_a = connected_bank_extension(a, context.a, node, context);
        let extended_b = connected_bank_extension(b, context.b, node, context);
        if let (Some(first), Some(second)) = (
            terminal_contact_range(a, extended_b.as_deref().unwrap_or(b), node),
            terminal_contact_range(b, extended_a.as_deref().unwrap_or(a), node),
        ) {
            index.terminal_contacts.push((first, second));
        }
    }
    index.insert(1, b);
    for (id, pair) in a.windows(2).enumerate() {
        if let Some((_, station)) = index.first_conflict_at(pair[0], pair[1], 0, arc) {
            return Some((id, station));
        }
        if let Some(value) = &mut arc {
            *value += point_distance(pair[0], pair[1]);
        }
    }
    None
}

struct BankPairContext<'a> {
    a: usize,
    b: usize,
    edges: &'a [River],
    course_at: &'a [u32],
    curves: &'a [Vec<RiverPoint>],
    next: &'a HashMap<u32, usize>,
}

fn connected_bank_extension(
    curve: &[RiverPoint],
    id: usize,
    node: BankJunction,
    context: &BankPairContext,
) -> Option<Vec<RiverPoint>> {
    let distance = |p: RiverPoint| (p.x - node.x).hypot(p.y - node.y);
    let start = distance(curve[0]);
    let end = distance(*curve.last().unwrap());
    if start.min(end) < 0.01 || start.min(end) > node.radius {
        return None;
    }
    let downstream = end < start;
    let mut current = id;
    let mut parts = Vec::new();
    let mut length = 0.0;
    for _ in 0..context.edges.len() {
        let next = if downstream {
            context.next.get(&context.edges[current].to).copied()
        } else {
            context.edges.iter().enumerate().find_map(|(i, edge)| {
                (edge.to == context.edges[current].from
                    && context.course_at[i] == context.course_at[id])
                    .then_some(i)
            })
        }?;
        if context.course_at[next] != context.course_at[id] {
            return None;
        }
        let part = &context.curves[next];
        length += part
            .windows(2)
            .map(|p| point_distance(p[0], p[1]))
            .sum::<f32>();
        if length > node.radius * 2.0 {
            return None;
        }
        parts.push(part);
        let endpoint = if downstream {
            *part.last().unwrap()
        } else {
            part[0]
        };
        if distance(endpoint) < 0.01 {
            let mut extended = Vec::new();
            if downstream {
                extended.extend_from_slice(curve);
                for part in parts {
                    extended.extend_from_slice(&part[1..]);
                }
            } else {
                for part in parts.into_iter().rev() {
                    extended.extend_from_slice(&part[..part.len() - 1]);
                }
                extended.extend_from_slice(curve);
            }
            return Some(extended);
        }
        current = next;
    }
    None
}

fn terminal_contact_range(
    curve: &[RiverPoint],
    other: &[RiverPoint],
    node: BankJunction,
) -> Option<[f32; 2]> {
    let distance = |p: RiverPoint| (p.x - node.x).hypot(p.y - node.y);
    let start = distance(curve[0]);
    let end = distance(*curve.last().unwrap());
    if start.min(end) > node.radius {
        return None;
    }
    // A neighbouring host partition can end just before the true node.
    // Its bank contact is legitimate only when attached to that nearby end;
    // reaching the same circle somewhere inside a bend grants no permission.
    let reverse = end < start;
    let point_at = |i: usize| curve[if reverse { curve.len() - 1 - i } else { i }];
    let pad = node.radius + other.iter().map(|p| p.width).fold(0.0_f32, f32::max);
    let nearby: Vec<_> = other
        .windows(2)
        .filter(|p| {
            p[0].x.min(p[1].x) <= node.x + pad
                && p[0].x.max(p[1].x) >= node.x - pad
                && p[0].y.min(p[1].y) <= node.y + pad
                && p[0].y.max(p[1].y) >= node.y - pad
        })
        .collect();
    let touching = |p: RiverPoint| {
        (p.x - node.x).hypot(p.y - node.y) <= node.radius
            && nearby
                .iter()
                .any(|segment| river_bank_gap(p, p, segment[0], segment[1]) < 0.0)
    };
    let mut station = 0.0;
    if !touching(point_at(0)) {
        let total = curve
            .windows(2)
            .map(|p| point_distance(p[0], p[1]))
            .sum::<f32>();
        return Some(if reverse { [total, total] } else { [0.0, 0.0] });
    }
    'prefix: for k in 0..curve.len() - 1 {
        let a = point_at(k);
        let b = point_at(k + 1);
        let length = point_distance(a, b);
        let step = (a.width.min(b.width) * 0.05).clamp(0.05, 0.25);
        let samples = (length / step).ceil().max(1.0) as usize;
        for sample in 1..=samples {
            let mut right = sample as f32 / samples as f32;
            if !touching(river_point_lerp(a, b, right)) {
                let mut left = (sample - 1) as f32 / samples as f32;
                for _ in 0..8 {
                    let middle = (left + right) * 0.5;
                    if touching(river_point_lerp(a, b, middle)) {
                        left = middle;
                    } else {
                        right = middle;
                    }
                }
                station += length * left;
                break 'prefix;
            }
        }
        station += length;
    }
    let total = curve
        .windows(2)
        .map(|p| point_distance(p[0], p[1]))
        .sum::<f32>();
    Some(if reverse {
        [total - station - 0.001, total]
    } else {
        [0.0, station + 0.001]
    })
}

fn river_segments_intersect(a: RiverPoint, b: RiverPoint, c: RiverPoint, d: RiverPoint) -> bool {
    if a.x.max(b.x) + 0.001 < c.x.min(d.x)
        || c.x.max(d.x) + 0.001 < a.x.min(b.x)
        || a.y.max(b.y) + 0.001 < c.y.min(d.y)
        || c.y.max(d.y) + 0.001 < a.y.min(b.y)
    {
        return false;
    }
    if point_distance(a, b) > 0.001
        && ((point_distance(a, c) < 0.001 && point_distance(b, d) < 0.001)
            || (point_distance(a, d) < 0.001 && point_distance(b, c) < 0.001))
    {
        return true;
    }
    let side = |a: RiverPoint, b: RiverPoint, p: RiverPoint| {
        (b.x as f64 - a.x as f64) * (p.y as f64 - a.y as f64)
            - (b.y as f64 - a.y as f64) * (p.x as f64 - a.x as f64)
    };
    if side(a, b, c) * side(a, b, d) < 0.0 && side(c, d, a) * side(c, d, b) < 0.0 {
        return true;
    }
    let on_segment = |p: RiverPoint, a: RiverPoint, b: RiverPoint| {
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy).max(0.0001))
            .clamp(0.0, 1.0);
        (p.x - a.x - dx * t).hypot(p.y - a.y - dy * t) < 0.001
    };
    // An interior touch is also a false connection. Common endpoints remain
    // valid, while a collinear overlap has an endpoint inside the other axis.
    [(a, c, d), (b, c, d), (c, a, b), (d, a, b)]
        .into_iter()
        .any(|(p, x, y)| {
            point_distance(p, x) >= 0.001 && point_distance(p, y) >= 0.001 && on_segment(p, x, y)
        })
}

struct RiverPatchContext<'a> {
    ground: &'a [f32],
    lakes: &'a [u32],
    sea: &'a [bool],
    n: usize,
    cell: f32,
    cfg: &'a HydrologyConfig,
}

fn patch_span_admissible(
    a: RiverPoint,
    b: RiverPoint,
    guide_a: RiverPoint,
    guide_b: RiverPoint,
    context: &RiverPatchContext,
) -> bool {
    let width = context.cell * context.n as f32;
    if [a, b]
        .iter()
        .any(|p| p.x < 0.0 || p.y < 0.0 || p.x > width || p.y > width)
    {
        return false;
    }
    // Cover both bilinear pieces and raster water boundaries of the actual
    // segment and its guide, using the same knots as the physical profile fit.
    let mut splits = profile_knots(a, b, context.cell, context.cfg);
    splits.extend(profile_knots(guide_a, guide_b, context.cell, context.cfg));
    splits.sort_unstable_by(f32::total_cmp);
    splits.dedup();
    let cell_at = |p: RiverPoint| {
        let x = (p.x / context.cell)
            .floor()
            .clamp(0.0, context.n as f32 - 1.0) as usize;
        let y = (p.y / context.cell)
            .floor()
            .clamp(0.0, context.n as f32 - 1.0) as usize;
        y * context.n + x
    };
    let excess = |t: f32| {
        let p = river_point_lerp(a, b, t);
        sample(context.ground, context.n, context.cell, p.x, p.y)
            - p.z
            - channel_bank_clearance(p.width, context.cfg)
    };
    for range in splits.windows(2) {
        let middle = (range[0] + range[1]) * 0.5;
        let actual = cell_at(river_point_lerp(a, b, middle));
        let guide = cell_at(river_point_lerp(guide_a, guide_b, middle));
        if context.lakes[actual] != context.lakes[guide]
            || context.sea[actual] != context.sea[guide]
        {
            return false;
        }
        // Ground minus the linear water/profile allowance is quadratic inside
        // each bilinear piece. Check its exact interior maximum as well as ends.
        let first = excess(range[0]) as f64;
        let last = excess(range[1]) as f64;
        let midpoint = excess(middle) as f64;
        if first.max(last) > 0.001 {
            return false;
        }
        let quadratic = 2.0 * (first + last - 2.0 * midpoint);
        let linear = last - first - quadratic;
        if quadratic < -0.000001 {
            let t = -linear / (2.0 * quadratic);
            if t > 0.0 && t < 1.0 && quadratic * t * t + linear * t + first > 0.001 {
                return false;
            }
        }
    }
    true
}

fn drainage_patch(
    curve: &[RiverPoint],
    reference: &[RiverPoint],
    segment: usize,
    reach: f32,
    context: &RiverPatchContext,
) -> (Vec<RiverPoint>, bool) {
    let target = RiverPoint {
        x: (curve[segment].x + curve[segment + 1].x) * 0.5,
        y: (curve[segment].y + curve[segment + 1].y) * 0.5,
        ..curve[segment]
    };
    let nearest = reference
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| {
            point_distance(**a, target).total_cmp(&point_distance(**b, target))
        })
        .map(|(i, _)| i)
        .unwrap_or(0);
    let mut start = nearest;
    let mut end = nearest;
    let mut distance = 0.0;
    while start > 0 && distance < reach {
        distance += point_distance(reference[start], reference[start - 1]);
        start -= 1;
    }
    distance = 0.0;
    while end + 1 < reference.len() && distance < reach {
        distance += point_distance(reference[end], reference[end + 1]);
        end += 1;
    }
    // Anchor the repair upstream and downstream of the actual intersection.
    // Nearest reference stations may lie on another limb of a tight meander;
    // restricting the two searches to opposite sides preserves flow direction.
    let before = if start == 0 {
        0
    } else {
        (0..=segment)
            .min_by(|&a, &b| {
                point_distance(curve[a], reference[start])
                    .total_cmp(&point_distance(curve[b], reference[start]))
            })
            .unwrap()
    };
    let after = if end + 1 == reference.len() {
        curve.len() - 1
    } else {
        (segment + 1..curve.len())
            .min_by(|&a, &b| {
                point_distance(curve[a], reference[end])
                    .total_cmp(&point_distance(curve[b], reference[end]))
            })
            .unwrap()
    };
    let a = curve[before];
    let b = curve[after];
    let mut stations = vec![0.0; end - start + 1];
    for k in 1..stations.len() {
        stations[k] =
            stations[k - 1] + point_distance(reference[start + k - 1], reference[start + k]);
    }
    let length = *stations.last().unwrap();
    let mut patch = curve[..before].to_vec();
    let mut admissible = true;
    for (k, &s) in stations.iter().enumerate() {
        let t = (s / length.max(0.001)).clamp(0.0, 1.0);
        let mut p = reference[start + k];
        // Smoothly return to the existing curve at the window boundaries. The
        // centre follows the drainage, rather than an invented new connection.
        let upstream = (1.0 - t * 3.0).max(0.0).powi(2);
        let downstream = (t * 3.0 - 2.0).max(0.0).powi(2);
        p.x += (a.x - reference[start].x) * upstream + (b.x - reference[end].x) * downstream;
        p.y += (a.y - reference[start].y) * upstream + (b.y - reference[end].y) * downstream;
        p.z = p.z.max(b.z).min(a.z);
        p.width = a.width + (b.width - a.width) * t;
        if k == 0 {
            p = a;
        }
        if k + 1 == stations.len() {
            p = b;
        }
        if let Some(previous) = patch.last() {
            p.z = p.z.min(previous.z);
        }
        if k > 0 {
            admissible &= patch_span_admissible(
                *patch.last().unwrap(),
                p,
                reference[start + k - 1],
                reference[start + k],
                context,
            );
        }
        patch.push(p);
    }
    patch.extend_from_slice(&curve[after + 1..]);
    (patch, admissible)
}

fn river_network_pairs(
    curves: &[Vec<RiverPoint>],
    references: Option<&[Vec<RiverPoint>]>,
    cell: f32,
) -> Vec<(usize, usize)> {
    // Compaction can cross an unrelated nearby course, too. Query spatial
    // neighbours rather than limiting checks to branches of the same junction.
    let mut bins: HashMap<(isize, isize), Vec<usize>> = HashMap::new();
    let mut pairs = HashSet::new();
    for (id, curve) in curves.iter().enumerate() {
        // Include the fallback corridor: local repairs must also be checked
        // against nearby courses that did not overlap the deformed bounds.
        let reference = references.map_or(&[][..], |r| r[id].as_slice());
        for segment in curve.windows(2).chain(reference.windows(2)) {
            let (a, b) = (segment[0], segment[1]);
            let pad = a.width.max(b.width) * 0.65 + 1.0;
            for y in ((a.y.min(b.y) - pad) / cell).floor() as isize
                ..=((a.y.max(b.y) + pad) / cell).floor() as isize
            {
                for x in ((a.x.min(b.x) - pad) / cell).floor() as isize
                    ..=((a.x.max(b.x) + pad) / cell).floor() as isize
                {
                    let nearby = bins.entry((x, y)).or_default();
                    for &other in nearby.iter() {
                        if other != id {
                            pairs.insert((other, id));
                        }
                    }
                    if nearby.last() != Some(&id) {
                        nearby.push(id);
                    }
                }
            }
        }
    }
    let mut pairs: Vec<_> = pairs.into_iter().collect();
    pairs.sort_unstable();
    pairs
}

#[allow(clippy::too_many_arguments)]
fn compact_network(
    curves: &[Vec<RiverPoint>],
    references: &[Vec<RiverPoint>],
    edges: &[River],
    effective: &[f32],
    n: usize,
    cell: f32,
    cfg: &HydrologyConfig,
    lakes: &[u32],
    course_at: &[u32],
    ground: &[f32],
    sea: &[bool],
) -> Result<Vec<Vec<RiverPoint>>, String> {
    let mut result: Vec<_> = curves.iter().map(|p| compact_course(p, cell)).collect();
    let owners: Vec<u32> = (0..edges.len() as u32).collect();
    let mut junctions = RiverGeometryIndex::new(cell, edges.len());
    junctions.configure_junctions(edges, &owners, effective, n, cfg, Some(curves));
    let mut course_junctions = RiverGeometryIndex::new(cell, edges.len());
    course_junctions.configure_junctions(edges, course_at, effective, n, cfg, Some(curves));
    let course_next: HashMap<_, _> = edges
        .iter()
        .enumerate()
        .map(|(id, edge)| (edge.from, id))
        .collect();
    let patch_context = RiverPatchContext {
        ground,
        lakes,
        sea,
        n,
        cell,
        cfg,
    };
    for (id, curve) in result.iter_mut().enumerate() {
        fit_compact_profile(curve, &curves[id], &patch_context)?;
    }
    for _ in 0..8 {
        let mut changed = false;
        let pairs = river_network_pairs(&result, Some(references), cell);
        for &(a, b) in &pairs {
            let shared = if course_at[a] == course_at[b] {
                junctions.junctions.get(&(a as u32, b as u32))
            } else {
                course_junctions.junctions.get(&(
                    course_at[a].min(course_at[b]),
                    course_at[a].max(course_at[b]),
                ))
            }
            .map_or(&[][..], Vec::as_slice);
            for _ in 0..8 {
                let course_gap = river_course_gap(a, b, edges, course_at, &course_next, &result);
                let context = BankPairContext {
                    a,
                    b,
                    edges,
                    course_at,
                    curves: &result,
                    next: &course_next,
                };
                let Some((ai, bi)) = first_curves_bank_contact(
                    &result[a], &result[b], cell, shared, lakes, n, course_gap, &context,
                ) else {
                    break;
                };
                let refined_a = refine_shortcut(&mut result[a], &curves[a], ai);
                let refined_b = refine_shortcut(&mut result[b], &curves[b], bi);
                if refined_a || refined_b {
                    changed = true;
                    continue;
                }
                // A detailed curve can already cross a neighbour near a junction.
                // Repair the offending span only, growing its physical window until
                // the reference corridor and its transitions are both unambiguous.
                let mut repaired = false;
                for attempt in 0..10 {
                    let context = BankPairContext {
                        a,
                        b,
                        edges,
                        course_at,
                        curves: &result,
                        next: &course_next,
                    };
                    let reach = cell * 2.0f32.powi(attempt + 1);
                    let (candidate_a, terrain_a) =
                        drainage_patch(&result[a], &references[a], ai, reach, &patch_context);
                    let (candidate_b, terrain_b) =
                        drainage_patch(&result[b], &references[b], bi, reach, &patch_context);
                    let valid_a = terrain_a && !course_crosses(&candidate_a, cell);
                    let valid_b = terrain_b && !course_crosses(&candidate_b, cell);
                    let prefer_a = result[a][ai].width < result[b][bi].width;
                    if valid_a
                        && first_curves_bank_contact(
                            &candidate_a,
                            &result[b],
                            cell,
                            shared,
                            lakes,
                            n,
                            course_gap,
                            &context,
                        )
                        .is_none()
                        && (prefer_a
                            || !(valid_b
                                && first_curves_bank_contact(
                                    &result[a],
                                    &candidate_b,
                                    cell,
                                    shared,
                                    lakes,
                                    n,
                                    course_gap,
                                    &context,
                                )
                                .is_none()))
                    {
                        result[a] = candidate_a;
                        repaired = true;
                    } else if valid_b
                        && first_curves_bank_contact(
                            &result[a],
                            &candidate_b,
                            cell,
                            shared,
                            lakes,
                            n,
                            course_gap,
                            &context,
                        )
                        .is_none()
                    {
                        result[b] = candidate_b;
                        repaired = true;
                    } else if valid_a
                        && valid_b
                        && first_curves_bank_contact(
                            &candidate_a,
                            &candidate_b,
                            cell,
                            shared,
                            lakes,
                            n,
                            course_gap,
                            &context,
                        )
                        .is_none()
                    {
                        result[a] = candidate_a;
                        result[b] = candidate_b;
                        repaired = true;
                    }
                    if repaired {
                        break;
                    }
                }
                if !repaired {
                    break;
                }
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    // Repairs can move outside their original spatial bins. Check the actual
    // retained network after the bounded work, never export an unresolved X.
    for (id, curve) in result.iter_mut().enumerate() {
        fit_compact_profile(curve, &curves[id], &patch_context)?;
    }
    for (id, curve) in result.iter().enumerate() {
        if course_crosses(curve, cell) {
            return Err(format!(
                "river vector clearance: self-intersection on river {id}"
            ));
        }
    }
    for (a, b) in river_network_pairs(&result, None, cell) {
        let shared = if course_at[a] == course_at[b] {
            junctions.junctions.get(&(a as u32, b as u32))
        } else {
            course_junctions.junctions.get(&(
                course_at[a].min(course_at[b]),
                course_at[a].max(course_at[b]),
            ))
        }
        .map_or(&[][..], Vec::as_slice);
        let course_gap = river_course_gap(a, b, edges, course_at, &course_next, &result);
        let context = BankPairContext {
            a,
            b,
            edges,
            course_at,
            curves: &result,
            next: &course_next,
        };
        if first_curves_bank_contact(
            &result[a], &result[b], cell, shared, lakes, n, course_gap, &context,
        )
        .is_some()
        {
            return Err(format!(
                "river vector clearance: unresolved axis or bank contact between rivers {a} and {b}"
            ));
        }
    }
    Ok(result)
}

fn river_course_gap(
    a: usize,
    b: usize,
    edges: &[River],
    course_at: &[u32],
    next: &HashMap<u32, usize>,
    curves: &[Vec<RiverPoint>],
) -> Option<(bool, f32)> {
    for (first, last, forward) in [(a, b, true), (b, a, false)] {
        let mut node = edges[first].to;
        let mut gap = 0.0;
        let mut connected = course_at[a] == course_at[b];
        for _ in 0..edges.len() {
            if node == edges[last].from {
                return connected.then_some((forward, gap));
            }
            let Some(&id) = next.get(&node) else {
                break;
            };
            // A one-cell lake inlet/outlet partitions an otherwise continuous
            // watercourse into different owners. Keep the same local arc test
            // across that retained connector, not across separate tributaries.
            connected |= edges[id].flags & 24 != 0 && edges[id].cells.len() <= 2;
            gap += curves[id]
                .windows(2)
                .map(|p| point_distance(p[0], p[1]))
                .sum::<f32>();
            node = edges[id].to;
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn join_confluences(
    curves: &mut [Vec<RiverPoint>],
    edges: &[River],
    dominant: &[Option<usize>],
    edge_from_node: &HashMap<u32, u32>,
    course_at: &[u32],
    occupied: &mut [u32],
    node_meta: &[u32],
    ground: &[f32],
    valley: &[f32],
    n: usize,
    cell: f32,
    width: f32,
    lakes: &[u32],
    sea: &[bool],
    distance: &[f32],
    effective: &[f32],
    cfg: &HydrologyConfig,
) -> Result<(), String> {
    let owners: Vec<u32> = (0..edges.len() as u32).collect();
    let mut bank_index = RiverGeometryIndex::new(cell, edges.len());
    bank_index.configure_junctions(edges, &owners, effective, n, cfg, Some(curves));
    bank_index.configure_lakes(lakes, n);
    for (id, curve) in curves.iter().enumerate() {
        bank_index.insert(id as u32, curve);
    }
    let mut incoming_at: HashMap<u32, Vec<usize>> = HashMap::new();
    for (id, edge) in edges.iter().enumerate() {
        incoming_at.entry(edge.to).or_default().push(id);
    }
    let mut order: Vec<usize> = (0..edges.len()).collect();
    // Hosts have their final downstream join before their own tributaries are adapted.
    order.sort_unstable_by(|&a, &b| {
        distance[edges[a].cells[0]].total_cmp(&distance[edges[b].cells[0]])
    });
    for id in order {
        let edge = &edges[id];
        if node_meta[edge.to as usize * 3 + 2] != 1 {
            continue;
        }
        let Some(&next) = edge_from_node.get(&edge.to) else {
            continue;
        };
        let host = next as usize - 1;
        if dominant[host] == Some(id) || curves[id].len() < 2 || curves[host].len() < 2 {
            continue;
        }
        let target = curves[host][0];
        let last = *curves[id].last().unwrap();
        let total: f32 = curves[id]
            .windows(2)
            .map(|p| point_distance(p[0], p[1]))
            .sum();
        let base_reach = (last.width * 4.0)
            .max(target.width * 1.5)
            .max(cell * 1.3)
            .min(width * 0.015)
            .min(total * 0.25);
        let mut best: Option<(usize, Vec<RiverPoint>, f32)> = None;
        'join: {
            // One local approach belongs to this shared node. Extending the
            // terminal tail repeatedly cannot repair a wrong drainage topology.
            let reach = base_reach;
            let mut along = 0.0;
            let mut start = curves[id].len() - 1;
            while start > 0 && along < reach {
                along += point_distance(curves[id][start], curves[id][start - 1]);
                start -= 1;
            }
            let a = curves[id][start];
            let chord = normalized(target.x - a.x, target.y - a.y);
            let mut host_point = curves[host][1];
            let mut host_along = 0.0;
            for pair in curves[host].windows(2) {
                host_along += point_distance(pair[0], pair[1]);
                host_point = pair[1];
                if host_along >= (target.width * 1.5).max(cell * 0.5) {
                    break;
                }
            }
            let host_direction = normalized(host_point.x - target.x, host_point.y - target.y);
            if chord.0 * host_direction.0 + chord.1 * host_direction.1 < -0.1 {
                break 'join; // A short tributary must not acquire a forced U-turn.
            }
            // End tangent points downstream. A small approach component retains an acute
            // branch angle instead of drawing a round, perpendicular terminal blob.
            let mut end_direction = normalized(
                host_direction.0 * 0.85 + chord.0 * 0.15,
                host_direction.1 * 0.85 + chord.1 * 0.15,
            );
            if chord.0 * end_direction.0 + chord.1 * end_direction.1 < 0.15 {
                end_direction = normalized(
                    host_direction.0 * 0.45 + chord.0 * 0.55,
                    host_direction.1 * 0.45 + chord.1 * 0.55,
                );
            }
            let before = curves[id][start.saturating_sub(2)];
            let mut start_direction = normalized(a.x - before.x, a.y - before.y);
            if start == 0 {
                start_direction = chord;
            }
            let chord_length = point_distance(a, target);
            let handle = (along * 0.34).min(chord_length * 0.55).max(cell * 0.2);
            let p1 = (
                a.x + start_direction.0 * handle,
                a.y + start_direction.1 * handle,
            );
            let p2 = (
                target.x - end_direction.0 * handle,
                target.y - end_direction.1 * handle,
            );
            let step = (last.width * 0.45).max(1.0).min(cell * 0.35);
            let steps = ((along + point_distance(last, target)) / step)
                .ceil()
                .clamp(6.0, 512.0) as usize;
            let end_width = (last.width * 1.2).min(target.width * 0.75).max(last.width);
            let mut tail = Vec::with_capacity(steps);
            for k in 1..=steps {
                let t = k as f32 / steps as f32;
                let u = 1.0 - t;
                let blend = t * t * (3.0 - 2.0 * t);
                tail.push(RiverPoint {
                    x: (u.powi(3) * a.x
                        + 3.0 * u * u * t * p1.0
                        + 3.0 * u * t * t * p2.0
                        + t.powi(3) * target.x)
                        .clamp(0.0, width),
                    y: (u.powi(3) * a.y
                        + 3.0 * u * u * t * p1.1
                        + 3.0 * u * t * t * p2.1
                        + t.powi(3) * target.y)
                        .clamp(0.0, width),
                    width: a.width + (end_width - a.width) * blend,
                    z: a.z + (target.z - a.z) * t,
                });
            }
            if (a.z - target.z) / along.max(1.0) > 0.002 {
                let mut previous = a.z;
                for p in &mut tail {
                    p.z = sample(ground, n, cell, p.x, p.y)
                        .max(target.z)
                        .min(a.z)
                        .min(previous);
                    previous = p.z;
                }
                tail.last_mut().unwrap().z = target.z;
            }
            let valley_ceiling = curves[id][start..]
                .iter()
                .map(|p| sample(valley, n, cell, p.x, p.y))
                .fold(f32::NEG_INFINITY, f32::max)
                .max(sample(valley, n, cell, target.x, target.y));
            let allowed = |p: RiverPoint| {
                let x = (p.x / cell).floor().clamp(0.0, (n - 1) as f32) as usize;
                let y = (p.y / cell).floor().clamp(0.0, (n - 1) as f32) as usize;
                let i = y * n + x;
                !sea[i]
                    && lakes[i] == 0
                    && sample(ground, n, cell, p.x, p.y) <= p.z + p.width * 0.08 + 0.3
                    && sample(valley, n, cell, p.x, p.y)
                        <= valley_ceiling.max(p.z) + p.width * 0.12 + 0.3
                    && (occupied[i] == OUT
                        || occupied[i] == OUT - 1
                        || occupied[i] == course_at[id]
                        || (occupied[i] == course_at[host]
                            && point_distance(p, target) <= target.width * 1.5 + cell))
            };
            let valid_tail = |tail: &[RiverPoint]| {
                let mut previous = a;
                let valid = tail.iter().all(|&p| {
                    let steps =
                        (point_distance(previous, p) / (cell * 0.6)).ceil().max(1.0) as usize;
                    let valid = previous.z + 0.001 >= p.z
                        && bank_index.clear(previous, p, id as u32)
                        && (0..=steps).all(|k| {
                            let t = k as f32 / steps as f32;
                            allowed(RiverPoint {
                                x: previous.x + (p.x - previous.x) * t,
                                y: previous.y + (p.y - previous.y) * t,
                                width: previous.width + (p.width - previous.width) * t,
                                z: previous.z + (p.z - previous.z) * t,
                            })
                        });
                    previous = p;
                    valid
                });
                let approach: Vec<_> = std::iter::once(a).chain(tail.iter().copied()).collect();
                valid
                    && !course_crosses(
                        &curves[id][..=start]
                            .iter()
                            .chain(tail.iter())
                            .copied()
                            .collect::<Vec<_>>(),
                        cell,
                    )
                    && !curves_cross(&approach, &curves[host], cell)
                    && incoming_at[&edge.to].iter().all(|&sibling| {
                        sibling == id || !curves_cross(&approach, &curves[sibling], cell)
                    })
            };
            let no_loops = tail
                .windows(2)
                .all(|p| (p[1].x - p[0].x) * chord.0 + (p[1].y - p[0].y) * chord.1 >= -cell * 0.05);
            if no_loops && valid_tail(&tail) {
                let radius = cubic_radius_ratio(a, target, p1, p2, end_width);
                if radius >= 1.5 {
                    best = Some((start, tail, radius));
                }
            }
        }
        if let Some((start, tail, _)) = best {
            curves[id].truncate(start + 1);
            curves[id].extend(tail);
            bank_index.replace(id as u32, &curves[id]);
        }
        occupy_curve(&curves[id], occupied, course_at[id], n, cell);
    }
    Ok(())
}

fn cubic_radius_ratio(
    a: RiverPoint,
    b: RiverPoint,
    p1: (f32, f32),
    p2: (f32, f32),
    end_width: f32,
) -> f32 {
    (0..=24)
        .map(|k| {
            let t = k as f32 / 24.0;
            let u = 1.0 - t;
            let dx =
                3.0 * (u * u * (p1.0 - a.x) + 2.0 * u * t * (p2.0 - p1.0) + t * t * (b.x - p2.0));
            let dy =
                3.0 * (u * u * (p1.1 - a.y) + 2.0 * u * t * (p2.1 - p1.1) + t * t * (b.y - p2.1));
            let ddx = 6.0 * (u * (p2.0 - 2.0 * p1.0 + a.x) + t * (b.x - 2.0 * p2.0 + p1.0));
            let ddy = 6.0 * (u * (p2.1 - 2.0 * p1.1 + a.y) + t * (b.y - 2.0 * p2.1 + p1.1));
            let radius = dx.hypot(dy).powi(3) / (dx * ddy - dy * ddx).abs().max(0.0001);
            let width = a.width + (end_width - a.width) * t * t * (3.0 - 2.0 * t);
            radius / width.max(0.01)
        })
        .fold(f32::INFINITY, f32::min)
}

fn normalized(x: f32, y: f32) -> (f32, f32) {
    let length = x.hypot(y).max(0.001);
    (x / length, y / length)
}

fn choose_estuary(
    cfg: &HydrologyConfig,
    h: &[f32],
    n: usize,
    cell: f32,
    cells: &[usize],
    seed: &str,
) -> u32 {
    match cfg.estuary.as_str() {
        "simple" => 1,
        "widening" => 2,
        "funnel" => 3,
        "tidal" => 4,
        _ => {
            let end = cells.len() - 1;
            let start = end.saturating_sub(6);
            let a = point(cells[start], n, cell);
            let b = point(cells[end], n, cell);
            let slope =
                (h[cells[start]] - h[cells[end]]).max(0.0) / (a.0 - b.0).hypot(a.1 - b.1).max(cell);
            if slope > 0.09 {
                1
            } else if slope > 0.025 {
                2
            } else {
                let mut rng = Rng::new(seed).fork(&format!("hydrology-mouth-{}", cells[end]));
                if rng.float() < 0.35 { 4 } else { 3 }
            }
        }
    }
}
fn widen_mouth(points: &mut [RiverPoint], kind: u32, map_width: f32) {
    if points.len() < 2 {
        return;
    }
    let base = points.last().unwrap().width;
    let reach = (base * 15.0).max(map_width * 0.008).min(map_width * 0.05);
    let factor = match kind {
        2 => 1.8,
        3 => 3.6,
        4 => 2.6,
        _ => 1.05,
    };
    let mut along = 0.0;
    for k in (0..points.len()).rev() {
        if k + 1 < points.len() {
            along += (points[k + 1].x - points[k].x).hypot(points[k + 1].y - points[k].y);
        }
        let t = (1.0 - along / reach).clamp(0.0, 1.0);
        let smooth = t * t * (3.0 - 2.0 * t);
        points[k].width *= 1.0 + (factor - 1.0) * smooth;
    }
}

fn carve_bed(
    points: &[RiverPoint],
    base_height: &[f32],
    height: &mut [f32],
    n: usize,
    cell: f32,
    incision: f32,
    estuary: u32,
) {
    if incision == 0.0 {
        return;
    }
    for pair in points.windows(2) {
        let a = pair[0];
        let b = pair[1];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let l2 = dx * dx + dy * dy;
        let radius = (a.width.max(b.width) * 0.65).max(0.5);
        let xmin = ((a.x.min(b.x) - radius) / cell - 0.5).floor().max(0.0) as usize;
        let xmax = ((a.x.max(b.x) + radius) / cell - 0.5)
            .ceil()
            .clamp(0.0, (n - 1) as f32) as usize;
        let ymin = ((a.y.min(b.y) - radius) / cell - 0.5).floor().max(0.0) as usize;
        let ymax = ((a.y.max(b.y) + radius) / cell - 0.5)
            .ceil()
            .clamp(0.0, (n - 1) as f32) as usize;
        for y in ymin..=ymax {
            let py = (y as f32 + 0.5) * cell;
            let (row_min, row_max) = if dy.abs() > 0.00001 {
                let center = a.x + dx * (py - a.y) / dy;
                let spread = radius * l2.sqrt() / dy.abs();
                let lo = ((center - spread) / cell - 0.5).floor().max(xmin as f32);
                let hi = ((center + spread) / cell - 0.5).ceil().min(xmax as f32);
                if lo > hi {
                    continue;
                }
                (lo as usize, hi as usize)
            } else {
                (xmin, xmax)
            };
            for x in row_min..=row_max {
                let px = (x as f32 + 0.5) * cell;
                let t = (((px - a.x) * dx + (py - a.y) * dy) / l2.max(0.001)).clamp(0.0, 1.0);
                let distance = (px - a.x - dx * t).hypot(py - a.y - dy * t);
                let width = a.width + (b.width - a.width) * t;
                let bank_radius = (width * 0.65).max(0.5);
                let blend = (1.0 - distance / bank_radius).clamp(0.0, 1.0).powi(2);
                if blend == 0.0 {
                    continue;
                }
                let water = a.z + (b.z - a.z) * t;
                let depth = (width * 0.11).clamp(0.35, 12.0) * incision;
                let i = y * n + x;
                let cut = (base_height[i] - (water - depth))
                    .max(0.0)
                    .min(depth * 2.0 + 0.75);
                // Embouchures touch only a bounded local strip; no coast-wide bay carving.
                let coastal = if estuary > 1 && water < depth {
                    1.15
                } else {
                    1.0
                };
                height[i] = height[i].min(base_height[i] - cut * blend * coastal);
            }
        }
    }
}
