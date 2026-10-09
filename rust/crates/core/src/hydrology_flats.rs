//! Convergent metric drainage through exact equal-spill-level components.
//! Positive symmetric travel costs favour the basin's buried thalwegs without
//! modifying H or F. Settled order supplies a strict, diagnostic drainage rank.
use super::{Drainage, HeapCell, OUT, border, fill_cardinal, neighbor};
use std::cmp::Reverse;
use std::collections::BinaryHeap;

pub(super) struct Mask {
    pub labels: Vec<u32>,
    pub rank: Vec<u32>,
}

pub(super) fn resolve(
    filled: &[f32],
    physical: &[f32],
    sea: &[bool],
    n: usize,
    cell: f32,
    receivers: &mut [u32],
    bank_budget: f32,
) -> Result<Mask, String> {
    let len = filled.len();
    let mut labels = vec![OUT; len];
    let mut rank = vec![0; len];
    let mut distance = vec![f64::INFINITY; len];
    let mut travel_cost = vec![1.0_f32; len];
    let allowed = diagonal_masks(filled, n, bank_budget);
    // Preserve real descending slopes; CPU heap visitation and GPU flat costs no
    // longer decide which otherwise equally eligible slope can receive rainfall.
    for i in 0..len {
        receivers[i] = OUT;
        if sea[i] {
            labels[i] = 0;
            continue;
        }
        if border(i, n) {
            continue;
        }
        let mut best = 0.0;
        for d in 0..8 {
            let Some(j) = neighbor(i, d, n) else { continue };
            if allowed[i] & (1 << d) == 0 {
                continue;
            }
            let slope = (filled[i] - filled[j]) / step_length(d);
            if slope > 0.0 && better(slope, best, j, receivers[i], physical) {
                best = slope;
                receivers[i] = j as u32;
            } else if best == 0.0 && sea[j] && filled[j] == filled[i] {
                // A shoreline at the marine datum is a real outlet, even when
                // the zero-level land and sea cells share the same F value.
                if receivers[i] == OUT || j < receivers[i] as usize {
                    receivers[i] = j as u32;
                }
            }
        }
    }
    let mut id = 0;
    let mut pool = Vec::new();
    let mut exits = Vec::new();
    let mut heap = BinaryHeap::new();
    let mut broad_flats = Vec::new();
    for start in 0..len {
        if labels[start] != OUT {
            continue;
        }
        pool.clear();
        pool.push(start);
        let label = id + 1;
        labels[start] = label;
        let level = filled[start];
        let mut k = 0;
        while k < pool.len() {
            let i = pool[k];
            k += 1;
            for d in 0..8 {
                if let Some(j) = neighbor(i, d, n)
                    && labels[j] == OUT
                    && !sea[j]
                    && filled[j] == level
                    && allowed[i] & (1 << d) != 0
                {
                    labels[j] = label;
                    pool.push(j);
                }
            }
        }
        if pool.len() == 1 {
            labels[start] = 0;
            if receivers[start] == OUT && !border(start, n) {
                return Err("Cellule intérieure sans sortie hydrologique.".into());
            }
            continue;
        }
        id = label;
        exits.clear();
        let depth = pool
            .iter()
            .map(|&i| (level - physical[i]).max(0.0))
            .fold(0.0_f32, f32::max);
        for &i in &pool {
            if border(i, n) || receivers[i] != OUT {
                distance[i] = 0.0;
                exits.push(i);
            }
            if depth > 0.025 {
                // A short positive filter removes cell-scale hollows from the
                // routing cost while retaining broad buried valley corridors.
                let mut sum = 4.0 * (level - physical[i]).max(0.0);
                let mut weight = 4.0;
                for d in 0..8 {
                    if let Some(j) = neighbor(i, d, n)
                        && labels[j] == label
                    {
                        let w = if d.is_multiple_of(2) { 2.0 } else { 1.0 };
                        sum += w * (level - physical[j]).max(0.0);
                        weight += w;
                    }
                }
                let bank = 1.0 - (sum / weight / depth).clamp(0.0, 1.0);
                travel_cost[i] = 1.0 + 3.0 * bank * bank;
            }
        }
        if exits.is_empty() {
            return Err("Surface plate sans exutoire connecté.".into());
        }
        solve(
            &pool,
            &exits,
            &labels,
            &travel_cost,
            &allowed,
            n,
            receivers,
            &mut rank,
            &mut distance,
            &mut heap,
        )?;
        if pool.len() >= 128 && depth > 0.4 {
            broad_flats.push(pool.clone());
        }
    }
    if !broad_flats.is_empty() {
        // The first complete tree supplies real hillslope inputs as well as rain
        // over flats. One bounded feedback pass favours established larger
        // channels; the final receivers still belong to one metric forest.
        let supply = contributing_cells(receivers, sea)?;
        let mut influence = vec![0.0_f32; len];
        let mut next_influence = vec![0.0_f32; len];
        for pool in broad_flats {
            let label = labels[pool[0]];
            let maximum = pool.iter().map(|&i| supply[i]).max().unwrap_or(1) as f32;
            for &i in &pool {
                influence[i] = (supply[i] as f32 / maximum).sqrt();
            }
            // Max propagation retains thin channel signals rather than averaging
            // them away. Its positive distance penalty bounds the halo to seven
            // cells and keeps it inside this exact spill-level component.
            for _ in 0..6 {
                for &i in &pool {
                    let mut value = influence[i];
                    for d in 0..8 {
                        if let Some(j) = neighbor(i, d, n)
                            && labels[j] == label
                        {
                            value = value.max(influence[j] - 0.15 * step_length(d));
                        }
                    }
                    next_influence[i] = value;
                }
                std::mem::swap(&mut influence, &mut next_influence);
            }
            exits.clear();
            for &i in &pool {
                let j = receivers[i];
                let exit = border(i, n)
                    || (j != OUT && (filled[j as usize] < filled[i] || sea[j as usize]));
                rank[i] = 0;
                distance[i] = if exit { 0.0 } else { f64::INFINITY };
                if exit {
                    exits.push(i);
                } else {
                    receivers[i] = OUT;
                }
                travel_cost[i] /= 1.0 + 12.0 * influence[i] * influence[i];
            }
            solve(
                &pool,
                &exits,
                &labels,
                &travel_cost,
                &allowed,
                n,
                receivers,
                &mut rank,
                &mut distance,
                &mut heap,
            )?;
        }
    }
    consolidate_slopes(
        filled, sea, n, cell, &labels, &rank, receivers, None, &allowed,
    )?;
    Ok(Mask { labels, rank })
}

