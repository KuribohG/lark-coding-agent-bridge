import { defineConfig } from 'tsup';

export default defineConfig({
  // runtime.ts resolves the worker CLI as ./cli.js next to the bundle.
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  splitting: false,
  dts: { entry: { index: 'src/index.ts' } },
  // The dashboard page (src/dashboard/page.html) is bundled as a string.
  esbuildOptions(options) { options.loader = { ...options.loader, '.html': 'text' }; },
});
