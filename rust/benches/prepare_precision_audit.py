"""Export retained fields from a disposable engine for GPU precision experiments."""
from prepare_perf_audit import stage, replace, OUT

stage('precision-gpu', optimized=True, edges=True, cache_lod=True, lazy_motif=True)
dst = OUT / 'precision-gpu'
core = dst / 'crates/core/src'
noise = (core / 'noise.rs').read_text(encoding='utf-8')
noise = noise.replace('    perm: [u8; 512],', '    pub(crate) perm: [u8; 512],')
noise = noise.replace('    gradients: [(f64, f64); 32],', '    pub(crate) gradients: [(f64, f64); 32],')
(core / 'noise.rs').write_text(noise, encoding='utf-8')
engine = (core / 'engine.rs').read_text(encoding='utf-8')
engine = replace(engine, '    pub fn width(&self) -> f64 {', '''    pub fn gpu_field(&self) -> Vec<f32> {
        let field = if self.relief == Relief::Flat { &self.delta } else { &self.source };
        field.levels.iter().flatten().copied().collect()
    }
    pub fn gpu_parameters(&self) -> Vec<f64> {
        vec![self.map_width, self.motif, self.phase, self.amp, self.max_height,
             if self.relief == Relief::Flat { 0.0 } else { 1.0 }]
    }
    pub fn gpu_permutations(&self) -> Vec<u32> {
        self.noise.perm.iter().chain(self.noise2.perm.iter()).map(|&v| v as u32).collect()
    }
    pub fn gpu_gradients(&self) -> Vec<f32> {
        self.noise.gradients.iter().chain(self.noise2.gradients.iter()).flat_map(|&(x,y)| [x as f32,y as f32]).collect()
    }
    pub fn width(&self) -> f64 {''')
(core / 'engine.rs').write_text(engine, encoding='utf-8')
wasm = dst / 'crates/wasm/src/lib.rs'
text = wasm.read_text(encoding='utf-8')
text = replace(text, '    pub fn sample_region(', '''    pub fn gpu_field(&self) -> Vec<f32> { self.generator.gpu_field() }
    pub fn gpu_parameters(&self) -> Vec<f64> { self.generator.gpu_parameters() }
    pub fn gpu_permutations(&self) -> Vec<u32> { self.generator.gpu_permutations() }
    pub fn gpu_gradients(&self) -> Vec<f32> { self.generator.gpu_gradients() }
    pub fn sample_region(''')
wasm.write_text(text, encoding='utf-8')
print(dst)
