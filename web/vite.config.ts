import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: 'src/ui',
  plugins: [viteSingleFile()],
  build: { target: 'es2022', outDir: '../../dist', emptyOutDir: true, chunkSizeWarningLimit: 6000 },
  worker: { format: 'es' },
});
