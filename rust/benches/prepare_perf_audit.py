"""Stage disposable instrumented/experimental copies, never edit the live engine.

Run from the repository root: python rust/benches/prepare_perf_audit.py
Outputs live in ignored rust/out/perf-audit. Build commands are in the audit.
"""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import os

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "rust/out/perf-audit"
SOURCE_REF = os.environ.get('PERF_AUDIT_REF', '30422f1e2404d35d83088352fd8cb252bd9eb92d')

def original(path):
    return subprocess.check_output(['git', 'show', f'{SOURCE_REF}:{path}'], cwd=ROOT)


def replace(text, old, new):
    assert text.count(old) == 1, (old[:100], text.count(old))
    return text.replace(old, new)


def stage(name, optimized=False, edges=False, host_math=False, cache_lod=False, lazy_motif=False, fast_cave=False):
    dst = OUT / name
    dst.mkdir(parents=True, exist_ok=True)
    for crate in ("core", "wasm"):
        shutil.copytree(ROOT / f"rust/crates/{crate}", dst / f"crates/{crate}", dirs_exist_ok=True)
    shutil.copy2(ROOT / "rust/Cargo.toml", dst / "Cargo.toml")
    shutil.copy2(ROOT / "rust/Cargo.lock", dst / "Cargo.lock")
    shutil.copy2(ROOT / "rust/rust-toolchain.toml", dst / "rust-toolchain.toml")
    # Keep the original audit reproducible after its optimizations are integrated.
    paths = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', SOURCE_REF,
        'rust/crates/core', 'rust/crates/wasm', 'rust/Cargo.toml', 'rust/Cargo.lock', 'rust/rust-toolchain.toml'], cwd=ROOT, text=True).splitlines()
    for path in paths:
        target = dst / Path(path).relative_to('rust')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(original(path))
    src = dst / "crates/core/src"
    lib = (src / "lib.rs").read_text(encoding="utf-8")
    engine = (src / "engine.rs").read_text(encoding="utf-8")
    erosion = (src / "erosion.rs").read_text(encoding="utf-8")

    if optimized:
        # Linear-time selection returns the exact same order statistic.
        lib = replace(lib, "sorted.sort_unstable_by(f32::total_cmp);\n    let p1 = sorted[(sorted.len() as f64 * 0.01).floor() as usize];",
                      "let index = (sorted.len() as f64 * 0.01).floor() as usize;\n    let p1 = *sorted.select_nth_unstable_by(index, f32::total_cmp).1;")
        # Generate the same unnormalized flat base once, then normalize each
        # branch separately (subtracting normalized fields directly is wrong).
        lib = replace(lib, "fn generate_motif(", "fn generate_motif_base(")
        lib = replace(lib, "    // Historical relief normalization:", "    Ok(PreparedTerrain { height })\n}\n\nfn normalize(mut height: Vec<f32>) -> Result<PreparedTerrain, String> {\n    // Historical relief normalization:")
        lib += "\nfn generate_motif(seed: &str, width: f64, relief: &str, erosion: f64, resolution: usize, motif: f64, mountain_mix: f64) -> Result<PreparedTerrain, String> {\n    normalize(generate_motif_base(seed, width, relief, erosion, resolution, motif, mountain_mix)?.height)\n}\n"
        engine = replace(engine, "        let prepared = if kind == Relief::Cavern {", "        let flat_base = if kind == Relief::Flat && erosion > 0.0 {\n            Some(crate::generate_motif_base(seed, source_width, source_relief, 0.0, SOURCE_N, motif, mountain_mix)?.height)\n        } else { None };\n        let prepared = if let Some(base) = &flat_base {\n            let mut height = base.clone();\n            crate::erosion::erode_shape(&mut height, SOURCE_N, source_width / SOURCE_N as f64, source_erosion, 0.03);\n            crate::normalize(height)?\n        } else if kind == Relief::Cavern {")
        start = engine.index("            let initial = generate_motif(")
        end = engine.index("            prepared", start)
        engine = engine[:start] + "            let initial = crate::normalize(flat_base.unwrap())?;\n" + engine[end:]
        # Avoid a second 16-tap interpolation when the mip weight is exactly zero.
        engine = replace(engine, "        at(lower) * (1.0 - t) + at(upper) * t", "        if t == 0.0 { at(lower) } else { at(lower) * (1.0 - t) + at(upper) * t }")
        # Weight calculation does not depend on sorted traversal. Raster order
        # keeps the neighbor stencil local; ordered accumulation/incision stay.
        erosion = replace(erosion, "        for &c in &order {\n            let mut weights", "        for c in 0..h.len() {\n            let mut weights")

    if edges:
        # Cache identical offset samples. Compare f64 coordinate bits before
        # reuse; algebraically equal coordinates can round differently.
        engine = replace(engine, "        for row in 0..resolution {", "        let mut vertical = vec![(f64::NAN, 0.0_f64); resolution];\n        for row in 0..resolution {\n            let mut horizontal = (f64::NAN, 0.0_f64);")
        start = engine.index("                let gx = (self.height_at(wx + epsilon")
        end = engine.index("                let norm =", start)
        engine = engine[:start] + '''                let left_x = wx - epsilon;
                let right_x = wx + epsilon;
                let upper_y = wy - epsilon;
                let lower_y = wy + epsilon;
                let left = if horizontal.0.to_bits() == left_x.to_bits() { horizontal.1 } else { self.height_at(left_x, wy, cell) };
                let upper = if vertical[col].0.to_bits() == upper_y.to_bits() { vertical[col].1 } else { self.height_at(wx, upper_y, cell) };
                let right = self.height_at(right_x, wy, cell);
                let lower = self.height_at(wx, lower_y, cell);
                horizontal = (right_x, right);
                vertical[col] = (lower_y, lower);
                let gx = (right - left) / (2.0 * epsilon);
                let gy = (lower - upper) / (2.0 * epsilon);
''' + engine[end:]
        engine = replace(engine, "        let rough = fbm(&self.noise, x + self.phase, y, 720.0 * scale, 4);", "        let rough = || fbm(&self.noise, x + self.phase, y, 720.0 * scale, 4);")
        engine = engine.replace("0.065 * rough)", "0.065 * rough())").replace("0.012 * rough)", "0.012 * rough())")

    if lazy_motif:
        lib = replace(lib, "            let rough = noise.fbm((px + offset) / (720.0 * k), py / (720.0 * k), 4);", "            let rough = || noise.fbm((px + offset) / (720.0 * k), py / (720.0 * k), 4);")
        lib = lib.replace("0.08 * rough * wall", "0.08 * rough() * wall").replace("elevation(px, py, erosion, rough,", "elevation(px, py, erosion, rough(),").replace("elevation(px, py, rough,", "elevation(px, py, rough(),")

    if fast_cave:
        # Bounded cave coordinates cannot overflow/underflow the squared norm.
        # This changes f64 rounding; the audit must measure output differences.
        lib = replace(lib, "distance = distance.min((px - chamber.x).hypot(py - chamber.y) - chamber.radius);", "let dx = px - chamber.x;\n            let dy = py - chamber.y;\n            distance = distance.min((dx * dx + dy * dy).sqrt() - chamber.radius);")
        lib = replace(lib, "let d = (px - self.chambers[a].x - t * dx).hypot(py - self.chambers[a].y - t * dy);", "let ex = px - self.chambers[a].x - t * dx;\n            let ey = py - self.chambers[a].y - t * dy;\n            let d = (ex * ex + ey * ey).sqrt();")

    if host_math:
        erosion = replace(erosion, "((h[c] as f64 - h[r] as f64) / distance).max(0.0).powf(1.1)", "crate::profile::pow(((h[c] as f64 - h[r] as f64) / distance).max(0.0), 1.1)")
        manifest = dst / "crates/core/Cargo.toml"
        manifest.write_text(manifest.read_text(encoding="utf-8") + '\n[target.\'cfg(target_arch = "wasm32")\'.dependencies]\nwasm-bindgen = "0.2"\n', encoding="utf-8")

    if cache_lod:
        # Experimental one-entry cache. A deployable implementation should put
        # this constant plan in a per-region context, keeping Surface immutable.
        engine = replace(engine, "struct Surface {\n    levels: Vec<Vec<f32>>,", "struct Surface {\n    cache: std::cell::Cell<Option<(u64, usize, usize, f64)>>,\n    levels: Vec<Vec<f32>>,")
        engine = replace(engine, "return Self { levels: Vec::new() };", "return Self { cache: std::cell::Cell::new(None), levels: Vec::new() };")
        engine = replace(engine, "Self { levels }", "Self { cache: std::cell::Cell::new(None), levels }")
        start = engine.index("        let lod = (footprint * SOURCE_N")
        end = engine.index("        let at =", start)
        engine = engine[:start] + '''        let (lower, upper, t) = match self.cache.get() {
            Some((key, lower, upper, t)) if key == footprint.to_bits() => (lower, upper, t),
            _ => {
                let lod = (footprint * SOURCE_N as f64).max(1.0).log2().min((self.levels.len() - 1) as f64);
                let lower = lod.floor() as usize;
                let upper = (lower + 1).min(self.levels.len() - 1);
                let t = lod - lower as f64;
                self.cache.set(Some((footprint.to_bits(), lower, upper, t)));
                (lower, upper, t)
            }
        };
''' + engine[end:]
        engine = replace(engine, "        let t = lod - lower as f64;\n        if t", "        if t")

    # Profiling exists only in the disposable copies; optimized away on WASM.
    lib = replace(lib, "mod canyon;", "pub mod profile;\nmod canyon;")
    for text_name, function, label in (
        ("lib", "fn generate_motif_base(" if optimized else "fn generate_motif(", "motif total"),
        ("engine", "    pub fn new_mixed(", "prepare total"),
        ("engine", "    pub fn sample_region(", "sample total"),
        ("engine", "    fn new(field:", "pyramid"),
        ("erosion", "fn flood(", "flood"),
        ("erosion", "fn continuous_flow(", "continuous flow"),
        ("erosion", "fn resolve_pits(", "resolve pits"),
        ("erosion", "pub(crate) fn thermal(", "thermal"),
        ("erosion", "pub(crate) fn diffuse(", "diffuse"),
        ("erosion", "pub(crate) fn mountain(", "mountain total"),
        ("erosion", "fn erode_with(", "shape total"),
        ("erosion", "fn erode_shape_coarse(", "shape coarse"),
    ):
        text = {"lib": lib, "engine": engine, "erosion": erosion}[text_name]
        start = text.index(function)
        body = text.index(" {", start) + 2
        text = text[:body] + f'\n    let _profile = crate::profile::span("{label}");' + text[body:]
        if text_name == "lib": lib = text
        elif text_name == "engine": engine = text
        else: erosion = text
    # Timers around coarse phases, with no call per pixel/neighbor.
    erosion = replace(erosion, "        order.sort_unstable_by(", '        let phase = crate::profile::span("shape sort");\n        order.sort_unstable_by(')
    erosion = replace(erosion, "        acc.fill(1.0);\n        // Spread", '        drop(phase);\n        let phase = crate::profile::span("shape weights");\n        acc.fill(1.0);\n        // Spread')
    erosion = replace(erosion, "        for &c in order.iter().rev() {", '        drop(phase);\n        let phase = crate::profile::span("shape accumulation");\n        for &c in order.iter().rev() {')
    erosion = replace(erosion, "        for &c in &order {\n            if border", '        drop(phase);\n        let phase = crate::profile::span("shape incision");\n        for &c in &order {\n            if border')
    erosion = replace(erosion, "        thermal(h, n, cell, talus, 1,", "        drop(phase);\n        thermal(h, n, cell, talus, 1,")
    lib = replace(lib, "    let mut sorted = height.clone();", '    let _percentile = crate::profile::span("normalize");\n    let mut sorted = height.clone();')
    (src / "lib.rs").write_text(lib, encoding="utf-8")
    (src / "engine.rs").write_text(engine, encoding="utf-8")
    (src / "erosion.rs").write_text(erosion, encoding="utf-8")
    (src / "profile.rs").write_text('''
#[cfg(not(target_arch = "wasm32"))]
use std::{cell::RefCell, collections::BTreeMap, time::Instant};
#[cfg(not(target_arch = "wasm32"))]
thread_local! { static TIMES: RefCell<BTreeMap<&'static str, (f64, usize)>> = RefCell::new(BTreeMap::new()); }
pub struct Span {
    #[cfg(not(target_arch = "wasm32"))] name: &'static str,
    #[cfg(not(target_arch = "wasm32"))] started: Instant,
}
pub fn span(_name: &'static str) -> Span {
    Span {
        #[cfg(not(target_arch = "wasm32"))] name: _name,
        #[cfg(not(target_arch = "wasm32"))] started: Instant::now(),
    }
}
#[cfg(not(target_arch = "wasm32"))]
impl Drop for Span {
    fn drop(&mut self) {
        TIMES.with(|t| { let mut t = t.borrow_mut(); let v = t.entry(self.name).or_default(); v.0 += self.started.elapsed().as_secs_f64() * 1000.0; v.1 += 1; });
    }
}
#[cfg(not(target_arch = "wasm32"))]
pub fn take() -> String {
    TIMES.with(|t| { let values = std::mem::take(&mut *t.borrow_mut()); let fields: Vec<_> = values.iter().map(|(k, (ms, count))| format!("\\\"{k}\\\":{{\\\"ms\\\":{ms},\\\"calls\\\":{count}}}")).collect(); format!("{{{}}}", fields.join(",")) })
}
''', encoding="utf-8")
    if host_math:
        with (src / "profile.rs").open("a", encoding="utf-8") as f:
            f.write('''
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = Math, js_name = pow)]
    pub fn pow(x: f64, y: f64) -> f64;
}
#[cfg(not(target_arch = "wasm32"))]
pub fn pow(x: f64, y: f64) -> f64 { x.powf(y) }
''')
    examples = dst / "crates/core/examples"
    examples.mkdir(exist_ok=True)
    (examples / "profile.rs").write_text('''
use burgmap_core::{TerrainGenerator, profile};
use std::time::Instant;
fn main() {
    for relief in ["flat", "hills", "mountains", "mixed", "valley", "plateau", "high-mountains", "volcano", "caldera", "cavern", "canyon"] {
        let start = Instant::now();
        let engine = TerrainGenerator::new("42", 3000.0, relief, 0.5, 3000.0).unwrap();
        let prepare = start.elapsed().as_secs_f64() * 1000.0;
        let stages = profile::take();
        let start = Instant::now();
        let terrain = engine.sample_region(0.0, 0.0, 3000.0, 768).unwrap();
        std::hint::black_box(&terrain);
        println!("{{\\\"relief\\\":\\\"{relief}\\\",\\\"prepareMs\\\":{prepare},\\\"sampleMs\\\":{},\\\"stages\\\":{stages}}}", start.elapsed().as_secs_f64() * 1000.0);
        profile::take();
    }
}
''', encoding="utf-8")
    print(dst)
    write_manifest()


