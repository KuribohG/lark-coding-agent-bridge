import { existsSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { log } from '../../core/logger';
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
    if (!['provider', 'image', 'cpu', 'memoryGb', 'ttlSeconds'].includes(key)) {
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
  return {
    provider: raw.provider.trim(),
    ...(typeof raw.image === 'string' ? { image: raw.image.trim() } : {}),
    ...(typeof raw.cpu === 'number' ? { cpu: raw.cpu } : {}),
    ...(typeof raw.memoryGb === 'number' ? { memoryGb: raw.memoryGb } : {}),
    ...(typeof raw.ttlSeconds === 'number' ? { ttlSeconds: raw.ttlSeconds } : {}),
  };
}

/** Where the bridge stages the runtime and payloads inside every workcell. */
const WORKCELL_ROOT = '/opt/lark-workcell';
/** Port the host listens on inside the workcell; the provider forwards it. */
export const WORKCELL_HOST_PORT = 47_811;
/** Where a pushed workspace lands inside the unit. */
export const WORKCELL_WORK_DIR = `${WORKCELL_ROOT}/work`;
/**
 * Build outputs and histories a worker does not need and that would dominate the
 * transfer. Anything a member must see has to be part of the source tree.
 */
const WORKSPACE_EXCLUDES = ['.git', 'node_modules', 'target', 'build', '.venv', '__pycache__'];

export interface WorkcellRuntimeLayout {
  /** Local directories to push and where they belong inside the workcell. */
  pushes: Array<{ local: string; remote: string }>;
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
  root?: string;
}): WorkcellRuntimeLayout {
  const root = paths.root ?? WORKCELL_ROOT;
  const nodeDir = dirname(dirname(paths.nodePath));
  const packageDir = packageRoot(paths.sdkPath);
  const scopeDir = dirname(packageDir);
  const nodeModules = join(root, 'node_modules');
  const packageRemote = join(nodeModules, basename(scopeDir), basename(packageDir));
  return {
    pushes: [
      { local: nodeDir, remote: join(nodeModules, basename(nodeDir)) },
      { local: scopeDir, remote: join(nodeModules, basename(scopeDir)) },
      { local: dirname(paths.hostScript), remote: join(root, 'bin') },
    ],
    nodePath: join(nodeModules, basename(nodeDir), relative(nodeDir, paths.nodePath)),
    hostScript: join(root, 'bin', basename(paths.hostScript)),
    sdkPath: join(packageRemote, relative(packageDir, paths.sdkPath)),
    agentDir: join(root, 'agent'),
  };
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
}

export interface WorkcellPoolOptions {
  config: WorkcellConfig;
  /** Local directories pushed once per workcell (runtime, agent files). */
  runtime: WorkcellRuntimeLayout;
  /** Files copied into `<root>/agent` before the host starts. */
  agentFiles?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * One provider process and the workcells it owns. A handle is reused per key
 * (the workflow member) and torn down when the pool closes or the member ends.
 */
export class WorkcellPool {
  private provider: WorkcellProviderClient | undefined;
  private readonly cells = new Map<string, Pooled>();
  private closing = false;

  constructor(private readonly options: WorkcellPoolOptions) {}

  async acquire(key: string): Promise<WorkcellHandle> {
    const existing = this.cells.get(key);
    if (existing) {
      await this.renew(existing, false);
      return existing;
    }
    const provider = this.ensureProvider();
    const spec: WorkcellCreateParams = {
      ...(this.options.config.image ? { image: this.options.config.image } : {}),
      ...(this.options.config.cpu !== undefined ? { cpu: this.options.config.cpu } : {}),
      ...(this.options.config.memoryGb !== undefined ? { memoryGb: this.options.config.memoryGb } : {}),
      ...(this.options.config.ttlSeconds !== undefined ? { ttlSeconds: this.options.config.ttlSeconds } : {}),
      labels: { key },
    };
    const created = await provider.request<{ workcell: string }>('create', { spec });
    const id = created.workcell;
    log.info('agent', 'pi-workcell-provision', { key, workcell: id, image: spec.image });
    try {
      for (const push of this.options.runtime.pushes) {
        await provider.request('push', { workcell: id, local: push.local, remote: push.remote });
      }
      for (const file of this.options.agentFiles ?? []) {
        await provider.request('push', { workcell: id, local: file, remote: join(WORKCELL_ROOT, 'agent', basename(file)) });
      }
      const forward = await provider.request<{ port: number }>('forward', {
        workcell: id,
        remotePort: WORKCELL_HOST_PORT,
      });
      const cell: Pooled = { id, key, hostPort: forward.port };
      cell.renew = this.renewalTimer(cell);
      this.cells.set(key, cell);
      log.info('agent', 'pi-workcell-forward', { key, workcell: id, hostPort: forward.port });
      return cell;
    } catch (error) {
      // A half-provisioned cell is useless; drop it before surfacing the error.
      await provider.request('stop', { workcell: id }).catch(() => undefined);
      throw error;
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

  private ensureProvider(): WorkcellProviderClient {
    if (this.closing) throw new Error('workcell pool is closed');
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