struct ExternalCorridor<'a> {
    path: &'a [bool],
    area: f32,
    radius: f32,
    bank_radius: f32,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn capture_external(
    drainage: &mut Drainage,
    sea: &[bool],
    n: usize,
    cell: f32,
    labels: &[u32],
    source: usize,
    area: f32,
    radius: f32,
    bank_radius: f32,
    bank_budget: f32,
) -> Result<(), String> {
    let len = drainage.receivers.len();
    let mut path = vec![false; len];
    let mut i = source;
    loop {
        if path[i] {
            return Err("Cycle détecté dans le cours principal.".into());
        }
        path[i] = true;
        let j = drainage.receivers[i];
        if j == OUT || sea[i] {
            break;
        }
        i = j as usize;
    }
    // Lake interiors now have their aggregated order, which can differ from
    // the exported pre-aggregation flat rank.
    let mut rank = vec![0; len];
    for (k, &i) in drainage.order.iter().enumerate() {
        rank[i] = k as u32;
    }
    let corridor = ExternalCorridor {
        path: &path,
        area,
        radius,
        bank_radius,
    };
    consolidate_slopes(
        &drainage.filled,
        sea,
        n,
        cell,
        labels,
        &rank,
        &mut drainage.receivers,
        Some(&corridor),
        &diagonal_masks(&drainage.filled, n, bank_budget),
    )
}

