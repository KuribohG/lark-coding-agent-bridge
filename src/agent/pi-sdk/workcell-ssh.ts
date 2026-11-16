import type { ChildProcess } from 'node:child_process';
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { log } from '../../core/logger';
import { spawnProcess } from '../../platform/spawn';
import { terminateChild } from '../../platform/terminate';
import type {
  WorkcellCreateParams, WorkcellExecParams, WorkcellForwardParams, WorkcellOp,
  WorkcellProvider, WorkcellPullParams, WorkcellPushParams,
} from './workcell-protocol';

/**
 * Builtin `ssh://[user@]host[:port]/base` workcell provider.
 *
 * One unit is a directory on the target machine: the runtime and the workspace
 * are pushed into it, the host runs there, and the port the bridge needs is
 * reached through `ssh -L`. It speaks the same protocol as an external provider,
 * so the pool and the adapters do not care which one answers.
 *
 * This is placement, not a security boundary: the unit is a directory plus the
 * processes started inside it, and `stop` ends them by matching the directory in
 * their command line. Use a container/VM provider for untrusted work, and
 * `pi.remote` when the host already shares the bridge's filesystem.
 */

export interface SshWorkcellTarget {
  destination: string;
  port?: number;
  /** Absolute directory on the host that holds one subdirectory per unit. */
  base: string;
  /** ssh binary; tests point this at a stand-in. */
  ssh?: string;
}

const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const TUNNEL_READY_MS = 500;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Parse `ssh://[user@]host[:port]/base/dir`. */
export function parseSshWorkcell(provider: string): SshWorkcellTarget | undefined {
  if (!provider.startsWith('ssh://')) return undefined;
  const url = new URL(provider);
  if (!url.hostname) throw new Error(`pi.workcell.provider: ssh:// needs a host: ${provider}`);
  const base = decodeURIComponent(url.pathname || '').replace(/\/+$/, '');
  if (!base) {
    throw new Error('pi.workcell.provider: ssh:// needs a directory for its units, e.g. ssh://host/lark-cells');
  }
  return {
    destination: url.username ? `${url.username}@${url.hostname}` : url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    base,
  };
}

export class SshWorkcellProvider implements WorkcellProvider {
  private readonly units = new Map<string, string>();
  private readonly tunnels = new Map<string, ChildProcess>();
  private closed = false;

  constructor(private readonly target: SshWorkcellTarget) {}

  get isClosed(): boolean {
    return this.closed;
  }

