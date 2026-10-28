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
    entry: { cli: 'src/cli/index.ts', launcher: 'src/cli/launcher.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: true,
    sourcemap: false,
    splitting: false,
    dts: false,
    define,
    // Inline the Vite-built console (src/ui/generated/index.html) as a string.
    esbuildOptions(options) {
      options.loader = { ...options.loader, '.html': 'text' };
    },
  },
  {
    entry: { index: 'src/index.ts', runtime: 'src/runtime/public.ts',
      lark: 'src/channels/lark/index.ts', web: 'src/channels/web/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: false,
    splitting: false,
    dts: true,
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