def write_manifest():
    files = list((ROOT / "rust/crates/core/src").glob("*.rs")) + [
        ROOT / "rust/crates/wasm/src/lib.rs", ROOT / "rust/bridge/terrain.ts",
        ROOT / "rust/bridge/terrainRender.ts", ROOT / "web/src/ui/terrainbench.ts",
        ROOT / "web/src/ui/terrainWorker.ts", ROOT / "web/src/render/raster.ts",
        ROOT / "web/src/gen/terrain/contour.ts", ROOT / "rust/Cargo.toml",
    ]
    manifest = {
        "commit": SOURCE_REF,
        "sha256": {str(p.relative_to(ROOT)).replace("\\", "/"): hashlib.sha256(original(str(p.relative_to(ROOT)).replace('\\', '/'))).hexdigest() for p in files},
    }
    (OUT / "source.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


if __name__ == "__main__":
    stage("baseline-dev")
    stage("baseline")
    stage("candidate", optimized=True)
    stage("candidate-edges", optimized=True, edges=True)
    stage("candidate-lod", optimized=True, edges=True, cache_lod=True, lazy_motif=True)
    stage("candidate-math", optimized=True, edges=True, host_math=True, cache_lod=True, lazy_motif=True)
    stage("candidate-cave", optimized=True, edges=True, cache_lod=True, lazy_motif=True, fast_cave=True)
