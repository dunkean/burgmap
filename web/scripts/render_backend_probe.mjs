// Frozen-World diagnostics; no generation, no application handoff changes.
// --world JSON typed-array fixture --baseline ../baseline/web --out ignored-directory
// Transport completion is verified with a native screenshot marker. Its wall time includes
// screenshot readback and is separate from the two-RAF scheduling proxy and worker CPU time.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { inflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const source = resolve(arg('--source', '.')), baseline = resolve(arg('--baseline', source));
const out = resolve(arg('--out', 'out/render-backend-probe'));
const fixture = arg('--world', '');
const dpr = Number(arg('--dpr', '1'));
if (![1, 2].includes(dpr)) throw new Error('DPR must be 1 or 2');
mkdirSync(out, { recursive: true });
const worldJson = fixture ? readFileSync(resolve(fixture)) : null;
const server = await createServer({ configFile: false, root: source,
  server: { host: '127.0.0.1', port: 0, fs: { allow: [dirname(source), dirname(baseline)] } },
  plugins: [{ name: 'frozen-render-probe', configureServer(server) {
    server.middlewares.use('/__probe', (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><body style="margin:0"><canvas id="display" width="900" height="700" style="width:900px;height:700px"></canvas></body></html>');
    });
    server.middlewares.use('/__world', (_request, response) => {
      response.setHeader('Content-Type', 'application/json'); response.end(worldJson ?? 'null');
    });
  } }] });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const moduleUrl = (root, path) => `${base}/@fs/${root.replaceAll('\\', '/')}/${path}`;
const browser = await chromium.launch({ headless: true, ...(arg('--channel', '') ? { channel: arg('--channel', '') } : {}) });
const cdp = await browser.newBrowserCDPSession();
const gpu = await cdp.send('SystemInfo.getInfo').then(info => info.gpu).catch(() => null);
const context = await browser.newContext({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: dpr });
const page = await context.newPage(), errors = [], results = { browser: browser.version(), gpu, dpr, fixture, source, baseline, errors,
  metricLimits: 'Ordered parity draws share candidate caches; preparation and cold draw times are diagnostic, not independent A/B. Screenshot verification includes native capture cost. GPU prototype isolates one retained viewport texture.' };
page.on('pageerror', error => errors.push(error.message));

// Chrome screenshots are 8-bit noninterlaced RGB/RGBA PNGs. Decode one pixel without adding a dependency.
function markerPixel(png, x, y) {
  let width = 0, channels = 0; const compressed = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + size);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (data[8] !== 8 || data[12] !== 0 || !channels) throw new Error('Unsupported screenshot PNG');
    }
    if (type === 'IDAT') compressed.push(data); offset += size + 12;
  }
  const raw = inflateSync(Buffer.concat(compressed)), stride = width * channels;
  let previous = Buffer.alloc(stride), cursor = 0;
  const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
  for (let row = 0; row <= y; row++) {
    const filter = raw[cursor++], current = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? current[i - channels] : 0, b = previous[i], c = i >= channels ? previous[i - channels] : 0;
      current[i] = (raw[cursor++] + (filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : NaN)) & 255;
      if (filter > 4) throw new Error('Invalid PNG filter');
    }
    previous = current;
  }
  return Array.from(previous.subarray(x * channels, x * channels + 3));
}

