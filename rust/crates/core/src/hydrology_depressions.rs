//! Bounded hybrid treatment of rejected depressions. The upstream terrain is untouched.
//! A local notch may lower a spill; the caller recomputes F and fills the remainder.
//! This is a conservative procedural policy, not an exhaustive least-cost breaching solver.
use super::{OUT, neighbor};
use std::cmp::Ordering;
use std::collections::BinaryHeap;

pub(super) struct Options<'a> {
    pub mode: &'a str,
    pub max_depth_m: f32,
    pub max_length_m: f32,
}

#[derive(Default)]
pub(super) struct Stats {
    pub breach_count: u32,
    pub breach_cut_volume_m3: f64,
    pub avoided_fill_volume_m3: f64,
}

pub(super) struct Plan {
    /// Allocated only after the first accepted cut. All modifications are reductions of H.
    pub physical: Option<Vec<f32>>,
    pub stats: Stats,
}

#[derive(Clone, Copy)]
struct Visit {
    cost: f64,
    length: f32,
    cell: usize,
}
impl PartialEq for Visit {
    fn eq(&self, other: &Self) -> bool {
        self.cost == other.cost && self.length == other.length && self.cell == other.cell
    }
}
impl Eq for Visit {}
impl PartialOrd for Visit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Visit {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .cost
            .total_cmp(&self.cost)
            .then_with(|| other.length.total_cmp(&self.length))
            .then_with(|| other.cell.cmp(&self.cell))
    }
}

