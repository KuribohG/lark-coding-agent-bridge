import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, posix, relative, sep } from 'node:path';
import { log } from '../../core/logger';
import { spawnProcess } from '../../platform/spawn';
import { WorkcellProviderClient, type WorkcellCreateParams } from './workcell-provider';

/**
 * A workcell is an isolated execution unit rented for one workflow member: the
 * Pi SDK host runs inside it, the bridge reaches it through a forwarded port,
 * and it is discarded when the member is done. Nothing here knows which
 * infrastructure provides the unit.
 */

export interface WorkcellConfig {
  /** Provider executable; see workcell-provider.ts for the protocol. */
  provider: string;
  image?: string;
  cpu?: number;
  memoryGb?: number;
  ttlSeconds?: number;
  /**
   * Networks the unit may reach. `www` is public internet (a model endpoint,
   * package registries); `lan` is the internal network. Absent means none.
   */
  network?: readonly ('lan' | 'www')[];
  /**
   * Cloud path of a runtime layer built ahead of time (an EROFS mounted into
   * every unit). When set, units start with the runtime already in place and the
   * bridge only pushes the workspace, the small `bin/` and the agent files.
   * Rebuild it in place; packing to the same path overwrites the old layer, so
   * nothing accumulates.
   */
  layer?: string;
  /**
   * How many units may be alive at once. A new member evicts the least recently
   * used idle unit; when every unit is busy the request fails instead of
   * silently killing a member's host.
   */
  maxCells?: number;
  /**
   * How many units may be prepared at once. Transfers scale with the number of
   * streams, so a batch of workers provisions in parallel instead of in turn.
   */
  parallelism?: number;
}

const POSITIVE_INTS = ['cpu', 'memoryGb', 'ttlSeconds'] as const;

/** Validate the TOML `[agents.pi.workcell]` table. */
export function normalizeWorkcell(input: unknown): WorkcellConfig | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('pi.workcell: expected a table');
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!['provider', 'image', 'cpu', 'memoryGb', 'ttlSeconds', 'network', 'parallelism', 'layer', 'maxCells'].includes(key)) {
      throw new Error(`pi.workcell.${key}: unknown setting`);
    }
  }
  if (typeof raw.provider !== 'string' || !raw.provider.trim()) {
    throw new Error('pi.workcell.provider: expected the path of a provider executable');
  }
  if (raw.image !== undefined && (typeof raw.image !== 'string' || !raw.image.trim())) {
    throw new Error('pi.workcell.image: expected a non-empty string');
  }
  for (const key of POSITIVE_INTS) {
    const value = raw[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) <= 0)) {
      throw new Error(`pi.workcell.${key}: expected a positive integer`);
    }
  }
  const network = raw.network;
  if (network !== undefined
    && (!Array.isArray(network) || network.some((item) => item !== 'lan' && item !== 'www'))) {
    throw new Error("pi.workcell.network: expected an array of \"lan\" and/or \"www\"");
  }
  if (raw.layer !== undefined && (typeof raw.layer !== 'string' || !raw.layer.startsWith('/'))) {
    throw new Error('pi.workcell.layer: expected an absolute cloud path such as /artifacts/<user>/runtime.erofs');
  }
  const maxCells = raw.maxCells;
  if (maxCells !== undefined && (typeof maxCells !== 'number' || !Number.isSafeInteger(maxCells) || maxCells < 1 || maxCells > 512)) {
    throw new Error('pi.workcell.maxCells: expected an integer between 1 and 512');
  }
  const parallelism = raw.parallelism;
  if (parallelism !== undefined && (typeof parallelism !== 'number' || !Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > 64)) {
    throw new Error('pi.workcell.parallelism: expected an integer between 1 and 64');
  }
  return {
    provider: raw.provider.trim(),
    ...(typeof parallelism === 'number' ? { parallelism } : {}),
    ...(typeof raw.layer === 'string' ? { layer: raw.layer.trim() } : {}),
    ...(typeof maxCells === 'number' ? { maxCells } : {}),
    ...(Array.isArray(network) && network.length > 0 ? { network: [...network] as ('lan' | 'www')[] } : {}),
    ...(typeof raw.image === 'string' ? { image: raw.image.trim() } : {}),
    ...(typeof raw.cpu === 'number' ? { cpu: raw.cpu } : {}),
    ...(typeof raw.memoryGb === 'number' ? { memoryGb: raw.memoryGb } : {}),
    ...(typeof raw.ttlSeconds === 'number' ? { ttlSeconds: raw.ttlSeconds } : {}),
  };
}

