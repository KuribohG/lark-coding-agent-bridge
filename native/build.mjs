#!/usr/bin/env node
// Build the launchers that agent runs are started through: the Landlock one of the exec sandbox (see
// docs/exec-sandbox.md) and the one that confines a run's signals (see docs/signal-isolation.md).
// Both need Linux; every other platform, and any Linux host without a C compiler, degrades to "no launcher".
// The bridge then runs agents without that confinement, unless a profile sets exec_sandbox.require_landlock.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const launchers = [
  { name: 'landlock-exec', needs: 'Landlock', without: 'the exec sandbox will be unavailable' },
  { name: 'signal-cell', needs: 'seccomp', without: 'workflow workers will not be confined to their own signals' },
];

if (process.platform !== 'linux') {
  for (const { name, needs } of launchers) console.log(`${name}: skipped (${process.platform} has no ${needs})`);
  process.exit(0);
}

mkdirSync(join(root, 'bin'), { recursive: true });
const compilers = [process.env.CC, 'cc', 'gcc', 'clang'].filter(Boolean);

/** Returns false when a compiler was there and could not build the file. */
function build({ name, without }) {
  const source = join(root, 'native', `${name}.c`);
  const output = join(root, 'bin', name);
  let attempted = false;
  for (const compiler of compilers) {
    try {
      execFileSync(compiler, ['-O2', '-Wall', '-Wextra', '-o', output, source], { stdio: 'pipe' });
      console.log(`${name}: built with ${compiler} -> ${output}`);
      return true;
    } catch (error) {
      const stderr = typeof error?.stderr === 'string' ? error.stderr : String(error);
      if (error?.code === 'ENOENT') {
        console.warn(`${name}: ${compiler} not found`);
        continue;
      }
      // A compiler that exists but cannot build this file is a broken tree, not a
      // missing toolchain: fail instead of shipping a stale launcher.
      attempted = true;
      console.error(`${name}: ${compiler} failed to build\n${stderr}`);
    }
  }
  if (attempted) return false;
  // Keep whatever a previous build produced so what was enabled keeps working.
  if (existsSync(output)) console.warn(`${name}: no C compiler available; keeping the existing binary`);
  else console.warn(`${name}: no C compiler found; ${without}`);
  return true;
}

if (!launchers.map(build).every(Boolean)) process.exit(1);