  async request<T = unknown>(op: WorkcellOp, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) throw new Error('ssh workcell provider is closed');
    switch (op) {
      case 'create': return await this.create(params.spec as WorkcellCreateParams | undefined) as T;
      case 'push': return await this.push(params as unknown as WorkcellPushParams) as T;
      case 'pull': return await this.pull(params as unknown as WorkcellPullParams) as T;
      case 'exec': return await this.exec(params as unknown as WorkcellExecParams) as T;
      case 'forward': return await this.forward(params as unknown as WorkcellForwardParams) as T;
      case 'ttl': return {} as T;
      case 'stop': return await this.stop(String(params.workcell)) as T;
      default: throw new Error(`ssh workcell provider does not implement ${String(op)}`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.exitCode === null) terminateChild(tunnel, 'SIGTERM');
    }
    this.tunnels.clear();
    this.units.clear();
  }

  private async create(spec: WorkcellCreateParams | undefined): Promise<{ workcell: string; root: string }> {
    const key = String(spec?.labels?.key ?? 'cell').replace(/[^A-Za-z0-9-]/g, '-').slice(0, 20);
    const name = `${key}-${Math.random().toString(36).slice(2, 8)}`;
    const unit = `${this.target.base}/${name}`;
    const root = `${unit}/opt/lark-workcell`;
    await this.must(`mkdir -p ${shellQuote(root)} ${shellQuote(`${root}/agent`)} ${shellQuote(`${root}/work`)}`, 60_000);
    this.units.set(name, root);
    log.info('agent', 'pi-workcell-provision', { workcell: name, provider: 'ssh', root });
    return { workcell: name, root };
  }

  private async push(params: WorkcellPushParams): Promise<{ remote: string }> {
    const scratch = mkdtempSync(join(tmpdir(), 'larkcell-push-'));
    try {
      if (statSync(params.local).isDirectory()) {
        // Stage on disk, then upload the file: streaming a live tar into a
        // remote tar makes truncated archives under load.
        const archive = join(scratch, 'tree.tar.gz');
        await localRun('tar', ['-czf', archive, '-C', params.local, '.']);
        const remoteArchive = `${params.remote}.tar.gz`;
        await this.upload(remoteArchive, archive);
        const excludes = (params.exclude ?? []).map((name) => `--exclude=${shellQuote(name)}`).join(' ');
        await this.must(
          `mkdir -p ${shellQuote(params.remote)} && `
          + `tar -xzf ${shellQuote(remoteArchive)} -C ${shellQuote(params.remote)} ${excludes} --no-same-owner && `
          + `rm -f ${shellQuote(remoteArchive)}`,
          TRANSFER_TIMEOUT_MS,
        );
      } else {
        await this.must(`mkdir -p ${shellQuote(dirname(params.remote))}`, 60_000);
        await this.upload(params.remote, params.local);
      }
      return { remote: params.remote };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  private async pull(params: WorkcellPullParams): Promise<{ local: string; skipped?: boolean }> {
    const probe = await this.capture(`test -e ${shellQuote(params.remote)} && echo yes || echo no`, 60_000);
    if (!probe.includes('yes')) return { local: params.local, skipped: true };
    const scratch = mkdtempSync(join(tmpdir(), 'larkcell-pull-'));
    try {
      const archive = join(scratch, 'tree.tar.gz');
      const child = this.spawnRemote(`tar -czf - -C ${shellQuote(params.remote)} .`, ['ignore', 'pipe', 'pipe']);
      const stderr = drain(child);
      await pipeline(child.stdout!, createWriteStream(archive));
      const code = await exitCode(child);
      if (code !== 0) throw new Error(`remote tar exited with ${String(code)}: ${stderr() || 'no output'}`);
      mkdirSync(params.local, { recursive: true });
      await localRun('tar', ['-xzf', archive, '-C', params.local, '--no-same-owner']);
      return { local: params.local };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** `ssh 'cat > path'` fed from a local file. */
  private async upload(remotePath: string, localFile: string): Promise<void> {
    const child = this.spawnRemote(`cat > ${shellQuote(remotePath)}`, ['pipe', 'ignore', 'pipe']);
    const stderr = drain(child);
    const timer = setTimeout(() => terminateChild(child, 'SIGKILL'), TRANSFER_TIMEOUT_MS);
    timer.unref?.();
    try {
      await pipeline(createReadStream(localFile), child.stdin!);
      const code = await exitCode(child);
      if (code !== 0) throw new Error(`upload to ${remotePath} failed (${String(code)}): ${stderr() || 'no output'}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async exec(params: WorkcellExecParams): Promise<{ job?: string; code?: number; stdout?: string }> {
    const root = this.knownUnit(params.workcell);
    const exports = Object.entries(params.env ?? {})
      .map(([name, value]) => `export ${name}=${shellQuote(String(value))}`)
      .join('; ');
    const cwd = params.cwd ? `${root}${params.cwd.startsWith('/') ? '' : '/'}${params.cwd}` : root;
    const inner = [exports, `cd ${shellQuote(cwd)}`, params.script].filter(Boolean).join('; ');
    if (params.detach) {
      const job = `host-${Math.random().toString(36).slice(2, 10)}`;
      const logPath = `${root}/host.log`;
      // `setsid` makes the host its own session leader; its pid is recorded so
      // `stop` can end the whole process group instead of guessing by pattern.
      const code = await this.capture(
        `nohup setsid bash -c ${shellQuote(inner)} > ${shellQuote(logPath)} 2>&1 < /dev/null & `
        + `echo $! > ${shellQuote(`${root}/host.pid`)}; echo started`,
        60_000,
      );
      log.info('agent', 'pi-workcell-host-start', { workcell: params.workcell, provider: 'ssh', log: logPath, output: code.trim() });
      return { job };
    }
    const timeout = Number(params.timeout ?? 0) > 0 ? Number(params.timeout) * 1000 : TRANSFER_TIMEOUT_MS;
    // A subshell keeps `exit` from skipping the status report.
    const output = await this.capture(`bash -c ${shellQuote(`( ${inner} ); echo "__RC=$?"`)}`, timeout);
    const marker = /__RC=(\d+)\s*$/.exec(output);
    return { code: marker ? Number(marker[1]) : 0, stdout: output.replace(/__RC=\d+\s*$/, '') };
  }

  private async forward(params: WorkcellForwardParams): Promise<{ port: number }> {
    const port = await freeLocalPort();
    // The host listens on every interface inside the unit, so loopback works.
    const tunnel = spawnProcess(this.sshBinary(), [
      ...this.connectionArgs(), ...SSH_OPTIONS,
      '-N', '-T', '-o', 'ExitOnForwardFailure=yes',
      '-L', `127.0.0.1:${port}:127.0.0.1:${params.remotePort}`,
      this.target.destination,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    this.tunnels.set(String(params.workcell), tunnel);
    await new Promise((resolve) => setTimeout(resolve, TUNNEL_READY_MS));
    if (tunnel.exitCode !== null) throw new Error(`ssh could not forward port ${params.remotePort} on ${this.target.destination}`);
    return { port };
  }

  private async stop(workcell: string): Promise<Record<string, never>> {
    const root = this.units.get(workcell);
    const tunnel = this.tunnels.get(workcell);
    this.tunnels.delete(workcell);
    this.units.delete(workcell);
    if (tunnel && tunnel.exitCode === null) terminateChild(tunnel, 'SIGTERM');
    if (!root) return {};
    const unit = root.replace(/\/opt\/lark-workcell$/, '');
    const pidFile = `${root}/host.pid`;
    // Order matters: end the recorded process group, delete the unit, and only
    // then fall back to a pattern match — that last command's own shell matches
    // the pattern, so it must run after the directory is gone.
    await this.capture(
      `if [ -f ${shellQuote(pidFile)} ]; then `
      + `pid=$(cat ${shellQuote(pidFile)}); kill -TERM -- -$pid 2>/dev/null || kill -TERM $pid 2>/dev/null || true; sleep 1; `
      + `kill -KILL -- -$pid 2>/dev/null || kill -KILL $pid 2>/dev/null || true; fi; `
      + `rm -rf ${shellQuote(unit)}; pkill -f ${shellQuote(root)} >/dev/null 2>&1 || true; echo done`,
      120_000,
    ).catch((error: unknown) => {
      log.warn('agent', 'pi-workcell-stop-failed', { workcell, error: String(error) });
    });
    log.info('agent', 'pi-workcell-teardown', { workcell, provider: 'ssh', root });
    return {};
  }

  private knownUnit(workcell: string): string {
    const root = this.units.get(workcell);
    if (!root) throw new Error(`unknown workcell ${workcell}`);
    return root;
  }

  private sshBinary(): string {
    return this.target.ssh ?? 'ssh';
  }

  private connectionArgs(): string[] {
    return this.target.port ? ['-p', String(this.target.port)] : [];
  }

  private spawnRemote(script: string, stdio: ['ignore' | 'pipe', 'ignore' | 'pipe', 'ignore' | 'pipe']): ChildProcess {
    return spawnProcess(this.sshBinary(), [
      ...this.connectionArgs(), ...SSH_OPTIONS, this.target.destination, script,
    ], { stdio });
  }

  /** Remote script whose zero exit status is required. */
  private async must(script: string, timeoutMs: number): Promise<void> {
    const code = await this.run(script, timeoutMs);
    if (code !== 0) throw new Error(`ssh command failed (${code}): ${script.slice(0, 200)}`);
  }

  private async run(script: string, timeoutMs: number): Promise<number> {
    const child = this.spawnRemote(script, ['ignore', 'ignore', 'pipe']);
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    const timer = setTimeout(() => terminateChild(child, 'SIGKILL'), timeoutMs);
    timer.unref?.();
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      if (code !== 0 && code !== null) log.warn('agent', 'pi-workcell-ssh-failed', { code, stderr });
      return code ?? 1;
    } finally {
      clearTimeout(timer);
    }
  }

  private async capture(script: string, timeoutMs: number): Promise<string> {
    const child = this.spawnRemote(script, ['ignore', 'pipe', 'pipe']);
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', () => {});
    const timer = setTimeout(() => terminateChild(child, 'SIGKILL'), timeoutMs);
    timer.unref?.();
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => resolve());
      });
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function freeLocalPort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function drain(child: ChildProcess): () => string {
  let text = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { text = `${text}${chunk}`.slice(-2000); });
  return () => text.trim();
}

function localRun(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr = drain(child);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${String(code)}: ${stderr() || 'no output'}`));
    });
  });
}

function exitCode(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(1));
  });
}