fn external_halo(path: &[bool], sea: &[bool], n: usize, cell: f32, radius: f32) -> Vec<f32> {
    let mut distance = vec![f64::INFINITY; path.len()];
    let mut influence = vec![0.0; path.len()];
    let mut heap = BinaryHeap::new();
    for (i, &main) in path.iter().enumerate() {
        if main && !sea[i] {
            distance[i] = 0.0;
            heap.push(Reverse((0_u64, i)));
        }
    }
    while let Some(Reverse((bits, i))) = heap.pop() {
        let cost = f64::from_bits(bits);
        if distance[i] != cost {
            continue;
        }
        influence[i] = (1.0 - cost as f32 / radius).max(0.0);
        for d in 0..8 {
            let Some(j) = neighbor(i, d, n) else { continue };
            let next = cost + f64::from(cell * step_length(d));
            if !sea[j] && next < f64::from(radius) && next < distance[j] {
                distance[j] = next;
                heap.push(Reverse((next.to_bits(), j)));
            }
        }
    }
    influence
}

#[allow(clippy::too_many_arguments)]
fn consolidate_slopes(
    filled: &[f32],
    sea: &[bool],
    n: usize,
    cell: f32,
    labels: &[u32],
    flat_rank: &[u32],
    receivers: &mut [u32],
    external: Option<&ExternalCorridor<'_>>,
    allowed: &[u8],
) -> Result<(), String> {
    let len = filled.len();
    let mut flat_storage = vec![false; labels.iter().copied().max().unwrap_or(0) as usize + 1];
    for (i, &j) in receivers.iter().enumerate() {
        if j != OUT && filled[j as usize] == filled[i] && labels[i] != 0 {
            flat_storage[labels[i] as usize] = true;
        }
    }
    let mut fixed: Vec<bool> = (0..len)
        .map(|i| {
            sea[i]
                || border(i, n)
                || flat_storage[labels[i] as usize]
                || external.is_some_and(|corridor| corridor.path[i])
        })
        .collect();
    if fixed.iter().all(|&value| value) {
        return Ok(());
    }
    let supply = contributing_cells(receivers, sea)?;
    let mut influence: Vec<f32> = if let Some(corridor) = external {
        external_halo(corridor.path, sea, n, cell, corridor.radius)
    } else {
        supply
            .iter()
            .map(|&area| {
                ((area as f32 * cell * cell - 50_000.0) / 350_000.0)
                    .clamp(0.0, 1.0)
                    .sqrt()
            })
            .collect()
    };
    if influence.iter().all(|&value| value == 0.0) {
        return Ok(());
    }
    let steps = if external.is_some() {
        0
    } else {
        (80.0 / cell).ceil().clamp(2.0, 16.0) as usize
    };
    let capture_radius = external.map_or(steps as f32 * cell, |corridor| corridor.radius);
    let mut next = if steps == 0 { vec![] } else { vec![0.0; len] };
    for _ in 0..steps {
        for i in 0..len {
            let mut value = influence[i];
            if !sea[i] {
                for d in 0..8 {
                    if let Some(j) = neighbor(i, d, n)
                        && !sea[j]
                    {
                        value = value.max(influence[j] - step_length(d) / steps as f32);
                    }
                }
            }
            next[i] = value;
        }
        std::mem::swap(&mut influence, &mut next);
    }
    drop(next);
    // Channel attraction is local. A distant cheap outlet must not redirect
    // unrelated hillside rain outside the physical corridor neighbourhood.
    for (protected, &value) in fixed.iter_mut().zip(&influence) {
        *protected |= value <= 0.0;
    }
    // A large active bank can capture a weak lateral descent. Away from that
    // physical bank neighbourhood the ordinary steepest-gradient quota remains.
    let bank_capture: Vec<bool> = influence
        .iter()
        .map(|&value| {
            external.is_some_and(|corridor| {
                value > 0.0 && value >= 1.0 - corridor.bank_radius / corridor.radius
            })
        })
        .collect();
    let protected = fixed.clone();
    let cost: Vec<f64> = influence
        .iter()
        .enumerate()
        .map(|(i, &value)| {
            if let Some(corridor) = external {
                let natural = (f64::from(supply[i]) * f64::from(cell).powi(2) / 400_000.0).sqrt();
                let dominant = (f64::from(corridor.area) / 400_000.0).powf(0.45);
                1.0 / (1.0 + 12.0 * natural + 12.0 * dominant * f64::from(value * value))
            } else {
                1.0 / (1.0 + 12.0 * f64::from(value * value))
            }
        })
        .collect();
    drop(influence);
    let order = surface_order(filled, flat_rank);
    let mut old_length = vec![0.0_f32; len];
    for &i in &order {
        let j = receivers[i];
        if j != OUT {
            let j = j as usize;
            let step = if i % n == j % n || i / n == j / n {
                1.0
            } else {
                std::f32::consts::SQRT_2
            };
            old_length[i] = old_length[j] + cell * step;
        }
    }
    let mut potential = vec![0.0; len];
    let mut length = vec![0.0_f32; len];
    for &i in &order {
        let original = receivers[i];
        if original == OUT {
            fixed[i] = true;
            continue;
        }
        if fixed[i] {
            let j = original as usize;
            let step = if i % n == j % n || i / n == j / n {
                1.0
            } else {
                std::f32::consts::SQRT_2
            };
            potential[i] = potential[j] + f64::from(step) * (cost[i] + cost[j]) * 0.5;
            length[i] = length[j] + cell * step;
            continue;
        }
        let steepest = (0..8)
            .filter_map(|d| {
                neighbor(i, d, n).map(|j| ((filled[i] - filled[j]) / step_length(d)).max(0.0))
            })
            .fold(0.0_f32, f32::max);
        let mut best = f64::INFINITY;
        let mut receiver = OUT;
        let mut best_length = 0.0;
        // The extra physical distance is bounded: attraction cannot send a
        // slope stream around the map merely to reach a cheap distant trunk.
        for d in 0..8 {
            let Some(j) = neighbor(i, d, n) else { continue };
            let gradient = (filled[i] - filled[j]) / step_length(d);
            if gradient <= 0.0 || allowed[i] & (1 << d) == 0 || crosses_diagonal(i, j, receivers, n)
            {
                continue;
            }
            let ratio = gradient / steepest.max(f32::MIN_POSITIVE);
            let candidate_length = length[j] + cell * step_length(d);
            if (!bank_capture[i] && ratio < 0.25)
                || candidate_length > old_length[i] * 1.35 + capture_radius
            {
                continue;
            }
            let penalty = 1.0 + 6.0 * f64::from((1.0 - ratio).powi(2));
            let value =
                potential[j] + f64::from(step_length(d)) * (cost[i] + cost[j]) * 0.5 * penalty;
            if value < best || (value == best && (j as u32) < receiver) {
                best = value;
                receiver = j as u32;
                best_length = candidate_length;
            }
        }
        if receiver == OUT {
            // Planarity remains mandatory when a fixed neighbouring flat entry
            // excludes the original steepest diagonal. Take any real descent.
            for d in 0..8 {
                let Some(j) = neighbor(i, d, n) else { continue };
                if filled[j] >= filled[i]
                    || allowed[i] & (1 << d) == 0
                    || crosses_diagonal(i, j, receivers, n)
                    || length[j] + cell * step_length(d) > old_length[i] * 1.35 + capture_radius
                {
                    continue;
                }
                let value = potential[j] + f64::from(step_length(d)) * (cost[i] + cost[j]) * 0.5;
                if value < best {
                    best = value;
                    receiver = j as u32;
                    best_length = length[j] + cell * step_length(d);
                }
            }
        }
        if receiver == OUT {
            return Err("Versant sans sortie descendante planaire.".into());
        }
        receivers[i] = receiver;
        potential[i] = best;
        length[i] = best_length;
        fixed[i] = true;
    }
    // Capturing a bank-contact creek requires a nearby real confluence, not
    // a long parallel cheap path that eventually joins farther downstream.
    // Two sweeps can use old diagonals freed during the preceding sweep;
    // every individual change stays planar and strictly downhill. Retain the
    // first graph's complete outlet-length budget across both sweeps.
    if let Some(corridor) = external {
        let mut first_hit = vec![f32::INFINITY; len];
        for _ in 0..2 {
            potential.fill(f64::INFINITY);
            first_hit.fill(f32::INFINITY);
            length.fill(0.0);
            for &i in &order {
                let original = receivers[i];
                if original == OUT {
                    if corridor.path[i] {
                        first_hit[i] = 0.0;
                        potential[i] = 0.0;
                    }
                    continue;
                }
                let j = original as usize;
                let original_step = if i % n == j % n || i / n == j / n {
                    1.0
                } else {
                    std::f32::consts::SQRT_2
                };
                length[i] = length[j] + cell * original_step;
                if corridor.path[i] {
                    first_hit[i] = 0.0;
                    potential[i] = 0.0;
                    continue;
                }
                if protected[i] || !bank_capture[i] {
                    first_hit[i] = first_hit[j] + cell * original_step;
                    potential[i] = potential[j] + f64::from(original_step);
                    continue;
                }
                let steepest = (0..8)
                    .filter_map(|d| {
                        neighbor(i, d, n)
                            .map(|j| ((filled[i] - filled[j]) / step_length(d)).max(0.0))
                    })
                    .fold(0.0_f32, f32::max);
                let mut best = f64::INFINITY;
                let mut target = OUT;
                let mut target_distance = f32::INFINITY;
                let mut target_length = length[i];
                for d in 0..8 {
                    let Some(j) = neighbor(i, d, n) else { continue };
                    let gradient = (filled[i] - filled[j]) / step_length(d);
                    let distance = first_hit[j] + cell * step_length(d);
                    let actual_length = length[j] + cell * step_length(d);
                    if gradient <= 0.0
                        || allowed[i] & (1 << d) == 0
                        || !potential[j].is_finite()
                        || distance > corridor.bank_radius
                        || actual_length > old_length[i] * 1.35 + capture_radius
                        || crosses_diagonal(i, j, receivers, n)
                    {
                        continue;
                    }
                    let ratio = gradient / steepest.max(f32::MIN_POSITIVE);
                    let candidate = potential[j]
                        + f64::from(step_length(d))
                            * (1.0 + 6.0 * f64::from((1.0 - ratio).powi(2)));
                    if candidate < best || (candidate == best && (j as u32) < target) {
                        best = candidate;
                        target = j as u32;
                        target_distance = distance;
                        target_length = actual_length;
                    }
                }
                if target != OUT {
                    receivers[i] = target;
                    first_hit[i] = target_distance;
                    potential[i] = best;
                    length[i] = target_length;
                } else {
                    first_hit[i] = first_hit[j] + cell * original_step;
                    potential[i] = potential[j] + f64::from(original_step);
                }
            }
        }
    }
    Ok(())
}

