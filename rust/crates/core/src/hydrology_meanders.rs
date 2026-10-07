//! Continuous physical channel variation and bounded adaptive vector sampling.

/// C2 seeded one-dimensional value noise. Its lattice is physical channel
/// wavelengths, not drainage pixels or screen coordinates.
pub(super) fn course_noise(position: f32, seed: u32) -> f32 {
    let index = position.floor() as i32;
    let t = position - position.floor();
    let t = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
    course_value(index, seed) + (course_value(index + 1, seed) - course_value(index, seed)) * t
}

fn course_value(index: i32, seed: u32) -> f32 {
    let mut x = (index as u32).wrapping_mul(0x9e3779b9) ^ seed;
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846ca68b);
    x ^= x >> 16;
    (x as f64 / u32::MAX as f64) as f32
}

/// Cubic B-spline noise is C2 without stationary points or zero crossings at
/// its lattice. Random neighbouring controls need not alternate their signs.
fn course_spline(position: f32, seed: u32) -> f32 {
    let index = position.floor() as i32;
    let t = position - position.floor();
    let weights = [
        (1.0 - t).powi(3),
        3.0 * t * t * t - 6.0 * t * t + 4.0,
        -3.0 * t * t * t + 3.0 * t * t + 3.0 * t + 1.0,
        t * t * t,
    ];
    weights
        .iter()
        .enumerate()
        .map(|(k, &weight)| weight * (course_value(index + k as i32 - 1, seed) * 2.0 - 1.0))
        .sum::<f32>()
        / 6.0
}

// For controls in [-1, 1], a cubic B-spline's second derivative is at most 4.
// Include every band's gain and frequency in the caller's physical radius cap.
pub(super) const COURSE_CURVATURE_BOUND: f32 = 64.0;

/// Continuous stochastic bends combine channel and intermediate scales with a
/// gentle broad wandering course. There is no periodic carrier forcing an
/// alternating bend at each wavelength. The intermediate band prevents a
/// locally linear run of coarse controls from suppressing all channel bends.
pub(super) fn continuous_offset(phase: f32, coordinate: f32, seed: u32) -> f32 {
    // Quiet reaches retain a broad physical bend. Their mobility may still
    // vanish on steep or confined ground in the caller; quiet stochastic activity
    // alone must not collapse an open, wide river below its own width.
    let amplitude = 0.42 + course_noise(coordinate * 0.4, seed ^ 0x219438ae) * 0.58;
    let physical_phase = phase / std::f32::consts::TAU;
    let channel = course_spline(physical_phase * 3.5, seed ^ 0x34a017d3);
    let medium = course_spline(physical_phase * 1.15, seed ^ 0x69194e7b);
    let broad = course_spline(physical_phase * 0.23, seed ^ 0x1725413b);
    (channel * 0.5 + medium * 0.35 + broad * 0.15) * 2.4 * amplitude
}

/// Adaptive Hermite densification with shared, bounded node tangents.
/// Every input anchor is retained exactly at integer t; the caller interpolates
/// width and descending water height linearly using t = segment + fraction.
/// `tolerance` is geometric error in metres, not a sampling step or zoom level.
/// Flat XY spans need no extra vertices. Their terrain/water profiles may still
/// need adaptive Z samples in the caller, as bilinear heights are not linear on diagonals.
pub(super) fn smooth_polyline(
    points: &[(f32, f32)],
    tolerance: f32,
    tangent_scales: &[f32],
) -> Vec<(f32, f32, f32)> {
    if points.len() < 2 {
        return points.iter().map(|&(x, y)| (x, y, 0.0)).collect();
    }
    let chord = |i: usize| {
        (
            f64::from(points[i + 1].0) - f64::from(points[i].0),
            f64::from(points[i + 1].1) - f64::from(points[i].1),
        )
    };
    let lengths: Vec<_> = (0..points.len() - 1)
        .map(|i| {
            let (x, y) = chord(i);
            x.hypot(y)
        })
        .collect();
    let mut tangents = Vec::with_capacity(points.len());
    for (i, &tangent_scale) in tangent_scales.iter().enumerate().take(points.len()) {
        let before = i.saturating_sub(1);
        let after = i.min(points.len() - 2);
        let a = chord(before);
        let b = chord(after);
        let la = lengths[before];
        let lb = lengths[after];
        let direction = (
            a.0 / la.max(1.0e-9) + b.0 / lb.max(1.0e-9),
            a.1 / la.max(1.0e-9) + b.1 / lb.max(1.0e-9),
        );
        let norm = direction.0.hypot(direction.1).max(1.0e-9);
        // Centripetal intervals sqrt(chord) and unit-direction bisectors keep
        // a common tangent direction at each node. Each Bezier handle remains
        // shorter than 0.85/3 of its chord, so no new local reversal is forced.
        let speed = la.min(lb).sqrt() * 0.85 * f64::from(tangent_scale);
        tangents.push((direction.0 / norm * speed, direction.1 / norm * speed));
    }
    let tolerance_squared = f64::from(tolerance).max(0.05).powi(2);
    let mut result = Vec::with_capacity(points.len() * 2);
    result.push((points[0].0, points[0].1, 0.0));
    for i in 0..points.len() - 1 {
        let a = (f64::from(points[i].0), f64::from(points[i].1));
        let b = (f64::from(points[i + 1].0), f64::from(points[i + 1].1));
        let interval = lengths[i].sqrt() / 3.0;
        let c = (
            a.0 + tangents[i].0 * interval,
            a.1 + tangents[i].1 * interval,
        );
        let d = (
            b.0 - tangents[i + 1].0 * interval,
            b.1 - tangents[i + 1].1 * interval,
        );
        let mut splits = 127;
        adaptive_cubic(
            [a, c, d, b],
            (i as f64, (i + 1) as f64),
            tolerance_squared,
            0,
            &mut splits,
            &mut result,
        );
    }
    result
}

