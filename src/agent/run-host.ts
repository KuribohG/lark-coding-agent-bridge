import { randomUUID } from 'node:crypto';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { log } from '../core/logger';
import { spawnProcess } from '../platform/spawn';
import { deadlineGuardCommand, spawnWithDeadline } from './deadline';

/**
 * Runs an agent under bin/run-host.mjs instead of as a bridge child. The host
 * keeps the agent's stdio open while no bridge is attached and journals it,
 * so the next bridge process can attach and replay the run from the start.
 */
export interface RunHostBinding {
  /** Stable for one conversation turn; a retry reuses it for its new process. */
  key: string;
  /** Attach to the process already running under this key instead of starting one. */
  attach?: boolean;
}

export type RunHostState = 'running' | 'exited' | 'missing';

const HOST_SCRIPT = fileURLToPath(new URL(
  import.meta.url.endsWith('.ts') ? '../../bin/run-host.mjs' : '../bin/run-host.mjs', import.meta.url,
));
const KEY_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const CONNECT_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 2_000;
const MAX_SOCKET_PATH = 100;

export function runHostsSupported(): boolean {
  return process.platform !== 'win32';
}

export function newRunHostKey(): string {
  return randomUUID();
}

/** Unix socket paths are short (104 bytes on macOS), so hosts live under the temp directory rather than the profile. */
function runHostRoot(): string {
  const configured = process.env.LARK_RUN_HOST_DIR?.trim();
  if (configured) return configured;
  const name = `lark-run-host-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`;
  const root = join(tmpdir(), name);
  return join(root, randomUUID(), 'sock').length <= MAX_SOCKET_PATH ? root : join('/tmp', name);
}

function hostDir(key: string): string {
  if (!KEY_PATTERN.test(key)) throw new Error(`invalid run host key: ${key}`);
  return join(runHostRoot(), key);
}

/** Running: a host answers on its socket. Exited: the agent finished and its output is complete. */
export async function probeRunHost(key: string): Promise<RunHostState> {
  const dir = hostDir(key);
  if (existsSync(join(dir, 'exit.json'))) return 'exited';
  if (!existsSync(join(dir, 'spec.json'))) return 'missing';
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = connect(join(dir, 'sock'));
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, PROBE_TIMEOUT_MS);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
  if (reachable) return 'running';
  // The host may have exited between the two checks.
  return existsSync(join(dir, 'exit.json')) ? 'exited' : 'missing';
}

export function removeRunHost(key: string): void {
  try {
    rmSync(hostDir(key), { recursive: true, force: true });
  } catch (error) {
    log.warn('run-host', 'remove-failed', { key, err: String(error) });
  }
}

/** Removes hosts of other or earlier bridge processes that nobody can attach to any more. */
export async function sweepRunHosts(maxAgeMs: number, keep: ReadonlySet<string> = new Set()): Promise<void> {
  let entries: string[];
  try { entries = readdirSync(runHostRoot()); } catch { return; }
  for (const key of entries) {
    if (!KEY_PATTERN.test(key) || keep.has(key)) continue;
    try {
      if (Date.now() - statSync(hostDir(key)).mtimeMs < maxAgeMs) continue;
      if (await probeRunHost(key) !== 'running') removeRunHost(key);
    } catch { /* raced with another sweeper */ }
  }
}

/** Ends the agent of a host nobody will reattach to, then removes its journals. */
export async function terminateRunHost(key: string, graceMs = 5_000): Promise<void> {
  if (await probeRunHost(key) === 'running') {
    const proc = attachHostedProcess(key);
    proc.on('error', () => {});
    proc.stdout.resume();
    proc.stderr.resume();
    const exited = once(proc, 'exit').then(() => true);
    const within = (ms: number) => Promise.race([exited, new Promise<boolean>(resolve => setTimeout(resolve, ms, false).unref())]);
    proc.kill('SIGTERM');
    if (!await within(graceMs)) {
      proc.kill('SIGKILL');
      if (!await within(graceMs)) proc.detach();
    }
    log.info('run-host', 'terminated', { key });
  }
  removeRunHost(key);
}