fn crosses_diagonal(i: usize, j: usize, receivers: &[u32], n: usize) -> bool {
    if i % n == j % n || i / n == j / n {
        return false;
    }
    let a = i / n * n + j % n;
    let b = j / n * n + i % n;
    receivers[a] == b as u32 || receivers[b] == a as u32
}

fn contributing_cells(receivers: &[u32], sea: &[bool]) -> Result<Vec<u32>, String> {
    let len = receivers.len();
    let mut indegree = vec![0_u8; len];
    for &j in receivers {
        if j != OUT {
            indegree[j as usize] += 1;
        }
    }
    let mut queue: Vec<usize> = (0..len).filter(|&i| indegree[i] == 0).collect();
    let mut supply: Vec<u32> = sea.iter().map(|&water| u32::from(!water)).collect();
    let mut k = 0;
    while k < queue.len() {
        let i = queue[k];
        k += 1;
        let j = receivers[i];
        if j != OUT {
            let j = j as usize;
            supply[j] += supply[i];
            indegree[j] -= 1;
            if indegree[j] == 0 {
                queue.push(j);
            }
        }
    }
    if queue.len() != len {
        return Err("Cycle détecté avant consolidation des corridors alluviaux.".into());
    }
    Ok(supply)
}

#[allow(clippy::too_many_arguments)]
fn solve(
    pool: &[usize],
    exits: &[usize],
    labels: &[u32],
    travel_cost: &[f32],
    allowed: &[u8],
    n: usize,
    receivers: &mut [u32],
    rank: &mut [u32],
    distance: &mut [f64],
    heap: &mut BinaryHeap<Reverse<(u64, usize)>>,
) -> Result<(), String> {
    let label = labels[pool[0]];
    heap.clear();
    for &i in exits {
        heap.push(Reverse((0_u64, i)));
    }
    let mut settled = 0;
    while let Some(Reverse((bits, i))) = heap.pop() {
        let cost = f64::from_bits(bits);
        if distance[i] != cost || rank[i] != 0 {
            continue;
        }
        settled += 1;
        rank[i] = settled;
        for d in 0..8 {
            if let Some(j) = neighbor(i, d, n)
                && labels[j] == label
                && rank[j] == 0
                && distance[j] != 0.0
                && allowed[i] & (1 << d) != 0
                && !crosses_fixed_diagonal(j, i, receivers, rank, distance, n)
            {
                // Averaging endpoint costs keeps edges symmetric. Opposite
                // diagonals cannot both minimise these metric path costs.
                let edge_cost = if travel_cost.is_empty() {
                    1.0
                } else {
                    f64::from(travel_cost[i] + travel_cost[j]) * 0.5
                };
                let next = cost + f64::from(step_length(d)) * edge_cost;
                if next < distance[j] || (next == distance[j] && (i as u32) < receivers[j]) {
                    distance[j] = next;
                    receivers[j] = i as u32;
                    heap.push(Reverse((next.to_bits(), j)));
                }
            }
        }
    }
    if pool.iter().any(|&i| rank[i] == 0) {
        return Err("Surface plate sans chemin métrique vers son exutoire.".into());
    }
    Ok(())
}

