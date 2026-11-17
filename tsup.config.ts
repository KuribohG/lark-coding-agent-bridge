import { defineConfig } from 'tsup';
import { execFileSync } from 'node:child_process';

const buildCommit = process.env.LARK_BUILD_COMMIT?.trim() || gitCommit() || 'unknown';
const buildTime = process.env.LARK_BUILD_TIME?.trim() || new Date().toISOString();
const gitChanges = gitStatus();
const buildDirty = process.env.LARK_BUILD_DIRTY?.trim() || String(Boolean(gitChanges.trim()));
if (process.env.LARK_BUILD_DEBUG_DIRTY === '1' && gitChanges.trim()) {
  console.error(`[build] uncommitted files:\n${gitChanges.trim()}`);
}
const define = {
  'process.env.LARK_BUILD_COMMIT': JSON.stringify(buildCommit),
  'process.env.LARK_BUILD_TIME': JSON.stringify(buildTime),
  'process.env.LARK_BUILD_DIRTY': JSON.stringify(buildDirty),
};

export default defineConfig([
  {
    // `workflow-cli` is what agents run for each workflow operation ($AGENT_WORKFLOW_CLI): the engine's own CLI
    // without the bridge's program, which the engine picks up when it lies beside the bundle that holds it. It is
    // built here, with the bundle that cleans the folder, so that the cleaning cannot remove it.
    entry: {
      cli: 'src/cli/index.ts',
      'workflow-cli': 'packages/workflow-engine/src/cli.ts',
      // Loaded by Pi CLI processes with `--extension`; it must stand alone
      // (node built-ins only) because it runs in Pi's own runtime.
      'pi-model-gate': 'src/model-gate/pi-gate-extension.ts',
    },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: true,
    sourcemap: false,
    splitting: false,
    dts: false,
    // Bundle the in-repo engine package from source; it is not published separately yet.
    noExternal: ['@kuribohg/agent-workflows'],
    define,
    // Inline the Vite-built console (src/ui/generated/index.html) as a string.
    esbuildOptions(options) {
      options.loader = { ...options.loader, '.html': 'text' };
    },
  },
  {
    entry: { index: 'src/index.ts', runtime: 'src/runtime/public.ts',
      lark: 'src/channels/lark/index.ts', web: 'src/channels/web/index.ts',
      slack: 'src/channels/slack/index.ts', workflows: 'src/workflows/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: false,
    splitting: false,
    noExternal: ['@kuribohg/agent-workflows'],
    dts: { resolve: ['@kuribohg/agent-workflows'] },
    define,
    esbuildOptions(options) { options.loader = { ...options.loader, '.html': 'text' }; },
  },
]);

function gitCommit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function gitStatus(): string {
  try {
    return execFileSync('git', [
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      '.',
      ':(exclude)tsup.config.bundled_*.mjs',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}