type Point = (f64, f64);

fn chord_error(a: Point, b: Point, p: Point) -> f64 {
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    let t =
        (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / (dx * dx + dy * dy).max(1.0e-18)).clamp(0.0, 1.0);
    (p.0 - a.0 - dx * t).powi(2) + (p.1 - a.1 - dy * t).powi(2)
}

fn adaptive_cubic(
    curve: [Point; 4],
    parameter: (f64, f64),
    tolerance_squared: f64,
    depth: usize,
    splits: &mut usize,
    result: &mut Vec<(f32, f32, f32)>,
) {
    let [a, c, d, b] = curve;
    // A Bezier lies inside its control hull. This bound catches both ordinary
    // arcs and S inflections whose midpoint alone could sit on the chord.
    let error = chord_error(a, b, c).max(chord_error(a, b, d));
    let t = (parameter.0 + parameter.1) * 0.5;
    let distinct_parameter = (t as f32) > parameter.0 as f32 && (t as f32) < parameter.1 as f32;
    if error <= tolerance_squared || depth == 10 || *splits == 0 || !distinct_parameter {
        result.push((b.0 as f32, b.1 as f32, parameter.1 as f32));
        return;
    }
    // At most 128 leaves per source segment; pathological inputs cannot explode
    // the retained geometry even when their requested tolerance is unattainable.
    *splits -= 1;
    let midpoint = |p: Point, q: Point| ((p.0 + q.0) * 0.5, (p.1 + q.1) * 0.5);
    let ac = midpoint(a, c);
    let cd = midpoint(c, d);
    let db = midpoint(d, b);
    let left = midpoint(ac, cd);
    let right = midpoint(cd, db);
    let middle = midpoint(left, right);
    adaptive_cubic(
        [a, ac, left, middle],
        (parameter.0, t),
        tolerance_squared,
        depth + 1,
        splits,
        result,
    );
    adaptive_cubic(
        [middle, right, db, b],
        (t, parameter.1),
        tolerance_squared,
        depth + 1,
        splits,
        result,
    );
}

/// Add only the XY stations needed to approximate a physical water profile.
/// The caller supplies its bounded profile in metres. All input stations remain
/// exact; extra stations lie on the retained XY chords and interpolate t linearly.
pub(super) fn refine_profile(
    samples: &[(f32, f32, f32)],
    tolerance: f32,
    profile: impl Fn(f32, f32, f32) -> f32,
) -> Vec<(f32, f32, f32)> {
    if samples.len() < 2 {
        return samples.to_vec();
    }
    let mut refiner = ProfileRefiner {
        profile,
        tolerance: tolerance.max(0.01),
        result: Vec::with_capacity(samples.len() * 2),
    };
    refiner.result.push(samples[0]);
    for pair in samples.windows(2) {
        let a = pair[0];
        let b = pair[1];
        let za = (refiner.profile)(a.0, a.1, a.2);
        let zb = (refiner.profile)(b.0, b.1, b.2);
        let mut splits = 127;
        refiner.interval(a, b, za, zb, 0, &mut splits);
    }
    refiner.result
}

type Station = (f32, f32, f32);

struct ProfileRefiner<F> {
    profile: F,
    tolerance: f32,
    result: Vec<Station>,
}

impl<F: Fn(f32, f32, f32) -> f32> ProfileRefiner<F> {
    fn interval(
        &mut self,
        a: Station,
        b: Station,
        za: f32,
        zb: f32,
        depth: usize,
        splits: &mut usize,
    ) {
        let at = |f: f32| {
            (
                a.0 + (b.0 - a.0) * f,
                a.1 + (b.1 - a.1) * f,
                a.2 + (b.2 - a.2) * f,
            )
        };
        let middle = at(0.5);
        if depth == 8 || *splits == 0 || middle.2 <= a.2 || middle.2 >= b.2 {
            self.result.push(b);
            return;
        }
        let zmid = (self.profile)(middle.0, middle.1, middle.2);
        let error = [0.25, 0.5, 0.75].into_iter().fold(0.0_f32, |maximum, f| {
            let p = at(f);
            let z = if f == 0.5 {
                zmid
            } else {
                (self.profile)(p.0, p.1, p.2)
            };
            maximum.max((z - (za + (zb - za) * f)).abs())
        });
        if error <= self.tolerance {
            self.result.push(b);
            return;
        }
        *splits -= 1;
        self.interval(a, middle, za, zmid, depth + 1, splits);
        self.interval(middle, b, zmid, zb, depth + 1, splits);
    }
}
