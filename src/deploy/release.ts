import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../package.json';
import { getBuildInfo } from '../build-info';
import { spawnProcess } from '../platform/spawn';
import type { DeploySpec } from './spec';

export interface Release {
  dir: string;
  /** Short name for messages: the commit for git builds, `self` otherwise. */
  label: string;
  commit?: string;
  version: string;
}

export const BRIDGE_ENTRY = join('bin', 'lark-channel-bridge.mjs');
const RELEASE_INFO = 'release-info.json';
const RELEASE_NAME = /^[0-9a-f]{12}$/;

/** The installation running this command. */
export function selfRelease(): Release {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === pkg.name) break;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('无法定位当前安装的 lark-channel-bridge 目录');
    dir = parent;
  }
  const commit = getBuildInfo().commit;
  return { dir, label: 'self', version: pkg.version, ...(commit !== 'unknown' ? { commit } : {}) };
}

/** Fetches the source mirror and resolves the configured ref without building. */
export async function resolveGitCommit(spec: DeploySpec, say: (line: string) => void): Promise<string> {
  if (spec.source.kind !== 'git') throw new Error('not a git source');
  const mirror = join(spec.root, 'source.git');
  await mkdir(spec.root, { recursive: true, mode: 0o700 });
  if (!existsSync(join(mirror, 'HEAD'))) {
    say(`克隆 ${spec.source.url}`);
    const tmp = `${mirror}.tmp-${process.pid}`;
    await rm(tmp, { recursive: true, force: true });
    await run('git', ['clone', '--mirror', '--quiet', spec.source.url, tmp]);
    await rename(tmp, mirror);
  } else {
    say(`拉取 ${spec.source.url}`);
    await run('git', ['-C', mirror, 'remote', 'set-url', 'origin', spec.source.url]);
    await run('git', ['-C', mirror, 'fetch', '--prune', '--quiet', 'origin']);
  }
  return (await run('git', ['-C', mirror, 'rev-parse', '--verify', `${spec.source.ref}^{commit}`])).trim();
}

/** The release of `commit` if it has been built completely. */
export function builtRelease(root: string, commit: string): Release | undefined {
  const dir = join(root, 'releases', commit.slice(0, 12));
  return readReleaseInfo(dir)?.commit === commit ? { dir, label: commit.slice(0, 12), commit, version: releaseVersion(dir) } : undefined;
}

/** A built release of `commit` under `<root>/releases/<sha12>`, reused when already complete. */
export async function buildRelease(spec: DeploySpec, commit: string, say: (line: string) => void): Promise<Release> {
  const existing = builtRelease(spec.root, commit);
  if (existing) return existing;
  const dir = join(spec.root, 'releases', commit.slice(0, 12));
  const tmp = `${dir}.tmp-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  try {
    say(`构建 ${commit.slice(0, 12)}（首次构建需要几分钟）`);
    await extract(join(spec.root, 'source.git'), commit, tmp);
    const env = { ...process.env, PATH: [dirname(spec.node), process.env.PATH].filter(Boolean).join(delimiter), LARK_BUILD_COMMIT: commit,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
    await run(spec.node, await installCommand(spec.node, tmp), { cwd: tmp, env });
    for (const file of [BRIDGE_ENTRY, join('dist', 'cli.js')]) {
      if (!existsSync(join(tmp, file))) throw new Error(`构建结果缺少 ${file}`);
    }
    await writeFile(join(tmp, RELEASE_INFO), `${JSON.stringify({ commit, ref: spec.source.kind === 'git' ? spec.source.ref : undefined,
      createdAt: new Date().toISOString() }, null, 2)}\n`);
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  return { dir, label: commit.slice(0, 12), commit, version: releaseVersion(dir) };
}

/** Removes the oldest built releases beyond `keep`, never one in `protect`. */
export async function pruneReleases(root: string, keep: number, protect: readonly string[]): Promise<string[]> {
  const dir = join(root, 'releases');
  let names: string[];
  try { names = (await readdir(dir)).filter(name => RELEASE_NAME.test(name)); } catch { return []; }
  const releases = await Promise.all(names.map(async name => ({ path: join(dir, name), mtime: (await stat(join(dir, name))).mtimeMs })));
  releases.sort((a, b) => b.mtime - a.mtime);
  const removed: string[] = [];
  for (const release of releases.slice(keep)) {
    if (protect.includes(release.path) || !readReleaseInfo(release.path)) continue;
    await rm(release.path, { recursive: true, force: true });
    removed.push(release.path);
  }
  return removed;
}

function readReleaseInfo(dir: string): { commit?: string } | undefined {
  try { return JSON.parse(readFileSync(join(dir, RELEASE_INFO), 'utf8')) as { commit?: string }; } catch { return undefined; }
}

function releaseVersion(dir: string): string {
  try { return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? ''; } catch { return ''; }
}

/** corepack from the configured Node pins the repo's packageManager; plain npm otherwise. */
async function installCommand(node: string, dir: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { packageManager?: string };
  const corepack = [join(dirname(node), '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
    join(dirname(node), 'node_modules', 'corepack', 'dist', 'corepack.js')].find(existsSync);
  if (manifest.packageManager && corepack) return [corepack, manifest.packageManager, 'install', '--frozen-lockfile'];
  const npm = [join(dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(existsSync);
  if (!npm) throw new Error(`${node} 旁找不到 corepack 或 npm，无法安装依赖`);
  return [npm, existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund'];
}

function extract(mirror: string, commit: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const archive = spawnProcess('git', ['-C', mirror, 'archive', '--format=tar', commit], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawnProcess('tar', ['-x', '-C', into], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    archive.stderr!.on('data', (chunk: Buffer) => { stderr += chunk; });
    tar.stderr!.on('data', (chunk: Buffer) => { stderr += chunk; });
    archive.stdout!.pipe(tar.stdin!);
    const exit = (child: typeof tar) => new Promise<number | null>((done, fail) => {
      child.on('error', fail);
      child.on('close', done);
    });
    Promise.all([exit(archive), exit(tar)]).then(([archived, extracted]) => {
      if (archived === 0 && extracted === 0) resolve();
      else reject(new Error(`解包 ${commit.slice(0, 12)} 失败：${stderr.trim().slice(-2000)}`));
    }, reject);
  });
}

/** Runs a command to completion; the error carries the output tail. */
export function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let output = '';
    const keep = (chunk: Buffer, isStdout: boolean) => {
      if (isStdout) stdout = (stdout + chunk).slice(-1_000_000);
      output = (output + chunk).slice(-4000);
    };
    child.stdout!.on('data', (chunk: Buffer) => keep(chunk, true));
    child.stderr!.on('data', (chunk: Buffer) => keep(chunk, false));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${[command, ...args].join(' ')} 退出码 ${code}\n${output.trim()}`));
    });
  });
}
