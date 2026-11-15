#!/usr/bin/env node
// Build the Landlock launcher used by the exec sandbox (see docs/exec-sandbox.md).
// Only Linux has Landlock; every other platform, and any Linux host without a C
// compiler, degrades to "no launcher" and the bridge then runs agents unsandboxed
// unless a profile sets exec_sandbox.require_landlock.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'native', 'landlock-exec.c');
const output = join(root, 'bin', 'landlock-exec');

if (process.platform !== 'linux') {
  console.log(`landlock-exec: skipped (${process.platform} has no Landlock)`);
  process.exit(0);
}

mkdirSync(dirname(output), { recursive: true });
const compilers = [process.env.CC, 'cc', 'gcc', 'clang'].filter(Boolean);
let attempted = false;
for (const compiler of compilers) {
  try {
    execFileSync(compiler, ['-O2', '-Wall', '-Wextra', '-o', output, source], { stdio: 'pipe' });
    console.log(`landlock-exec: built with ${compiler} -> ${output}`);
    process.exit(0);
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr : String(error);
    if (error?.code === 'ENOENT') {
      console.warn(`landlock-exec: ${compiler} not found`);
      continue;
    }
    // A compiler that exists but cannot build this file is a broken tree, not a
    // missing toolchain: fail instead of shipping a stale launcher.
    attempted = true;
    console.error(`landlock-exec: ${compiler} failed to build\n${stderr}`);
  }
}
if (attempted) process.exit(1);
// Keep whatever a previous build produced so an enabled sandbox keeps working.
if (existsSync(output)) {
  console.warn('landlock-exec: no C compiler available; keeping the existing binary');
  process.exit(0);
}
console.warn('landlock-exec: no C compiler found; the exec sandbox will be unavailable');