fn crosses_fixed_diagonal(
    i: usize,
    j: usize,
    receivers: &[u32],
    rank: &[u32],
    distance: &[f64],
    n: usize,
) -> bool {
    if i % n == j % n || i / n == j / n {
        return false;
    }
    let a = i / n * n + j % n;
    let b = j / n * n + i % n;
    let fixed = |cell: usize| rank[cell] != 0 || distance[cell] == 0.0;
    (fixed(a) && receivers[a] == b as u32) || (fixed(b) && receivers[b] == a as u32)
}

fn better(slope: f32, best: f32, next: usize, previous: u32, physical: &[f32]) -> bool {
    slope > best
        || (slope == best
            && (previous == OUT
                || physical[next] < physical[previous as usize]
                || (physical[next] == physical[previous as usize] && next < previous as usize)))
}

fn step_length(d: usize) -> f32 {
    if d.is_multiple_of(2) {
        1.0
    } else {
        std::f32::consts::SQRT_2
    }
}

/// A retained lake is one storage node. Route its connected cells to a single
/// existing exit before accumulation, so its spill receives all lake inputs.
pub(super) fn aggregate_lakes(
    drainage: &mut Drainage,
    lakes: &[u32],
    n: usize,
    bank_budget: f32,
) -> Result<(), String> {
    let allowed = diagonal_masks(&drainage.filled, n, bank_budget);
    let count = lakes.iter().copied().max().unwrap_or(0) as usize;
    let mut outlet = vec![OUT; count];
    let mut order_at = vec![0; lakes.len()];
    for (k, &i) in drainage.order.iter().enumerate() {
        order_at[i] = k;
    }
    for (i, &lake) in lakes.iter().enumerate() {
        let j = drainage.receivers[i];
        if lake == 0 || (j != OUT && lakes[j as usize] == lake) {
            continue;
        }
        let previous = &mut outlet[lake as usize - 1];
        // The most downstream existing exit cannot return to this lake: any
        // later departure on such a path would have preceded it in this order.
        let key = |cell: usize| {
            let next = drainage.receivers[cell];
            (
                if next == OUT {
                    0
                } else {
                    order_at[next as usize] + 1
                },
                cell,
            )
        };
        if *previous == OUT || key(i) < key(*previous as usize) {
            *previous = i as u32;
        }
    }
    drop(order_at);
    let mut pools = vec![Vec::new(); count];
    for (i, &lake) in lakes.iter().enumerate() {
        if lake != 0 {
            pools[lake as usize - 1].push(i);
        }
    }
    // Dry bank entries remain fixed. The interior shortest paths cannot cross
    // those entries and reconnect behind them through a second diagonal.
    let mut distance = vec![0.0; lakes.len()];
    let mut rank = vec![0; lakes.len()];
    let mut heap = BinaryHeap::new();
    for (index, &root) in outlet.iter().enumerate() {
        if root == OUT {
            return Err("Lac retenu sans sortie de drainage.".into());
        }
        let root = root as usize;
        let mut complete = false;
        for _ in 0..pools[index].len() {
            for &i in &pools[index] {
                rank[i] = 0;
                distance[i] = if i == root { 0.0 } else { f64::INFINITY };
                if i != root {
                    drainage.receivers[i] = OUT;
                }
            }
            if solve(
                &pools[index],
                &[root],
                lakes,
                &[],
                &allowed,
                n,
                &mut drainage.receivers,
                &mut rank,
                &mut distance,
                &mut heap,
            )
            .is_ok()
            {
                complete = true;
                break;
            }
            // A lake connected only at a diagonal cannot preserve an opposite
            // dry crossing as a separate stream. On this failed-only path the
            // touching stream enters the already connected water corner.
            if !repair_lake_contact(drainage, &pools[index], lakes, &rank, root, n) {
                break;
            }
        }
        if !complete {
            return Err("Lac sans chemin planaire vers son exutoire.".into());
        }
    }
    Ok(())
}

