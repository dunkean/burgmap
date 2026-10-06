import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';

const vendorNotice = '/*! polygon-clipping 0.15.7\n' + readFileSync(new URL('./src/vendor/polygonClipping.LICENSE.md', import.meta.url), 'utf8') + '\n*/';

export default defineConfig(({ mode }) => ({
  root: 'src/ui',
  plugins: [viteSingleFile()],
  // Keep third-party notices inside the self-contained offline bundle.
  esbuild: { legalComments: 'inline' },
  build: { target: 'es2022', outDir: '../../dist', emptyOutDir: mode !== 'testbench', chunkSizeWarningLimit: 6000, rollupOptions: { ...(mode === 'testbench' ? { input: 'src/ui/testbench.html' } : {}), output: { banner: vendorNotice } } },
  worker: { format: 'es', rollupOptions: { output: { banner: vendorNotice } } },
}));
