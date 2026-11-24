import { defineConfig } from 'vitest/config';

// Under test, every commit is checked against a rebuild of the workflow from its journal; load runs turn it off.
export default defineConfig({
  // As in the build (tsup.config.ts): an imported .html file is its text.
  plugins: [{ name: 'html-string-loader', enforce: 'pre',
    transform(code: string, id: string) { return id.endsWith('.html') ? { code: `export default ${JSON.stringify(code)};`, map: null } : null; } }],
  test: { include: ['tests/**/*.test.ts'], env: { WORKFLOW_ENGINE_VERIFY: process.env.WORKFLOW_ENGINE_VERIFY ?? '1' } },
});
