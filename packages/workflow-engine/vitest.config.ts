import { defineConfig } from 'vitest/config';

// Under test, every commit is checked against a rebuild of the workflow from its journal; load runs turn it off.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], env: { WORKFLOW_ENGINE_VERIFY: process.env.WORKFLOW_ENGINE_VERIFY ?? '1' } } });