fn repair_lake_contact(
    drainage: &mut Drainage,
    pool: &[usize],
    lakes: &[u32],
    rank: &[u32],
    root: usize,
    n: usize,
) -> bool {
    let mut downstream = vec![false; lakes.len()];
    let mut cell = root;
    loop {
        if downstream[cell] {
            return false;
        }
        downstream[cell] = true;
        let next = drainage.receivers[cell];
        if next == OUT {
            break;
        }
        cell = next as usize;
    }
    let label = lakes[root];
    for &i in pool {
        if rank[i] != 0 {
            continue;
        }
        for d in (1..8).step_by(2) {
            let Some(j) = neighbor(i, d, n) else { continue };
            if lakes[j] != label || rank[j] == 0 {
                continue;
            }
            let a = i / n * n + j % n;
            let b = j / n * n + i % n;
            for (source, target) in [(a, b), (b, a)] {
                if lakes[source] == 0
                    && drainage.receivers[source] == target as u32
                    && !downstream[source]
                    && drainage.filled[source] >= drainage.filled[j]
                {
                    // j already reaches the unchanged outlet. Excluding its
                    // current downstream path proves this new inlet is acyclic,
                    // without relying on a stale pre-aggregation rank.
                    drainage.receivers[source] = j as u32;
                    return true;
                }
            }
        }
    }
    false
}

