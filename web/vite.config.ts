import { defineConfig, normalizePath, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const vendorNotice = '/*! polygon-clipping 0.15.7\n' + readFileSync(new URL('./src/vendor/polygonClipping.LICENSE.md', import.meta.url), 'utf8') + '\n*/';

function terrainWasmReload(): Plugin {
  const packageDir = normalizePath(fileURLToPath(new URL('../rust/pkg/wasm/', import.meta.url)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    name: 'terrain-wasm-reload',
    apply: 'serve',
    configureServer(server) {
      // Inline URL assets outside Vite's root are not automatically watched.
      server.watcher.add(packageDir);
      server.httpServer?.once('close', () => clearTimeout(timer));
    },
    handleHotUpdate({ file, server }) {
      if (!normalizePath(file).startsWith(packageDir) || !/\.(js|wasm)$/.test(file)) return;
      // wasm-pack writes the binary and bindings separately. Reload the pair
      // together, including cached inline assets and the worker's imports.
      clearTimeout(timer);
      timer = setTimeout(() => {
        server.moduleGraph.invalidateAll();
        server.ws.send({ type: 'full-reload', path: '*' });
      }, 200);
      return [];
    },
  };
}

export default defineConfig(({ mode }) => ({
  root: 'src/ui',
  plugins: [viteSingleFile(), ...(mode === 'terrainbench' ? [terrainWasmReload()] : [])],
  // Keep third-party notices inside the self-contained offline bundle.
  esbuild: { legalComments: 'inline' },
  server: mode === 'terrainbench' ? { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } } : undefined,
  build: {
    target: 'es2022',
    outDir: mode === 'terrainbench' ? fileURLToPath(new URL('../rust/out/browser', import.meta.url)) : '../../dist',
    emptyOutDir: mode !== 'testbench',
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      ...(mode === 'testbench' ? { input: 'src/ui/testbench.html' } : {}),
      ...(mode === 'terrainbench' ? { input: 'src/ui/terrainbench.html' } : {}),
      output: { banner: vendorNotice },
    },
  },
  worker: { format: 'es', rollupOptions: { output: { banner: vendorNotice } } },
}));
