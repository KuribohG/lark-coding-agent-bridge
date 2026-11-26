#!/usr/bin/env node
// Build wsfs, the daemon behind `isolation: "wsfs"` workflow workspaces (packages/workspace-fs), into bin/wsfs.
// Only Linux has it. A host without cargo, or one whose cargo cannot build it, gets no binary: the bridge then
// refuses that isolation with the reason and everything else works. WSFS_BUILD=required makes a failed build
// fail this script, and WSFS_BUILD=skip leaves the binary as it is.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const crate = join(root, 'packages', 'workspace-fs');
const output = join(root, 'bin', 'wsfs');
const mode = process.env.WSFS_BUILD ?? '';

if (process.platform !== 'linux') {
  console.log(`wsfs: skipped (${process.platform} is not served)`);
  process.exit(0);
}
if (mode === 'skip' || mode === '0') {
  console.log('wsfs: skipped (WSFS_BUILD)');
  process.exit(0);
}

/** Every file the binary is built from, in a fixed order. */
function sources(dir, below = '') {
  return readdirSync(join(dir, below), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap(entry => {
    const path = join(below, entry.name);
    return entry.isDirectory() ? sources(dir, path) : [path];
  });
}
const digest = createHash('sha256');
for (const path of ['Cargo.toml', 'Cargo.lock', ...sources(crate, 'src')]) digest.update(path + '\0').update(readFileSync(join(crate, path))).update('\0');
// Cargo takes a file for unchanged when it is older than what was built from it, whatever tree it is in, and the
// files of a release carry the time of their commit. A directory of intermediate files is therefore used for one
// state of the sources only. It is outside the tree: a build writes hundreds of megabytes there, and the tree is
// often on a network filesystem and kept.
const target = process.env.CARGO_TARGET_DIR
  ?? join(tmpdir(), `lark-channel-bridge-wsfs-${userInfo().uid}`, digest.digest('hex').slice(0, 16));
const built = join(target, 'release', 'wsfs');

function install() {
  mkdirSync(dirname(output), { recursive: true });
  // Moved into place: a daemon that is running keeps the binary it was started from.
  copyFileSync(built, `${output}.${process.pid}`);
  chmodSync(`${output}.${process.pid}`, 0o755);
  renameSync(`${output}.${process.pid}`, output);
}
function unavailable(reason) {
  // A binary of other sources would serve workspaces in a way this version of the bridge does not expect.
  rmSync(output, { force: true });
  console.warn(`wsfs: not built (${reason}); workspaces with isolation "wsfs" will be unavailable`);
  process.exit(mode === 'required' ? 1 : 0);
}

if (!process.env.CARGO_TARGET_DIR && existsSync(join(target, 'built')) && existsSync(built)) {
  install();
  console.log(`wsfs: these sources were built before -> ${output}`);
  process.exit(0);
}

/**
 * Every cargo there is to try, in the order of trying: the one named by $CARGO, each one on PATH, and the one
 * rustup installs. The first on PATH is often the distribution's, too old for the lock file, with a newer one
 * behind it.
 */
function cargos() {
  const onPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'cargo'));
  const seen = new Set();
  return [process.env.CARGO, ...[...onPath, join(homedir(), '.cargo', 'bin', 'cargo')].filter(path => existsSync(path))].filter(cargo => {
    if (!cargo) return false;
    let real = cargo;
    try { real = realpathSync(cargo); } catch { /* a bare name in $CARGO is looked up when it is run */ }
    return !seen.has(real) && seen.add(real);
  });
}

const failed = [];
for (const cargo of cargos()) {
  try {
    // From the crate's directory: its lock file pins dependencies that build with the oldest compiler it supports.
    execFileSync(cargo, ['build', '--release', '--locked'], { cwd: crate, stdio: 'pipe', timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CARGO_TARGET_DIR: target } });
  } catch (error) {
    if (error?.code === 'ENOENT') continue;
    const stderr = String(error?.stderr ?? error).trim().split('\n').slice(-12).join('\n');
    console.warn(`wsfs: ${cargo} could not build it (it needs Rust 1.93 or later, and the crates of Cargo.lock)\n${stderr}`);
    failed.push(cargo);
    continue;
  }
  if (!existsSync(built)) unavailable(`${cargo} left no binary at ${built}`);
  install();
  if (!process.env.CARGO_TARGET_DIR) execFileSync('touch', [join(target, 'built')]);
  console.log(`wsfs: built with ${cargo} -> ${output}`);
  process.exit(0);
}
unavailable(failed.length ? `${failed.join(', ')} failed` : 'cargo was not found');