/// The dry hydrological surface later equals F. Test its exact bilinear crest
/// along this diagonal against the maximum upstream water level plus budget.
pub(super) fn diagonal_open(i: usize, j: usize, filled: &[f32], n: usize, budget: f32) -> bool {
    if i % n == j % n || i / n == j / n {
        return true;
    }
    let a = i / n * n + j % n;
    let b = j / n * n + i % n;
    let m = (f64::from(filled[a]) + f64::from(filled[b])) * 0.5;
    let hi = f64::from(filled[i].max(filled[j]));
    let lo = f64::from(filled[i].min(filled[j]));
    if m <= hi {
        return true;
    }
    let x = m - hi;
    x * x / (m - lo + x) <= f64::from(budget) + 0.0001
}

/// Diagonal clearance depends only on this immutable surface and bank budget.
/// Evaluate each undirected diagonal once; receiver crossing checks stay dynamic.
fn diagonal_masks(filled: &[f32], n: usize, budget: f32) -> Vec<u8> {
    let mut allowed = vec![0x55; filled.len()];
    for i in 0..filled.len() {
        for d in [1, 7] {
            if let Some(j) = neighbor(i, d, n)
                && diagonal_open(i, j, filled, n, budget)
            {
                allowed[i] |= 1 << d;
                allowed[j] |= 1 << ((d + 4) & 7);
            }
        }
    }
    allowed
}