/** Where the bridge stages the runtime and payloads inside every workcell. */
export const WORKCELL_ROOT = '/opt/lark-workcell';
/** Port the host listens on inside the workcell; the provider forwards it. */
export const WORKCELL_HOST_PORT = 47_811;
/**
 * Loopback endpoint inside the unit that the host forwards to the bridge, so a
 * worker's workflow CLI call is executed by the bridge rather than dialing a
 * port that does not exist there.
 */
export const WORKCELL_IPC_PORT = 47_812;
/** Where a pushed workspace lands inside the unit. */
export const WORKCELL_WORK_DIR = `${WORKCELL_ROOT}/work`;
/**
 * Build outputs and histories a worker does not need and that would dominate the
 * transfer. Anything a member must see has to be part of the source tree.
 */
const WORKSPACE_EXCLUDES = ['.git', 'node_modules', 'target', 'build', '.venv', '__pycache__'];

/**
 * The heavy runtime as one prebuilt archive: building it once per bridge build
 * beats re-tarring 268 MB for every unit.
 */
export interface WorkcellRuntimeArchive {
  /** Directory holding the cached archives. */
  cacheDir: string;
  /** Cache identity: same key, same archive. */
  key: string;
  /** Directory whose contents the archive carries (`node_modules`). */
  modulesDir: string;
  /** Where the archive lands inside the unit, and the directory it unpacks to. */
  remote: string;
  extractTo: string;
}

export interface WorkcellRuntimeLayout {
  /** Local directories to push and where they belong inside the workcell. */
  pushes: Array<{ local: string; remote: string }>;
  /** Prebuilt runtime archive; when absent the runtime directory is pushed. */
  archive?: WorkcellRuntimeArchive;
  /** Fallback for a host without `tar`: the runtime tree pushed as a directory. */
  modules?: { local: string; remote: string };
  /** Host entry points as seen from inside the workcell. */
  nodePath: string;
  hostScript: string;
  sdkPath: string;
  /** Pi agent directory inside the workcell (auth, models and sessions). */
  agentDir: string;
}

/**
 * The SDK tree is pushed as `node_modules/<scope>/<package>` so the packages
 * still resolve each other inside the workcell; only the basenames of the local
 * layout are assumed.
 */
export function workcellRuntimeLayout(paths: {
  nodePath: string;
  sdkPath: string;
  hostScript: string;
  /** This bridge build's bundled workflow CLI, pushed so workers can call it. */
  workflowCli?: string;
  /** Cache directory for the prebuilt runtime archive; absent means push the tree. */
  archiveCacheDir?: string;
  root?: string;
}): WorkcellRuntimeLayout {
  const root = paths.root ?? WORKCELL_ROOT;
  const nodeDir = dirname(dirname(paths.nodePath));
  // The SDK imports packages that the runtime keeps beside `node` (chalk and
  // friends), so the whole tree travels instead of picking packages by hand.
  const modulesDir = dirname(nodeDir);
  const packageDir = packageRoot(paths.sdkPath);
  const nodeModules = posix.join(root, 'node_modules');
  const packageRemote = posix.join(nodeModules, relative(modulesDir, packageDir).split(sep).join('/'));
  return {
    pushes: [
      { local: dirname(paths.hostScript), remote: posix.join(root, 'bin') },
      ...(paths.workflowCli && existsSync(paths.workflowCli)
        ? [{ local: paths.workflowCli, remote: posix.join(root, 'bin', 'workflow-cli.js') }]
        : []),
    ],
    modules: { local: modulesDir, remote: nodeModules },
    ...(paths.archiveCacheDir
      ? {
        archive: {
          cacheDir: paths.archiveCacheDir,
          key: runtimeKey(modulesDir, paths.sdkPath, paths.nodePath),
          modulesDir,
          remote: posix.join(root, 'runtime.tar.gz'),
          extractTo: root,
        },
      }
      : {}),
    nodePath: posix.join(nodeModules, basename(nodeDir), relative(nodeDir, paths.nodePath).split(sep).join('/')),
    hostScript: posix.join(root, 'bin', basename(paths.hostScript)),
    sdkPath: posix.join(packageRemote, relative(packageDir, paths.sdkPath).split(sep).join('/')),
    agentDir: posix.join(root, 'agent'),
  };
}

