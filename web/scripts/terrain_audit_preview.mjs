import { createServer, normalizePath } from 'vite';
import { realpathSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const web = resolve(repo, 'web');
const variant = process.argv[2] ?? 'live';
if (!['candidate-lod', 'candidate-cave', 'live'].includes(variant)) throw new Error('Unknown audited variant');
const staged = normalizePath(realpathSync(variant === 'live' ? repo : resolve(repo, 'rust/out/perf-audit', variant)));
function overlay() {
  return {
    name: 'isolated-terrain-audit-preview',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0];
        const file = path === '/precision.html' ? resolve(web, 'scratch/precision-comparison.html')
          : path === '/precision.json' ? resolve(repo, 'rust/out/perf-audit/precision.json')
          : path === '/precision-fp16.html' ? resolve(web, 'scratch/precision-comparison-fp16.html')
          : path === '/precision-fp16.json' ? resolve(repo, 'rust/out/perf-audit/precision-fp16.json') : null;
        if (!file) return next();
        try {
          response.setHeader('Content-Type', path.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8');
          response.end(readFileSync(file));
        } catch {
          response.statusCode = 404;
          response.end('Run node scripts/terrain_precision_audit.mjs first.');
        }
      });
    },
    transform(code, id) {
      if (variant === 'live') return;
      if (!normalizePath(id.split('?')[0]).endsWith('/rust/bridge/terrain.ts')) return;
      return code
        .replace("'../pkg/wasm/burgmap_wasm.js'", `'${staged}/pkg/burgmap_wasm.js'`)
        .replace("'../pkg/wasm/burgmap_wasm_bg.wasm?url&inline'", `'${staged}/pkg/burgmap_wasm_bg.wasm?url&inline'`);
    },
    transformIndexHtml(html) { return html.replace('<title>', '<title>Essai optimisé · '); },
  };
}
const server = await createServer({
  configFile: resolve(web, 'vite.config.ts'),
  root: resolve(web, 'src/ui'),
  mode: 'terrainbench',
  cacheDir: resolve(web, 'node_modules/.vite-terrain-audit'),
  optimizeDeps: { entries: [resolve(web, 'src/ui/terrainbench.html')] },
  plugins: [overlay()],
  worker: { plugins: () => [overlay()] },
  server: { host: '127.0.0.1', port: 5175, strictPort: true, fs: { allow: [repo, staged] } },
});
await server.listen();
console.log(`Audited variant ${variant}: http://localhost:5175/terrainbench.html`);