/// Stable radix ordering matches (f32::total_cmp(height), rank, cell index).
/// Starting in cell-index order preserves the last tie-break without another key.
fn surface_order(filled: &[f32], rank: &[u32]) -> Vec<usize> {
    let keys: Vec<u64> = filled
        .iter()
        .zip(rank)
        .map(|(&height, &rank)| {
            let bits = height.to_bits();
            let ordered = if bits & 0x8000_0000 != 0 {
                !bits
            } else {
                bits ^ 0x8000_0000
            };
            (u64::from(ordered) << 32) | u64::from(rank)
        })
        .collect();
    let mut order: Vec<usize> = (0..filled.len()).collect();
    let mut next = vec![0; filled.len()];
    for shift in (0..64).step_by(8) {
        let mut positions = [0_usize; 256];
        for &i in &order {
            positions[((keys[i] >> shift) & 255) as usize] += 1;
        }
        let mut offset = 0;
        for position in &mut positions {
            let count = *position;
            *position = offset;
            offset += count;
        }
        for &i in &order {
            let bucket = ((keys[i] >> shift) & 255) as usize;
            next[positions[bucket]] = i;
            positions[bucket] += 1;
        }
        std::mem::swap(&mut order, &mut next);
    }
    order
}

/// F4 is a physical upper bound. Frozen upper corners make diagonal edge costs
/// monotone in the settled downstream level, so a single second heap flood
/// suffices and its final surface remains below F4 even after pond filling.
#[allow(clippy::too_many_arguments)]
pub(super) fn condition(
    initial: Drainage,
    height: &[f32],
    sea: &[bool],
    n: usize,
    _width: f32,
    seed: &str,
    budget: f32,
) -> Drainage {
    if initial
        .receivers
        .iter()
        .enumerate()
        .all(|(i, &j)| j == OUT || diagonal_open(i, j as usize, &initial.filled, n, budget))
    {
        return initial;
    }
    let upper = fill_cardinal(height, sea, n, seed);
    let len = height.len();
    let mut filled = vec![f32::INFINITY; len];
    let mut receivers = vec![OUT; len];
    let mut settled = vec![false; len];
    let mut heap = BinaryHeap::new();
    let mut order = Vec::with_capacity(len);
    for i in 0..len {
        if border(i, n) || sea[i] {
            filled[i] = height[i];
            heap.push(HeapCell {
                z: height[i],
                tie: i as u32,
                cell: i,
            });
        }
    }
    while let Some(node) = heap.pop() {
        let i = node.cell;
        if settled[i] || node.z != filled[i] {
            continue;
        }
        settled[i] = true;
        order.push(i);
        for d in 0..8 {
            let Some(j) = neighbor(i, d, n) else { continue };
            if settled[j] {
                continue;
            }
            let mut level = f64::from(height[j].max(filled[i]));
            if level >= f64::from(filled[j]) {
                continue;
            }
            if !d.is_multiple_of(2) {
                let a = i / n * n + j % n;
                let b = j / n * n + i % n;
                let m = (f64::from(upper[a]) + f64::from(upper[b])) * 0.5;
                let downstream = f64::from(filled[i]);
                if m > downstream {
                    let reserve = f64::from(budget) * 0.98;
                    let required = m
                        - (reserve + (reserve * reserve + 4.0 * reserve * (m - downstream)).sqrt())
                            * 0.5;
                    level = level.max(required);
                }
            }
            let mut next = level as f32;
            if f64::from(next) < level {
                next = next.next_up();
            }
            if next < filled[j] {
                filled[j] = next;
                receivers[j] = i as u32;
                heap.push(HeapCell {
                    z: next,
                    tie: j as u32,
                    cell: j,
                });
            }
        }
    }
    order.reverse();
    Drainage {
        filled,
        receivers,
        order,
        accumulation: vec![0.0; len],
    }
}