/** Identity of the runtime contents: the launcher, the SDK entry and their sizes. */
function runtimeKey(modulesDir: string, sdkPath: string, nodePath: string): string {
  const hash = createHash('sha256').update(modulesDir);
  for (const file of [sdkPath, nodePath]) {
    try {
      const stat = statSync(file);
      hash.update(`${file}:${stat.size}:${stat.mtimeMs}`);
    } catch {
      hash.update(`${file}:missing`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

export interface RuntimeArchive {
  path: string;
  bytes: number;
}

/**
 * Build (or reuse) the runtime archive. `tar` does the packing so the archive
 * matches what the unit unpacks; a failed build simply leaves the caller on the
 * directory push.
 */
export async function ensureRuntimeArchive(archive: WorkcellRuntimeArchive): Promise<RuntimeArchive | undefined> {
  const path = join(archive.cacheDir, `runtime-${archive.key}.tar.gz`);
  if (existsSync(path)) {
    try {
      return { path, bytes: statSync(path).size };
    } catch {
      // Fall through and rebuild.
    }
  }
  mkdirSync(archive.cacheDir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const startedAt = Date.now();
  try {
    const child = spawnProcess('tar', ['-czf', temporary, '-C', dirname(archive.modulesDir), basename(archive.modulesDir)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (code !== 0) throw new Error(`tar exited with ${String(code)}: ${stderr.trim()}`);
    // Another bridge may have built the same key meanwhile; either file is fine.
    renameSync(temporary, path);
    const bytes = statSync(path).size;
    log.info('agent', 'pi-workcell-runtime-archived', { path, bytes, ms: Date.now() - startedAt });
    return { path, bytes };
  } catch (error) {
    rmSync(temporary, { force: true });
    log.warn('agent', 'pi-workcell-runtime-archive-failed', { error: String(error) });
    return undefined;
  }
}

/** The package that owns `sdkPath`, found by walking up to its `package.json`. */
function packageRoot(sdkPath: string): string {
  let dir = dirname(sdkPath);
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(dirname(sdkPath));
}

export interface WorkcellHandle {
  /** Provider-side id. */
  id: string;
  /** Reuse key: one workcell per workflow member. */
  key: string;
  /** Local port that forwards to the host inside the workcell. */
  hostPort: number;
  /** Local directories already copied into the unit. */
  workspaces?: Set<string>;
}

interface Pooled extends WorkcellHandle {
  renew?: NodeJS.Timeout;
  /** Last time a run asked for this unit; eviction takes the oldest. */
  lastUsed?: number;
}

export interface WorkcellPoolOptions {
  config: WorkcellConfig;
  /** Local directories and files pushed once per workcell (runtime, CLI, host). */
  runtime: WorkcellRuntimeLayout;
  /** Files copied into `<root>/agent` before the host starts. */
  agentFiles?: readonly string[];
  /**
   * Local directory that keeps each key's sessions across units: pulled out on
   * release, pushed back on the next unit, so a replaced unit still resumes.
   */
  sessionDir?: string;
  /** Whether a unit may be evicted right now (no run in flight for that member). */
  canEvict?: (key: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * One provider process and the workcells it owns. A handle is reused per key
 * (the workflow member) and torn down when the pool closes or the member ends.
 */
export class WorkcellPool {
  private provider: WorkcellProviderClient | undefined;
  private readonly cells = new Map<string, Pooled>();
  private readonly provisioning = new Map<string, Promise<WorkcellHandle>>();
  private closing = false;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly limit: number;
  private readonly maxCells: number;

  constructor(private readonly options: WorkcellPoolOptions) {
    this.limit = Math.max(1, options.config.parallelism ?? 8);
    this.maxCells = Math.max(1, options.config.maxCells ?? 32);
  }

  async acquire(key: string): Promise<WorkcellHandle> {
    const existing = this.cells.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      await this.renew(existing, false);
      return existing;
    }
    // The same key asked for twice concurrently must produce one unit.
    const inFlight = this.provisioning.get(key);
    if (inFlight) return inFlight;
    const provision = this.provision(key).finally(() => this.provisioning.delete(key));
    this.provisioning.set(key, provision);
    return provision;
  }

  private async provision(key: string): Promise<WorkcellHandle> {
    const provider = this.ensureProvider();
    const cell = await this.withSlot(async () => {
      const layer = this.options.config.layer;
      const spec: WorkcellCreateParams = {
        ...(this.options.config.image ? { image: this.options.config.image } : {}),
        ...(layer ? { layers: [layer] } : {}),
        ...(this.options.config.cpu !== undefined ? { cpu: this.options.config.cpu } : {}),
        ...(this.options.config.memoryGb !== undefined ? { memoryGb: this.options.config.memoryGb } : {}),
        ...(this.options.config.ttlSeconds !== undefined ? { ttlSeconds: this.options.config.ttlSeconds } : {}),
        ...(this.options.config.network ? { network: this.options.config.network } : {}),
        labels: { key },
      };
      await this.evictForCapacity();
      const created = await provider.request<{ workcell: string }>('create', { spec });
      const id = created.workcell;
      log.info('agent', 'pi-workcell-provision', { key, workcell: id, image: spec.image });
      const { runtime } = this.options;
      try {
        // Small pushes and the port request do not depend on the runtime, so
        // they travel while the heavy archive is on the wire.
        const archive = !layer && runtime.archive ? await ensureRuntimeArchive(runtime.archive) : undefined;
        const uploads: Array<Promise<unknown>> = runtime.pushes.map(push =>
          provider.request('push', { workcell: id, local: push.local, remote: push.remote }));
        for (const file of this.options.agentFiles ?? []) {
          uploads.push(provider.request('push', {
            workcell: id, local: file, remote: posix.join(WORKCELL_ROOT, 'agent', basename(file)),
          }));
        }
        const sessions = this.sessionArchive(key);
        if (sessions && existsSync(sessions)) {
          uploads.push(provider.request('push', {
            workcell: id, local: sessions, remote: posix.join(WORKCELL_ROOT, 'agent', 'sessions'),
          }));
        }
        uploads.push(provider.request('forward', { workcell: id, remotePort: WORKCELL_HOST_PORT }));
        // A layer already carries the runtime; only then does the unit need
        // nothing but the workspace, `bin/` and the agent files.
        const heavy = layer
          ? Promise.resolve(undefined)
          : archive && runtime.archive
            ? provider.request('push', { workcell: id, local: archive.path, remote: runtime.archive.remote })
            : runtime.modules
              ? provider.request('push', { workcell: id, local: runtime.modules.local, remote: runtime.modules.remote })
              : Promise.resolve(undefined);
        const results = await Promise.all([heavy, ...uploads]);
        const forward = results[results.length - 1] as { port: number };
        if (!layer && archive && runtime.archive) {
          // Unpack once, then drop the archive: the unit keeps only the tree.
          await provider.request('exec', {
            workcell: id,
            script: `tar -xzf ${runtime.archive.remote} -C ${runtime.archive.extractTo} && rm -f ${runtime.archive.remote}`,
            timeout: 600,
          });
        }
        const pooled: Pooled = { id, key, hostPort: forward.port, lastUsed: Date.now() };
        pooled.renew = this.renewalTimer(pooled);
        this.cells.set(key, pooled);
        log.info('agent', 'pi-workcell-forward', { key, workcell: id, hostPort: forward.port });
        return pooled;
      } catch (error) {
        // A half-provisioned cell is useless; drop it before surfacing the error.
        await provider.request('stop', { workcell: id }).catch(() => undefined);
        throw error;
      }
    });
    return cell;
  }

  /**
   * Keep the number of live units bounded: evict the least recently used idle
   * one, and refuse rather than kill a member that is mid-run.
   */
  private async evictForCapacity(): Promise<void> {
    if (this.cells.size < this.maxCells) return;
    const idle = [...this.cells.values()]
      .filter((cell) => this.options.canEvict?.(cell.key) !== false)
      .sort((left, right) => (left.lastUsed ?? 0) - (right.lastUsed ?? 0));
    const victim = idle[0];
    if (!victim) {
      throw new Error(`workcell capacity reached (${this.maxCells}) and every unit is busy`);
    }
    log.info('agent', 'pi-workcell-evict', { workcell: victim.id, key: victim.key, maxCells: this.maxCells });
    await this.release(victim.key);
  }

  /**
   * Bound how many units are prepared at once. Uploads scale with the number of
   * streams (measured: ~13 MiB/s per stream, aggregate growing with concurrency),
   * so a batch provisions in parallel while a runaway one stays bounded.
   */
  private async withSlot<T>(work: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }

  /** Copy a directory into the unit once; later turns of the same cell reuse it. */
  async ensureWorkspace(cell: WorkcellHandle, local: string, remote = WORKCELL_WORK_DIR): Promise<void> {
    cell.workspaces ??= new Set();
    if (cell.workspaces.has(local)) return;
    await this.ensureProvider().request('push', {
      workcell: cell.id,
      local,
      remote,
      exclude: WORKSPACE_EXCLUDES,
    });
    cell.workspaces.add(local);
    log.info('agent', 'pi-workcell-workspace', { workcell: cell.id, local, remote });
  }

  /** Start the host inside the workcell; `args` are the provider's exec arguments. */
  async startHost(cell: WorkcellHandle, script: string, env: Readonly<Record<string, string>>): Promise<void> {
    await this.ensureProvider().request('exec', { workcell: cell.id, script, env, detach: true, cwd: WORKCELL_ROOT });
    log.info('agent', 'pi-workcell-host-start', { workcell: cell.id, key: cell.key });
  }

  async release(key: string): Promise<void> {
    const cell = this.cells.get(key);
    if (!cell) return;
    this.cells.delete(key);
    if (cell.renew) clearInterval(cell.renew);
    const provider = this.provider;
    if (!provider || provider.isClosed) return;
    // Keep the member's sessions for the next unit before the unit goes away.
    const sessions = this.sessionArchive(key);
    if (sessions) {
      await provider.request('pull', {
        workcell: cell.id,
        remote: posix.join(WORKCELL_ROOT, 'agent', 'sessions'),
        local: sessions,
      }).catch((error: unknown) => {
        log.warn('agent', 'pi-workcell-session-pull-failed', { workcell: cell.id, error: String(error) });
      });
    }
    await provider.request('stop', { workcell: cell.id }).catch((error: unknown) => {
      log.warn('agent', 'pi-workcell-stop-failed', { workcell: cell.id, error: String(error) });
    });
    log.info('agent', 'pi-workcell-teardown', { workcell: cell.id, key });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const key of [...this.cells.keys()]) await this.release(key);
    const provider = this.provider;
    this.provider = undefined;
    await provider?.dispose();
  }

  private sessionArchive(key: string): string | undefined {
    const base = this.options.sessionDir;
    if (!base) return undefined;
    return join(base, key);
  }

  private ensureProvider(): WorkcellProviderClient {
    if (this.closing) throw new Error('workcell pool is closed');
    if (this.provider?.isClosed) {
      // A dead provider must not poison the pool: its units are gone with it,
      // so forget them and start a fresh process for the next request.
      log.warn('agent', 'pi-workcell-provider-restart', {
        reason: 'closed',
        cells: this.cells.size,
      });
      for (const [key, cell] of this.cells) {
        if (cell.renew) clearInterval(cell.renew);
        this.cells.delete(key);
      }
      this.provider = undefined;
    }
    this.provider ??= new WorkcellProviderClient({
      command: this.options.config.provider,
      ...(this.options.env ? { env: this.options.env } : {}),
    });
    return this.provider;
  }

  /** Keeps the workcell from being reclaimed while the bridge waits on it. */
  private renewalTimer(cell: Pooled): NodeJS.Timeout | undefined {
    const seconds = this.options.config.ttlSeconds;
    if (!seconds) return undefined;
    const timer = setInterval(() => void this.renew(cell, true), Math.max(30, Math.floor(seconds / 2)) * 1000);
    timer.unref?.();
    return timer;
  }

  private async renew(cell: Pooled, extend: boolean): Promise<void> {
    if (!extend) return;
    const seconds = this.options.config.ttlSeconds;
    if (!seconds) return;
    const provider = this.provider;
    if (!provider || provider.isClosed) return;
    await provider.request('ttl', { workcell: cell.id, seconds }).catch((error: unknown) => {
      log.warn('agent', 'pi-workcell-ttl-failed', { workcell: cell.id, error: String(error) });
    });
    log.info('agent', 'pi-workcell-ttl', { workcell: cell.id, seconds });
  }
}