/// One bounded multi-source search per rejected H < F body. A notch starts at the
/// connected low pocket containing its deepest cell, and ends at an existing F <=
/// target outlet. Equal-F components carrying a retained lake are wholly protected.
/// The caller must additionally verify every retained lake's F after recomputation.
pub(super) fn plan(
    height: &[f32],
    filled: &[f32],
    sea: &[bool],
    lakes: &[u32],
    n: usize,
    width: f32,
    options: &Options<'_>,
) -> Plan {
    let len = height.len();
    let mut plan = Plan {
        physical: None,
        stats: Stats::default(),
    };
    if options.mode != "auto" || options.max_depth_m <= 0.0 || options.max_length_m <= 0.0 {
        return plan;
    }
    let cell = width / n as f32;
    let area = f64::from(cell) * f64::from(cell);
    let has_sea = sea.iter().any(|&is_sea| is_sea);
    let mut groups = vec![OUT; len];
    let mut protected = Vec::new();
    let mut queue = Vec::new();
    for start in 0..len {
        if groups[start] != OUT {
            continue;
        }
        let id = protected.len() as u32;
        queue.clear();
        queue.push(start);
        groups[start] = id;
        let mut has_lake = false;
        let mut k = 0;
        while k < queue.len() {
            let i = queue[k];
            k += 1;
            has_lake |= lakes[i] != 0;
            for d in 0..8 {
                if let Some(j) = neighbor(i, d, n)
                    && groups[j] == OUT
                    && filled[j] == filled[start]
                {
                    groups[j] = id;
                    queue.push(j);
                }
            }
        }
        protected.push(has_lake);
    }
    let mut seen = vec![false; len];
    let mut pocket = vec![0_u32; len];
    let mut stamp = vec![0_u32; len];
    let mut cost = vec![0.0_f64; len];
    let mut length = vec![0.0_f32; len];
    let mut parent = vec![OUT; len];
    let mut heap = BinaryHeap::new();
    let mut epoch = 0_u32;
    // Early rejection keeps pathological finely sampled or numerous bowls bounded.
    let mut work_left = len.saturating_mul(4).max(65_536);
    for start in 0..len {
        if seen[start]
            || sea[start]
            || filled[start] - height[start] < 0.025
            || protected[groups[start] as usize]
        {
            continue;
        }
        let group = groups[start];
        let spill = filled[start];
        queue.clear();
        queue.push(start);
        seen[start] = true;
        let mut lowest = start;
        let mut k = 0;
        while k < queue.len() {
            let i = queue[k];
            k += 1;
            if height[i] < height[lowest] {
                lowest = i;
            }
            for d in 0..8 {
                if let Some(j) = neighbor(i, d, n)
                    && !seen[j]
                    && !sea[j]
                    && groups[j] == group
                    && filled[j] - height[j] >= 0.025
                {
                    seen[j] = true;
                    queue.push(j);
                }
            }
        }
        if work_left == 0 {
            continue;
        }
        // Spend at most half the cut-depth budget on lowering the spill, reserving
        // the remainder for nearby higher ground. Shallow bowls use their own floor.
        let target = height[lowest].max(spill - 0.5 * options.max_depth_m);
        // The coastal mask belongs to the prepared terrain. Opening negative
        // inland ground to the sea would require a separate coastal recomputation.
        if spill - target < 0.025 || (has_sea && target <= 0.0) {
            continue;
        }
        epoch += 1;
        queue.clear();
        queue.push(lowest);
        pocket[lowest] = epoch;
        let mut k = 0;
        while k < queue.len() {
            let i = queue[k];
            k += 1;
            for d in 0..8 {
                if let Some(j) = neighbor(i, d, n)
                    && pocket[j] != epoch
                    && groups[j] == group
                    && height[j] <= target
                    && !sea[j]
                {
                    pocket[j] = epoch;
                    queue.push(j);
                }
            }
        }
        // Every cell of this existing connected pocket can reach the new spill.
        // This lower bound does not assume that higher internal ridges also drain.
        let avoided = queue.len() as f64 * area * f64::from(spill - target);
        let current = plan.physical.as_deref().unwrap_or(height);
        heap.clear();
        for &i in &queue {
            if !(0..8).any(|d| neighbor(i, d, n).is_some_and(|j| pocket[j] != epoch)) {
                continue;
            }
            stamp[i] = epoch;
            cost[i] = 0.0;
            length[i] = 0.0;
            parent[i] = OUT;
            heap.push(Visit {
                cost: 0.0,
                length: 0.0,
                cell: i,
            });
        }
        let mut remaining = work_left.min(65_536);
        let mut exit = OUT;
        while let Some(visit) = heap.pop() {
            if remaining == 0 {
                break;
            }
            remaining -= 1;
            work_left -= 1;
            let i = visit.cell;
            if stamp[i] != epoch || visit.cost != cost[i] || visit.length != length[i] {
                continue;
            }
            if filled[i] <= target {
                exit = i as u32;
                break;
            }
            for d in 0..8 {
                let Some(j) = neighbor(i, d, n) else { continue };
                if pocket[j] == epoch || protected[groups[j] as usize] {
                    continue;
                }
                let step = if d.is_multiple_of(2) {
                    1.0
                } else {
                    std::f32::consts::SQRT_2
                };
                let next_length = visit.length + cell * step;
                let depth = (current[j] - target).max(0.0);
                // Overlapping notches share terrain, but cannot each spend the
                // full depth allowance again at the same cell.
                if next_length > options.max_length_m
                    || (height[j] - target).max(0.0) > options.max_depth_m
                {
                    continue;
                }
                // A small physical length penalty avoids wandering through already
                // low cells. The final acceptance uses the actual raster cut volume.
                let next_cost = visit.cost + f64::from((depth + 0.05) * step) * area;
                if stamp[j] == epoch
                    && (next_cost > cost[j] || (next_cost == cost[j] && next_length >= length[j]))
                {
                    continue;
                }
                stamp[j] = epoch;
                cost[j] = next_cost;
                length[j] = next_length;
                parent[j] = i as u32;
                heap.push(Visit {
                    cost: next_cost,
                    length: next_length,
                    cell: j,
                });
            }
        }
        if exit == OUT {
            continue;
        }
        let mut path = Vec::new();
        let mut i = exit;
        let mut volume = 0.0;
        while i != OUT {
            let index = i as usize;
            path.push(index);
            volume += area * f64::from((current[index] - target).max(0.0));
            i = parent[index];
        }
        if volume == 0.0 || volume > 0.1 * avoided {
            continue;
        }
        let physical = plan.physical.get_or_insert_with(|| height.to_vec());
        for i in path {
            physical[i] = physical[i].min(target);
        }
        plan.stats.breach_count += 1;
        plan.stats.breach_cut_volume_m3 += volume;
        plan.stats.avoided_fill_volume_m3 += avoided;
    }
    plan
}
