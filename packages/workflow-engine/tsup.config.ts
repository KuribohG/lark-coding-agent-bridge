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
});