try {
  await page.goto(base + '/__probe');
  await page.evaluate(async ({ canvasUrl, sceneUrl, cacheUrl, baselineCanvasUrl, baselineSceneUrl, fakeUrl, dpr }) => {
    const { createCanvasRenderer } = await import(canvasUrl), { buildScene } = await import(sceneUrl), { SceneBuilder } = await import(cacheUrl);
    const { createCanvasRenderer: createBaselineRenderer } = await import(baselineCanvasUrl), { buildScene: buildBaselineScene } = await import(baselineSceneUrl);
    const constructors = { Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array };
    let world = await fetch('/__world').then(r => r.text()).then(text => JSON.parse(text, (_key, value) => value?.__typed && constructors[value.__typed] ? new constructors[value.__typed](value.data) : value));
    if (!world) { const { fakeWorld } = await import(fakeUrl); world = fakeWorld({ mapSize: 2400, buildings: 3000, streets: 300, landAreas: 100 }); }
    world.options.labels = false; world.options.legend = false;
    const baselineStart = performance.now(), baselineScene = buildBaselineScene(world), baselineMs = performance.now() - baselineStart;
    const legacyStart = performance.now(), legacy = buildScene(world), legacyMs = performance.now() - legacyStart;
    const builder = new SceneBuilder(), start = performance.now(), scene = builder.update(world);
    const preparation = { baselineMs, wholeRebuildMs: legacyMs, incrementalMs: performance.now() - start, stats: { ...builder.stats } };
    const display = document.querySelector('#display'); display.width = 900 * dpr; display.height = 700 * dpr;
    const canvas = () => new OffscreenCanvas(900 * dpr, 700 * dpr);
    const center = world.site?.center ?? world.urban?.macro?.center ?? { x: world.mapSize / 2, y: world.mapSize / 2 };
    const create = (target, selectedScene, raster, style) => {
      const renderer = createCanvasRenderer(target, world, style, { scene: selectedScene, raster, dpr });
      renderer.setOverlays({ labels: false, legend: false, cartouche: false }); return renderer;
    };
    const createBaseline = (target, style) => {
      const renderer = createBaselineRenderer(target, world, style, { scene: baselineScene, dpr });
      renderer.setOverlays({ labels: false, legend: false, cartouche: false }); return renderer;
    };
    const diff = (a, b) => {
      let total = 0, changed = 0, large = 0, max = 0;
      for (let i = 0; i < a.length; i += 4) {
        let pixel = 0; for (let c = 0; c < 3; c++) { const e = Math.abs(a[i + c] - b[i + c]); total += e; max = Math.max(max, e); pixel = Math.max(pixel, e); }
        if (pixel) changed++; if (pixel > 24) large++;
      }
      return { meanAbsoluteChannelError: total / (a.length / 4 * 3), changedFraction: changed / (a.length / 4), largeFraction: large / (a.length / 4), max };
    };
    const pixels = target => target.getContext('2d').getImageData(0, 0, target.width, target.height).data;
    const show = target => { const ctx = display.getContext('2d'); ctx.clearRect(0, 0, display.width, display.height); ctx.drawImage(target, 0, 0); };
    window.probe = { world, scene, legacy, preparation, center, create, createBaseline, canvas, diff, pixels, show, dpr, active: [] };
  }, { canvasUrl: moduleUrl(source, 'src/render/canvas.ts'), sceneUrl: moduleUrl(source, 'src/render/scene.ts'), cacheUrl: moduleUrl(source, 'src/render/sceneCache.ts'), baselineCanvasUrl: moduleUrl(baseline, 'src/render/canvas.ts'), baselineSceneUrl: moduleUrl(baseline, 'src/render/scene.ts'), fakeUrl: moduleUrl(source, 'scripts/fakeworld.ts'), dpr });
  results.preparation = await page.evaluate(() => probe.preparation);
  if (!args.includes('--transport-only')) {
    results.parity = [];
    for (const style of arg('--styles', 'parchment,night,engraving').split(',')) {
      await page.evaluate(style => {
        const p = probe, original = p.canvas(), a = p.canvas(), b = p.canvas(), c = p.canvas();
        p.active = [p.createBaseline(original, style), p.create(a, p.legacy, false, style), p.create(b, p.scene, false, style), p.create(c, p.scene, true, style)]; p.targets = [original, a, b, c];
      }, style);
      for (const scale of [0.6, 1.5]) for (const pan of [0, 0.375, 2]) {
        const record = await page.evaluate(({ scale, pan }) => {
          const p = probe, view = { cx: p.center.x + pan, cy: p.center.y + pan, scale }, frames = [];
          for (let i = 0; i < 4; i++) { const start = performance.now(), stats = p.active[i].draw(view), drawn = performance.now(); const bytes = p.pixels(p.targets[i]); frames.push({ stats, drawMs: drawn - start, flushMs: performance.now() - drawn, bytes }); }
          p.show(p.targets[3]);
          return { scale, pan, frames: frames.map(({ bytes, ...frame }) => frame), wholeRebuildVsBaseline: p.diff(frames[0].bytes, frames[1].bytes), incrementalVsBaseline: p.diff(frames[0].bytes, frames[2].bytes), incrementalVsLegacy: p.diff(frames[1].bytes, frames[2].bytes), rasterVsVector: p.diff(frames[2].bytes, frames[3].bytes) };
        }, { scale, pan });
        results.parity.push({ style, ...record });
        if (pan === 0.375) {
          await page.screenshot({ path: resolve(out, `${style}-${scale}-raster-dpr${dpr}.png`) });
          await page.evaluate(() => probe.show(probe.targets[2]));
          await page.screenshot({ path: resolve(out, `${style}-${scale}-vector-dpr${dpr}.png`) });
          await page.evaluate(() => probe.show(probe.targets[0]));
          await page.screenshot({ path: resolve(out, `${style}-${scale}-baseline-dpr${dpr}.png`) });
        }
        console.log(`PARITY ${style} ${scale} pan=${pan}: scene=${record.incrementalVsLegacy.meanAbsoluteChannelError.toFixed(3)}, raster=${record.rasterVsVector.meanAbsoluteChannelError.toFixed(3)}`);
      }
      await page.evaluate(() => probe.active.forEach(r => r.dispose()));
    }
  }
  if (args.includes('--transport')) {
    results.transport = [];
    for (const mode of ['baseline-bitmap', 'cached-bitmap', 'cached-direct', ...(args.includes('--gpu') ? ['retained-gpu-prototype'] : [])]) {
      // A new visible surface per transport avoids transferring an already attached canvas context.
      await page.evaluate(() => { document.querySelector('#display').remove(); const c = document.createElement('canvas'); c.id = 'display'; c.style.cssText = 'width:900px;height:700px'; document.body.append(c); });
      await page.evaluate(async ({ mode, canvasUrl, sceneUrl, cacheUrl, dpr }) => {
        const prototype = mode === 'retained-gpu-prototype';
        const direct = mode === 'cached-direct' || prototype;
        // This GPU prototype retains one padded viewport texture and static quad buffer. It isolates
        // texture composition from the initial Canvas raster cost, and supports only small same-LOD pans.
        // It does not implement world tiles, geometry buffers, updates, labels, or application handoff.
        const gpuCode = prototype ? `
          let gl, program, sourceCanvas, retainedView, uploadMs=0;
          const shader=(kind,code)=>{ const s=gl.createShader(kind);gl.shaderSource(s,code);gl.compileShader(s);
            if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));return s; };
          function initGpu(visible,dpr){
            gl=visible.getContext('webgl2',{alpha:false,antialias:false,preserveDrawingBuffer:true});
            if(!gl) throw new Error('WebGL2 unavailable');
            const vs=shader(gl.VERTEX_SHADER,'#version 300 es\\n in vec2 position; out vec2 uv; uniform vec2 crop; uniform vec2 offset; void main(){gl_Position=vec4(position,0,1);uv=(position*.5+.5)*crop+offset;}');
            const fs=shader(gl.FRAGMENT_SHADER,'#version 300 es\\n precision highp float; in vec2 uv; uniform sampler2D image; out vec4 color; void main(){color=texture(image,uv);}');
            program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
            if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
            gl.useProgram(program);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
            gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
            const location=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,2,gl.FLOAT,false,0,0);
            const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);sourceCanvas=new OffscreenCanvas(1028*dpr,828*dpr);
            return sourceCanvas;
          }
          function drawGpu(m){
            if(!retainedView || retainedView.scale!==m.view.scale) {
              renderer.draw(m.view);const start=performance.now();gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,sourceCanvas);
              uploadMs=performance.now()-start;retainedView=m.view;
            }else uploadMs=0;
            const dx=(m.view.cx-retainedView.cx)*m.view.scale*${dpr},dy=(m.view.cy-retainedView.cy)*m.view.scale*${dpr};
            if(Math.abs(dx)>64*${dpr} || Math.abs(dy)>64*${dpr}) throw new Error('GPU viewport prototype exceeded retained gutter');
            gl.viewport(0,0,canvas.width,canvas.height);gl.useProgram(program);
            gl.uniform2f(gl.getUniformLocation(program,'crop'),canvas.width/sourceCanvas.width,canvas.height/sourceCanvas.height);
            gl.uniform2f(gl.getUniformLocation(program,'offset'),(64*${dpr}+dx)/sourceCanvas.width,(64*${dpr}-dy)/sourceCanvas.height);
            gl.drawArrays(gl.TRIANGLES,0,6);
            gl.enable(gl.SCISSOR_TEST);gl.scissor(0,canvas.height-20,20,20);gl.clearColor(...m.color.map(v=>v/255),1);gl.clear(gl.COLOR_BUFFER_BIT);gl.disable(gl.SCISSOR_TEST);gl.flush();
            return {prototype:true,uploadMs};
          }` : '';
        const code = `import { createCanvasRenderer } from ${JSON.stringify(canvasUrl)};
          import { buildScene } from ${JSON.stringify(sceneUrl)};
          ${mode === 'baseline-bitmap' ? '' : `import { SceneBuilder } from ${JSON.stringify(cacheUrl)};`}
          let canvas, renderer;
          ${gpuCode}
          self.onmessage = e => { const m=e.data;
            try { if(m.type==='init') { canvas=m.canvas??new OffscreenCanvas(900*m.dpr,700*m.dpr);
              const scene=${mode === 'baseline-bitmap' ? 'buildScene(m.world)' : 'new SceneBuilder().update(m.world)'};
              renderer=createCanvasRenderer(${prototype ? 'initGpu(canvas,m.dpr)' : 'canvas'},m.world,'parchment',{scene,dpr:m.dpr}); renderer.setOverlays({labels:false,legend:false,cartouche:false}); self.postMessage({type:'ready'}); return; }
              const start=performance.now(), stats=${prototype ? 'drawGpu(m)' : 'renderer.draw(m.view)'}, drawn=performance.now();
              ${prototype ? '' : "const ctx=canvas.getContext('2d');ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.fillStyle='rgb('+m.color.join(',')+')';ctx.fillRect(0,0,20,20);"}
              const bitmap=${direct ? 'undefined' : 'canvas.transferToImageBitmap()'};
              self.postMessage({type:'frame',seq:m.seq,stats,drawMs:drawn-start,transferMs:performance.now()-drawn,bitmap},bitmap?[bitmap]:[]);
            } catch(error) {self.postMessage({type:'error',error:String(error.stack??error)});} };`;
        const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), { type: 'module' });
        const c = document.querySelector('#display'); c.width = 900 * dpr; c.height = 700 * dpr;
        const ctx = direct ? null : c.getContext('bitmaprenderer');
        window.transport = { worker, records: [], ctx };
        const ready = new Promise((ok, reject) => { worker.onmessage = e => { if (e.data.type === 'ready') ok(); if (e.data.type === 'error') reject(new Error(e.data.error)); }; worker.onerror = reject; });
        const offscreen = direct ? c.transferControlToOffscreen() : undefined;
        worker.postMessage({ type: 'init', world: probe.world, dpr, canvas: offscreen }, offscreen ? [offscreen] : []); await ready;
        worker.onmessage = e => {
          const m = e.data; if (m.type === 'error') throw new Error(m.error);
          if (m.bitmap) ctx.transferFromImageBitmap(m.bitmap);
          const record = { ...m, bitmap: !!m.bitmap, received: performance.now() }; transport.records.push(record);
          requestAnimationFrame(() => requestAnimationFrame(() => { record.rafProxy = performance.now(); }));
        };
      }, { mode, canvasUrl: moduleUrl(mode === 'baseline-bitmap' ? baseline : source, 'src/render/canvas.ts'), sceneUrl: moduleUrl(mode === 'baseline-bitmap' ? baseline : source, 'src/render/scene.ts'), cacheUrl: moduleUrl(source, 'src/render/sceneCache.ts'), dpr });
      for (let seq = 1; seq <= 4; seq++) {
        const color = [30 + seq * 40, 60, 160], start = Date.now();
        const browserStart = await page.evaluate(({ seq, color }) => { const t = performance.now(); transport.worker.postMessage({ type: 'draw', seq, color, view: { cx: probe.center.x + seq * 0.375, cy: probe.center.y, scale: 1.5 } }); return t; }, { seq, color });
        await page.waitForFunction(seq => transport.records.some(r => r.seq === seq && r.rafProxy), seq, { timeout: 120000 });
        let verified = false;
        while (Date.now() - start < 120000) {
          const png = await page.screenshot({ clip: { x: 0, y: 0, width: 12, height: 12 }, animations: 'disabled' });
          if (markerPixel(png, 6 * dpr, 6 * dpr).every((c, i) => c === color[i])) { verified = true; break; }
        }
        const record = await page.evaluate(seq => transport.records.find(r => r.seq === seq), seq);
        results.transport.push({ mode, seq, ...record, receiveMs: record.received - browserStart, rafProxyMs: record.rafProxy - browserStart, screenshotVerifiedMs: Date.now() - start, verified });
        if (!verified) throw new Error(`Visible marker did not arrive: ${mode}/${seq}`);
        console.log(`TRANSPORT ${mode} ${seq}: worker ${(record.drawMs + record.transferMs).toFixed(1)}ms, captured ${Date.now() - start}ms`);
      }
      await page.screenshot({ path: resolve(out, `transport-${mode}-dpr${dpr}.png`) });
      await page.evaluate(() => transport.worker.terminate());
    }
  }
} finally {
  writeFileSync(resolve(out, `backend-probe-dpr${dpr}.json`), JSON.stringify(results, null, 2));
  await browser.close(); await server.close();
}
if (errors.length) throw new Error(errors.join('\n'));