/** Live hosted agents started with `tag`, including those no bridge has reattached yet. */
export async function liveRunHosts(tag: string): Promise<number> {
  let entries: string[];
  try { entries = readdirSync(runHostRoot()); } catch { return 0; }
  let live = 0;
  for (const key of entries) {
    if (!KEY_PATTERN.test(key)) continue;
    try {
      const spec = JSON.parse(readFileSync(join(hostDir(key), 'spec.json'), 'utf8')) as { tag?: unknown };
      if (spec.tag === tag && await probeRunHost(key) === 'running') live++;
    } catch { /* not a host, or removed meanwhile */ }
  }
  return live;
}

/** Lines the bridge has written to the hosted agent's stdin, oldest first. */
export function readRunHostInput(key: string): string[] {
  try {
    return readFileSync(join(hostDir(key), 'stdin'), 'utf8').split('\n').filter(line => line.trim());
  } catch {
    return [];
  }
}

/** The adapter that started the agent under this host, if recorded. */
export function runHostAgent(key: string): string | undefined {
  try {
    const agent = (JSON.parse(readFileSync(join(hostDir(key), 'spec.json'), 'utf8')) as { agent?: unknown }).agent;
    return typeof agent === 'string' ? agent : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Spawns the agent the usual way, or under a run host when the run is bound
 * to one. The result exposes the ChildProcess surface the adapters use.
 */
export function spawnAgentProcess(command: string, args: string[], options: SpawnOptions & { cwd?: string }, run: {
  agent: string;
  deadlineAt?: number;
  host?: RunHostBinding;
  /** Groups hosts that share a resource, see liveRunHosts. */
  tag?: string;
}): ChildProcess {
  if (!run.host || !runHostsSupported()) return spawnWithDeadline(command, args, options, run.deadlineAt);
  if (run.host.attach) {
    const agent = runHostAgent(run.host.key);
    if (agent !== run.agent) throw new Error(`run host ${run.host.key} belongs to ${agent ?? 'an unknown agent'}, not ${run.agent}`);
    return attachHostedProcess(run.host.key) as unknown as ChildProcess;
  }
  return startHostedProcess({ key: run.host.key, command, args, cwd: options.cwd, env: options.env,
    deadlineAt: run.deadlineAt, agent: run.agent, tag: run.tag }) as unknown as ChildProcess;
}

/** The run host behind a process returned by spawnAgentProcess, if any. */
export function hostedProcessOf(child: unknown): HostedProcess | undefined {
  return child instanceof HostedProcess ? child : undefined;
}

function startHostedProcess(input: {
  key: string;
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  deadlineAt?: number;
  agent: string;
  tag?: string;
}): HostedProcess {
  const dir = hostDir(input.key);
  ensurePrivateRoot();
  // A retry reuses the key; its previous process has already exited.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { mode: 0o700 });
  const target = input.deadlineAt === undefined
    ? { command: input.command, args: [...input.args] }
    : deadlineGuardCommand(input.command, input.args, input.deadlineAt);
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ ...target, agent: input.agent, ...(input.tag ? { tag: input.tag } : {}),
    createdAt: Date.now() }), { mode: 0o600 });
  const hostLog = openSync(join(dir, 'host.log'), 'a', 0o600);
  let host: ChildProcess;
  try {
    host = spawnProcess(process.execPath, [HOST_SCRIPT, dir], {
      cwd: input.cwd, env: input.env, detached: true, stdio: ['ignore', 'ignore', hostLog],
    });
  } finally {
    closeSync(hostLog);
  }
  host.unref();
  return new HostedProcess(input.key, dir, host);
}

