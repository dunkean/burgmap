// Real Chrome/WebGPU experiment. Only disposable engine snapshots are exposed.
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const out = resolve(root, 'rust/out/perf-audit');
const shader = await readFile(resolve(root, 'rust/benches/precision_sampler.wgsl'), 'utf8');
const extended = process.argv.includes('--fp16');
const modes = extended ? ['f32', 'f16-field', 'f16-packed', 'f16-interpolation'] : ['f32', 'f16-field'];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', msg => { if (msg.type() === 'error') console.error(msg.text()); });
await page.route('**/perf-audit-assets/**', async route => {
  const relative = decodeURIComponent(new URL(route.request().url()).pathname).replace('/perf-audit-assets/', '');
  const path = resolve(out, relative);
  if (!path.startsWith(out + '\\') && !path.startsWith(out + '/')) throw new Error('Outside audit');
  await route.fulfill({ contentType: extname(path) === '.wasm' ? 'application/wasm' : 'text/javascript', body: await readFile(path) });
});
await page.route('**/precision-empty', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
try {
  await page.goto('http://127.0.0.1:5175/precision-empty');
  await page.evaluate(async ({ root, shader, modes }) => {
    const prefix = '/@fs/' + root.replaceAll('\\', '/');
    const render = await import(prefix + '/rust/bridge/terrainRender.ts');
    const raster = await import(prefix + '/web/src/render/raster.ts');
    const styles = await import(prefix + '/web/src/render/styles.ts');
    const mod = await import('/perf-audit-assets/precision-gpu/pkg/burgmap_wasm.js');
    await mod.default({ module_or_path: await (await fetch('/perf-audit-assets/precision-gpu/pkg/burgmap_wasm_bg.wasm')).arrayBuffer() });
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter?.features.has('shader-f16')) throw new Error('GPU FP16 unavailable');
    const device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] });
    window.gpuErrors = [];
    device.addEventListener('uncapturederror', e => window.gpuErrors.push(e.error.message));
    const info = adapter.info;
    window.gpuInfo = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, fallback: info.isFallbackAdapter };
    const pipelines = {};
    const compileStart = performance.now();
    for (const mode of modes) {
      const packedOutput = mode === 'f16-packed';
      let code = (mode !== 'f32' ? 'enable f16;\n' : '') + shader.replaceAll('FIELD_TYPE', mode === 'f32' ? 'f32' : 'f16').replaceAll('OUT_TYPE', packedOutput ? 'f16' : 'f32');
      if (mode === 'f16-interpolation') {
        code = code.replace('let wx=weights(pos.x-f32(origin.x)); let wy=weights(pos.y-f32(origin.y));',
          'let wx=vec4<f16>(weights(pos.x-f32(origin.x))); let wy=vec4<f16>(weights(pos.y-f32(origin.y)));');
        code = code.replace('var value=0.0;', 'var value=f16(0.0);')
          .replace('value+=f32(field[offset+row*n+col])*wx[i]*wy[j];', 'value+=field[offset+row*n+col]*wx[i]*wy[j];')
          .replace('return value;', 'return f32(value);');
      }
      const module = device.createShaderModule({ code });
      const compilation = await module.getCompilationInfo();
      const failures = compilation.messages.filter(m => m.type === 'error');
      if (failures.length) throw new Error(JSON.stringify(failures.map(m => ({ message: m.message, line: m.lineNum }))));
      pipelines[mode] = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    }
    window.compileMs = performance.now() - compileStart;
    function upload(array, usage = GPUBufferUsage.STORAGE) {
      const buffer = device.createBuffer({ size: Math.max(4, Math.ceil(array.byteLength / 4) * 4), usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, array); return buffer;
    }
    // IEEE round-to-nearest-even; conversion is deliberately outside warmed sampling.
    function halfArray(values) {
      const out = new Uint16Array(values.length + (values.length % 2));
      const scratch = new Float32Array(1), bits = new Uint32Array(scratch.buffer);
      for (let i = 0; i < values.length; i++) {
        scratch[0] = values[i]; const b = bits[0], sign = (b >>> 16) & 0x8000;
        const e = ((b >>> 23) & 255) - 127;
        let mant = b & 0x7fffff;
        if (e > 15) out[i] = sign | 0x7c00;
        else if (e < -25) out[i] = sign;
        else {
          let exp = e + 15, shift = 13;
          if (e < -14) { mant |= 0x800000; shift = -e - 1; exp = 0; }
          let m = mant >>> shift;
          const rest = mant & ((1 << shift) - 1), halfway = 1 << (shift - 1);
          if (rest > halfway || (rest === halfway && (m & 1))) m++;
          out[i] = sign | ((exp << 10) + m);
        }
      }
      return out;
    }
    function pixels(data, style = 'parchment') {
      const n = data.resolution, cell = data.width / n;
      return raster.renderTerrainPixels({ mapSize: data.width, terrain: { height: { w: n, h: n, cell, data: data.height }, water: new Uint8Array(n * n) } },
        { ...styles.PALETTES[style], hatch: 0, grain: 0 }, { pixels: n, surface: data.height, normals: { x: data.normalX, y: data.normalY, z: data.normalZ }, heightRange: { min: data.globalMinHeight, max: data.globalMaxHeight }, exaggeration: 2 }).rgb;
    }
    function compare(ref, actual) {
      let heightMax = 0, heightSq = 0, normalMax = 0, angleMax = 0, angleSq = 0;
      const count = ref.height.length;
      for (let i = 0; i < count; i++) {
        const d = Math.abs(ref.height[i] - actual.height[i]); heightMax = Math.max(heightMax, d); heightSq += d*d;
        let dot = 0, normA = 0, normB = 0;
        for (const key of ['normalX', 'normalY', 'normalZ']) {
          normalMax = Math.max(normalMax, Math.abs(ref[key][i] - actual[key][i]));
          dot += ref[key][i] * actual[key][i]; normA += ref[key][i] ** 2; normB += actual[key][i] ** 2;
        }
        const angle = Math.acos(Math.min(1, Math.max(-1, dot / Math.sqrt(normA * normB)))) * 180 / Math.PI;
        angleMax = Math.max(angleMax, angle); angleSq += angle*angle;
      }
      const pixelStats = {};
      for (const style of ['parchment', 'atlas', 'topographic']) {
        const a = pixels(ref, style), b = pixels(actual, style);
        let maxChannel = 0, sumSq = 0, changed = 0, over2 = 0, over8 = 0;
        for (let i = 0; i < count; i++) {
          let maxPixel = 0;
          for (let k = 0; k < 3; k++) { const d = Math.abs(a[i*3+k] - b[i*3+k]); maxPixel = Math.max(maxPixel,d); sumSq += d*d; }
          maxChannel = Math.max(maxChannel,maxPixel); if (maxPixel) changed++; if (maxPixel >= 2) over2++; if (maxPixel >= 8) over8++;
        }
        pixelStats[style] = { maxChannel, rms: Math.sqrt(sumSq / a.length), changedPercent: changed / count * 100, over2Percent: over2 / count * 100, over8Percent: over8 / count * 100 };
      }
      return { heightMaxM: heightMax, heightRmsM: Math.sqrt(heightSq / count), normalComponentMax: normalMax, normalAngleMaxDeg: angleMax, normalAngleRmsDeg: Math.sqrt(angleSq / count), pixels: pixelStats };
    }
    window.precisionScenes = [];
    window.precisionCase = async spec => {
      const { relief, seed, map = 3000, motif = 3000, x = 0, y = 0, extent = map, n = 768, save = false } = spec;
      let start = performance.now();
      const engine = new mod.TerrainEngine(seed, map, relief, 0.5, motif, 0.5);
      const prepareMs = performance.now() - start;
      start = performance.now(); const result = engine.sample_region(x,y,extent,n); const cpuSampleMs = performance.now() - start;
      const ref = { x, y, width: extent, resolution: n, minHeight: result.min_height, maxHeight: result.max_height, globalMinHeight: engine.min_height, globalMaxHeight: engine.max_height, motifSize: motif, height: result.height, caveMask: result.cave_mask, normalX: result.normal_x, normalY: result.normal_y, normalZ: result.normal_z, generationMs: 0 };
      result.free();
      start = performance.now();
      const field = engine.gpu_field(), params = engine.gpu_parameters();
      const permutation = engine.gpu_permutations(), gradients = engine.gpu_gradients();
      const snapshotMs = performance.now() - start;
      engine.free();
      const cell = extent/n, eps = Math.max(motif/65536, cell*0.5);
      const lod = Math.min(10, Math.log2(Math.max(1,cell*(relief === 'flat' ? 2/motif : 1/map)*1024)));
      const uniform = new Float32Array([...params.slice(0,4),params[4],params[5],field.length ? 1 : 0,n,x,y,extent,cell,Math.floor(lod),Math.min(10,Math.floor(lod)+1),lod-Math.floor(lod),eps]);
      const variants = [];
      const resources = [];
      const permBuffer = upload(permutation), gradientBuffer = upload(gradients), uniformBuffer = upload(uniform,GPUBufferUsage.UNIFORM);
      resources.push(permBuffer,gradientBuffer,uniformBuffer);
      if (save) window.precisionScenes.push({ title: `${relief}, ${seed}, ${extent} m : référence CPU`, width: extent, svg: render.renderRustTerrain(ref, 'parchment', false).svg });
      for (const mode of modes) {
        const packedOutput = mode === 'f16-packed';
        if (packedOutput && typeof Float16Array === 'undefined') throw new Error('Native Float16Array unavailable for packed readback');
        const outputBytes = n*n*(packedOutput ? 8 : 16);
        start = performance.now();
        const values = mode === 'f32' ? (field.length ? field : new Float32Array(1)) : halfArray(field.length ? field : new Float32Array(1));
        const fieldBuffer = upload(values);
        const output = device.createBuffer({ size: outputBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const readback = device.createBuffer({ size: outputBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const pipeline = pipelines[mode];
        const bindings = [uniformBuffer,fieldBuffer,permBuffer,gradientBuffer,output].map((buffer,binding) => ({ binding, resource: { buffer } }));
        const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: bindings });
        await device.queue.onSubmittedWorkDone();
        const uploadMs = performance.now() - start;
        const repetitions = [];
        let packed;
        for (let repeat = 0; repeat < 6; repeat++) {
          start = performance.now();
          const commands = device.createCommandEncoder();
          const pass = commands.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0,group); pass.dispatchWorkgroups(Math.ceil(n/8),Math.ceil(n/8)); pass.end();
          commands.copyBufferToBuffer(output,0,readback,0,outputBytes);
          device.queue.submit([commands.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const bytes = readback.getMappedRange().slice(0);
          packed = packedOutput ? new Float16Array(bytes) : new Float32Array(bytes); readback.unmap();
          repetitions.push(performance.now() - start);
        }
        const actual = { ...ref, height: new Float32Array(n*n), normalX: new Float32Array(n*n), normalY: new Float32Array(n*n), normalZ: new Float32Array(n*n) };
        start = performance.now();
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < n*n; i++) {
          actual.height[i]=packed[i*4]; actual.normalX[i]=packed[i*4+1]; actual.normalY[i]=packed[i*4+2]; actual.normalZ[i]=packed[i*4+3]; min=Math.min(min,actual.height[i]); max=Math.max(max,actual.height[i]);
        }
        actual.minHeight=min; actual.maxHeight=max;
        const unpackMs=performance.now()-start;
        if (save) window.precisionScenes.push({ title: `${relief}, ${seed}, ${extent} m : GPU ${mode}`, width: extent, svg: render.renderRustTerrain(actual, 'parchment', false).svg });
        variants.push({ mode, outputBytes, fieldBytes: values.byteLength, uploadMs, firstSampleMs: repetitions[0], warmedSampleMs: repetitions.slice(1).sort((a,b)=>a-b)[2], repetitions, unpackMs, ...compare(ref,actual) });
        fieldBuffer.destroy(); output.destroy(); readback.destroy();
      }
      resources.forEach(buffer=>buffer.destroy());
      return { ...spec, map, motif, x, y, extent, n, prepareMs, snapshotMs, cpuSampleMs, variants };
    };
  }, { root, shader, modes });
  const results = [];
  const cases = [
    { relief: 'flat', seed: '42', save: true }, { relief: 'flat', seed: '1' }, { relief: 'flat', seed: '1a72a9n' },
    { relief: 'mountains', seed: '42', save: true }, { relief: 'mountains', seed: '1a72a9n' },
    { relief: 'flat', seed: '1a72a9n', map: 8000, x: 2911.19, y: 4107.23, extent: 48.5 },
    { relief: 'flat', seed: '1a72a9n', map: 8000, x: 4100.1, y: 3999.3, extent: 8, save: true },
    { relief: 'mountains', seed: '1a72a9n', map: 8000, x: 2911.19, y: 4107.23, extent: 48.5 },
    { relief: 'mountains', seed: '1a72a9n', map: 8000, x: 4100.1, y: 3999.3, extent: 8, save: true },
  ];
  for (const spec of cases) {
    const result = await page.evaluate(spec => window.precisionCase(spec), spec); results.push(result);
    console.log(JSON.stringify({ relief: spec.relief, seed: spec.seed, extent: result.extent, cpu: result.cpuSampleMs, variants: result.variants.map(v=>({ mode:v.mode, ms:v.warmedSampleMs, h:v.heightMaxM, angle:v.normalAngleMaxDeg, pixel:v.pixels.parchment })) }));
  }
  const metadata = await page.evaluate(() => ({ adapter: window.gpuInfo, compileMs: window.compileMs, gpuErrors: window.gpuErrors, scenes: window.precisionScenes }));
  const { scenes, ...rest } = metadata;
  const suffix = extended ? '-fp16' : '';
  await writeFile(resolve(out,`precision${suffix}.json`),JSON.stringify({ browser: browser.version(),...rest,errors,results },null,2));
  const columns = modes.length + 1;
  const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Comparaison précision terrain</title><style>body{font:16px system-ui;background:#25252a;color:#eee;margin:24px}section{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:32px}h1{font-size:24px}h2{font-size:15px}svg{display:block;width:100%;background:#d8cbb2}p{max-width:1000px}article{min-width:0}</style><h1>Terrain actuel · GPU FP32 · champ stocké en FP16</h1><p>Érosion identique calculée sur CPU. Échantillonnage GPU en FP32 ; la troisième colonne réduit seulement le stockage des champs à FP16. Même rendu et mêmes courbes de niveau. Mesures et graines : precision.json. Les valeurs de zoom extrême testent aussi les limites de précision des coordonnées.</p>${scenes.map((s,i)=>`${i%3===0?'<section>':''}<article><h2>${s.title}</h2><svg viewBox="0 0 ${s.width} ${s.width}">${s.svg}</svg></article>${i%3===2?'</section>':''}`).join('')}</html>`;
  const extendedHtml = extended ? html.replace('repeat(3,minmax(0,1fr))','repeat(5,minmax(220px,1fr))')
    .replace('Terrain actuel · GPU FP32 · champ stocké en FP16','Terrain actuel · GPU FP32 · stockage FP16 · sortie FP16 · interpolation FP16')
    .replace('la troisième colonne réduit seulement le stockage des champs à FP16.', 'les variantes comparent le stockage FP16, une sortie hauteur/normales FP16, puis une accumulation de B-spline FP16. Les coordonnées et les dérivées restent FP32.')
    .replace(/<section>[\s\S]*<\/section>/, scenes.map((s,i)=>`${i%columns===0?'<section>':''}<article><h2>${s.title}</h2><svg viewBox="0 0 ${s.width} ${s.width}">${s.svg}</svg></article>${i%columns===columns-1?'</section>':''}`).join('')) : html;
  await writeFile(resolve(root,`web/scratch/precision-comparison${suffix}.html`),extendedHtml);
  if (errors.length || rest.gpuErrors.length) throw new Error(JSON.stringify({ errors, gpuErrors: rest.gpuErrors }));
  console.log(JSON.stringify({ adapter: rest.adapter, compileMs: rest.compileMs, cases: results.length, errors }));
} finally { await browser.close(); }