/** Agents read and write through the root, so it must belong to this user alone. */
function ensurePrivateRoot(): void {
  const root = runHostRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = statSync(root);
  if ((typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
    throw new Error(`run host directory ${root} must be private to the current user`);
  }
}

function attachHostedProcess(key: string): HostedProcess {
  return new HostedProcess(key, hostDir(key));
}

interface HostExit { code: number | null; signal: NodeJS.Signals | null; error?: string }

/** The bridge side of one run host: ChildProcess-shaped, backed by the host's socket and journals. */
class HostedProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private socket: Socket | undefined;
  private queued: Buffer[] = [];
  private ended = false;
  private detachedFromHost = false;
  private readonly connectBy = Date.now() + CONNECT_TIMEOUT_MS;

  constructor(readonly key: string, private readonly dir: string, private readonly host?: ChildProcess) {
    super();
    this.pid = host?.pid ?? readHostPid(dir);
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => { this.send('i', chunk); callback(); },
      final: (callback) => { this.send('c'); callback(); },
    });
    host?.once('error', (error) => this.finish({ code: null, signal: null, error: `run host failed to start: ${error.message}` }));
    this.connect();
  }

  /** True after detach(): the agent keeps running under its host. */
  get detached(): boolean {
    return this.detachedFromHost;
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.ended) return false;
    this.send('k', Buffer.from(String(signal)));
    return true;
  }

  /** Leave the agent running for the next bridge process; this side reports it as ended. */
  detach(): void {
    if (this.ended) return;
    this.detachedFromHost = true;
    this.socket?.destroy();
    log.info('run-host', 'detached', { key: this.key, pid: this.pid ?? null });
    // Reported like a terminated child, so adapters settle the run as interrupted.
    this.finish({ code: null, signal: 'SIGTERM' });
  }

  private send(type: string, payload: Buffer = Buffer.alloc(0)): void {
    if (this.ended) return;
    const message = frame(type, payload);
    if (this.socket) this.socket.write(message);
    else this.queued.push(message);
  }

  private connect(): void {
    if (this.ended) return;
    const socket = connect(join(this.dir, 'sock'));
    let connected = false;
    let pending: Buffer = Buffer.alloc(0);
    socket.once('connect', () => {
      connected = true;
      if (this.ended) { socket.destroy(); return; }
      this.socket = socket;
      socket.write(frame('a', Buffer.from(JSON.stringify({ o: 0, e: 0 }))));
      for (const message of this.queued) socket.write(message);
      this.queued = [];
    });
    socket.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1);
        if (pending.length < 5 + length) break;
        this.receive(pending.toString('latin1', 0, 1), pending.subarray(5, 5 + length));
        pending = pending.subarray(5 + length);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.ended) return;
      if (connected) {
        // The host always sends its exit before closing; anything else means it died.
        this.finish(this.readExit() ?? { code: null, signal: 'SIGKILL', error: 'run host connection lost' });
        return;
      }
      if (existsSync(join(this.dir, 'exit.json'))) { this.replayFinishedHost(); return; }
      const hostStarting = this.host && this.host.exitCode === null && this.host.signalCode === null;
      if (hostStarting && Date.now() < this.connectBy) { setTimeout(() => this.connect(), 25); return; }
      this.finish({ code: null, signal: 'SIGKILL', error: `run host is not running${hostLogTail(this.dir)}` });
    });
  }

  private receive(type: string, payload: Buffer): void {
    if (type === 'o') this.stdout.write(payload);
    else if (type === 'e') this.stderr.write(payload);
    else if (type === 'x') this.finish(JSON.parse(payload.toString('utf8')) as HostExit);
    // The previous bridge process ended the agent's input; later input cannot be delivered.
    else if (type === 'r' && (JSON.parse(payload.toString('utf8')) as { stdinClosed?: boolean }).stdinClosed) this.stdin.destroy();
  }

  /** The agent finished while no bridge was attached; its journals hold the whole run. */
  private replayFinishedHost(): void {
    for (const [name, stream] of [['stdout', this.stdout], ['stderr', this.stderr]] as const) {
      try { stream.write(readFileSync(join(this.dir, name))); } catch { /* empty journal */ }
    }
    this.finish(this.readExit() ?? { code: null, signal: 'SIGKILL', error: 'run host exit record unreadable' });
  }

  private readExit(): HostExit | undefined {
    try { return JSON.parse(readFileSync(join(this.dir, 'exit.json'), 'utf8')) as HostExit; } catch { return undefined; }
  }

  private finish(exit: HostExit): void {
    if (this.ended) return;
    this.ended = true;
    this.queued = [];
    this.socket?.end();
    this.exitCode = exit.code;
    this.signalCode = exit.signal;
    if (exit.error) this.emit('error', new Error(exit.error));
    this.stdin.destroy();
    // Like a real child, `close` follows once the output has been read to the end.
    const drained = Promise.all([once(this.stdout, 'end'), once(this.stderr, 'end')]);
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', exit.code, exit.signal);
    void drained.then(() => this.emit('close', exit.code, exit.signal), () => {});
  }
}

function frame(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'latin1');
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function hostLogTail(dir: string): string {
  try {
    const tail = readFileSync(join(dir, 'host.log'), 'utf8').trim().slice(-500);
    return tail ? `: ${tail}` : '';
  } catch {
    return '';
  }
}

function readHostPid(dir: string): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(join(dir, 'host.json'), 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' ? pid : undefined;
  } catch {
    return undefined;
  }
}
