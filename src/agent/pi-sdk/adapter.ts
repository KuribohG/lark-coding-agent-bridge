import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../../core/logger';
import { SpawnFailed } from '../errors';
import { parseEffort } from '../model-settings';
import { validateModelId } from '../models';
import { checkAgentAvailability, AgentPreflightError, type AgentAvailability } from '../preflight';
import { preparedRun, snapshotRunOptions } from '../prepared-run';
import { resolveSystemPrompt, type AgentSystemPrompt } from '../system-prompt';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentExecutionCapabilities,
  AgentInput,
  AgentInputReceipt,
  AgentRunOptions,
  NativeAgentRun,
  PreparedAgentRun,
  RunStopReason,
} from '../types';
import { withExecutionContract } from '../execution';
import { execSandboxWritePaths } from '../../platform/exec-sandbox';
import type { PiConfig } from '../pi/config';
import { PiRunTranslator } from '../pi/jsonl-translator';
import { piThinkingLevel } from '../pi/thinking';
import { PI_SDK_EXECUTION_CAPABILITIES } from './capabilities';
import { AsyncEventQueue } from './event-queue';
import { PiHostClient, type PiHostLaunch, type PiHostRunAck, type PiHostSessionInfo } from './host-client';
import { PI_SDK_MIN_NODE, resolvePiAgentDir, resolvePiSdkPaths, type PiSdkPaths } from './paths';
import { localWorkflowEndpoint, openWorkflowTunnel, remoteRunEnv, shellQuote, type PiRemoteTarget, type WorkflowTunnel } from './remote';
import { WorkcellPool, workcellRuntimeLayout, WORKCELL_HOST_PORT, WORKCELL_IPC_PORT, type WorkcellRuntimeLayout } from './workcell';
import { piHostSpawnCommand, type PiHostSandbox } from './sandbox';

export interface PiSdkAdapterOptions {
  config: PiConfig;
  systemPrompt?: AgentSystemPrompt;
  env?: NodeJS.ProcessEnv;
  stopGraceMs?: number;
  profileStateDir?: string;
  /**
   * Profile-scoped Landlock domain for the shared host. Applied once when the
   * host starts; a run's own cwd is not part of it.
   */
  sandbox?: PiHostSandbox;
}

const OPEN_TIMEOUT_MS = 60_000;
const PROMPT_ACK_TIMEOUT_MS = 30_000;
const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

interface RunState {
  runId: string;
  /** Host that serves this run; a workcell profile has one per member. */
  client?: PiHostClient;
  /** Member key, when this run owns a rented unit. */
  cellKey?: string;
  sessionId?: string;
  promptDispatched: boolean;
  ended: boolean;
  stopped: boolean;
  timedOut: boolean;
  stopGraceMs: number;
  deadlineSignal: Promise<void>;
  resolveDeadline: () => void;
  endSignal: Promise<void>;
  resolveEnd: () => void;
  forceEnd?: () => void;
  deadlineTimer?: NodeJS.Timeout;
  stopping?: boolean;
}

export class PiSdkAdapter implements AgentAdapter {
  readonly id = 'pi';
  readonly displayName = 'Pi Coding Agent (SDK)';
  readonly capabilities: AgentExecutionCapabilities = PI_SDK_EXECUTION_CAPABILITIES;

  private readonly config: PiConfig;
  private readonly systemPrompt: AgentSystemPrompt | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly defaultStopGraceMs: number;
  private client: PiHostClient | undefined;
  private starting: Promise<PiHostClient> | undefined;
  private paths: PiSdkPaths | undefined;
  private botIdentity: AgentBotIdentity | undefined;
  private readonly sandbox: PiHostSandbox | undefined;
  private readonly remote: PiRemoteTarget | undefined;
  private tunnel: WorkflowTunnel | undefined;
  private remoteNodeCheck: Promise<AgentAvailability> | undefined;
  /** Rented units and the host clients that serve them, keyed by workflow member. */
  private workcell: WorkcellPool | undefined;
  private workcellLayout: ((root: string) => WorkcellRuntimeLayout) | undefined;
  private readonly workcellClients = new Map<string, Promise<PiHostClient>>();
  /** Members with a run in flight; their cell must not be evicted. */
  private readonly workcellBusy = new Set<string>();
  private readonly workcellLocations = new WeakMap<PiHostClient, { root: string; endpoint?: string }>();
  private readonly workcellSessions: string | undefined;
  private tunnelEndpoint: string | undefined;
  /** cwds already reported as outside the profile-scoped sandbox. */
  private readonly unwritableCwds = new Set<string>();
  /** Run ids whose event streams have not finished; shutdown waits for them. */
  private readonly activeRuns = new Set<string>();
  private idleWaiters = new Set<() => void>();
  private shuttingDown = false;

  constructor(opts: PiSdkAdapterOptions) {
    this.config = opts.config;
    this.systemPrompt = opts.systemPrompt;
    this.env = { ...opts.env };
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.sandbox = opts.sandbox?.settings.enabled ? opts.sandbox : undefined;
    this.remote = opts.config.remote && opts.profileStateDir
      ? {
        destination: opts.config.remote,
        stateDir: opts.profileStateDir,
        ...(opts.config.sshOptions ? { sshOptions: opts.config.sshOptions } : {}),
      }
      : undefined;
    this.workcellSessions = opts.profileStateDir && opts.config.workcell
      ? join(opts.profileStateDir, 'workcell-sessions')
      : undefined;
    if (opts.config.remote && !opts.profileStateDir) {
      throw new Error('pi.remote needs a profile state directory for the environment file');
    }
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  /**
   * Stop the shared host; the next run starts a fresh one. Active runs keep
   * their host until they finish (the bridge keeps them alive across a config
   * swap), so the caller never has to sequence a restart behind a drain.
   */
  async shutdown(waitMs = 30 * 60_000): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await this.waitForIdle(waitMs);
    await this.closeTunnel();
    if (this.activeRuns.size > 0) {
      // A run started while the drain was in progress; disposing now would cut
      // it off, so leave the host to the next shutdown request.
      log.warn('agent', 'pi-sdk-shutdown-raced', { activeRuns: this.activeRuns.size });
      this.shuttingDown = false;
      return;
    }
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    this.paths = undefined;
    await client?.dispose();
    const workcellClients = [...this.workcellClients.values()];
    this.workcellClients.clear();
    await Promise.allSettled(workcellClients.map(async (opening) => (await opening.catch(() => undefined))?.dispose()));
    const pool = this.workcell;
    this.workcell = undefined;
    await pool?.close();
  }

  private waitForIdle(timeoutMs: number): Promise<void> {
    if (this.activeRuns.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.idleWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        log.warn('agent', 'pi-sdk-shutdown-timeout', { activeRuns: this.activeRuns.size });
        // Dispose anyway, but leave the reason in the log: the host's per-session
        // view (run age, last event) is the only way to see a wedged session.
        void this.logHealth('shutdown-timeout');
        done();
      }, timeoutMs);
      timer.unref?.();
      this.idleWaiters.add(done);
    });
  }

  /**
   * A profile-scoped domain cannot add a run's cwd after the fact, so a run
   * whose working directory is not under a writable root will fail with EACCES
   * on its first write. Say so once per cwd instead of leaving the failure bare.
   */
  private warnOnUnwritableCwd(opts: AgentRunOptions): void {
    const sandbox = this.sandbox;
    const cwd = opts.cwd;
    if (!sandbox || !cwd || this.unwritableCwds.has(cwd)) return;
    const writable = execSandboxWritePaths({
      settings: sandbox.settings,
      env: this.env,
      agent: 'pi',
      roots: [...sandbox.roots, resolvePiAgentDir(this.config)],
    });
    // Compare resolved paths: the home directory is usually a symlink, and the
    // launcher resolves its rules while this check only has strings.
    const target = canonicalPath(cwd);
    const covered = writable.some((root) => {
      const resolved = canonicalPath(root);
      return target === resolved || target.startsWith(resolved.endsWith('/') ? resolved : `${resolved}/`);
    });
    this.unwritableCwds.add(cwd);
    if (covered) return;
    log.warn('agent', 'pi-sdk-sandbox-cwd-read-only', { cwd, writable });
  }

  /**
   * The workflow endpoint listens on the bridge's loopback only. A remote host
   * reaches it through a reverse tunnel, so the run environment it receives
   * names the tunnel; the local-only endpoint file is dropped.
   */
  private async withRemoteEndpoint(opts: AgentRunOptions): Promise<AgentRunOptions> {
    const env = opts.env;
    const local = env ? localWorkflowEndpoint(env) : undefined;
    if (!env || !local) return opts;
    const endpoint = await this.remoteEndpoint(local);
    return Object.freeze({ ...opts, env: Object.freeze(remoteRunEnv(env, endpoint)) });
  }

  private async remoteEndpoint(localEndpoint: string): Promise<string> {
    const target = this.remote;
    if (!target) return localEndpoint;
    if (this.tunnel && this.tunnelEndpoint === localEndpoint) return this.tunnel.endpoint;
    await this.closeTunnel();
    const tunnel = await openWorkflowTunnel(target, localEndpoint);
    this.tunnel = tunnel;
    this.tunnelEndpoint = localEndpoint;
    return tunnel.endpoint;
  }

  private async closeTunnel(): Promise<void> {
    const tunnel = this.tunnel;
    this.tunnel = undefined;
    this.tunnelEndpoint = undefined;
    await tunnel?.close();
  }

  /**
   * The runtime that matters is the one on the target machine, so a remote
   * profile asks the node itself. One ssh round trip per adapter, not per run:
   * a bridge restart or a config reload builds a new adapter.
   */
  private checkNode(paths: PiSdkPaths): Promise<AgentAvailability> {
    const remote = this.remote;
    if (!remote) {
      return checkAgentAvailability({
        agentId: 'pi',
        agentName: this.displayName,
        command: paths.nodePath,
        binaryPath: paths.nodePath,
        // `node --version` prints `v22.23.3`; the shared version matcher expects
        // a plain `\d+.\d+.\d+` token, so ask Node for the bare version.
        args: ['-p', 'process.versions.node'],
        env: this.env,
        minimumVersion: PI_SDK_MIN_NODE.join('.'),
      });
    }
    this.remoteNodeCheck ??= checkAgentAvailability({
      agentId: 'pi',
      agentName: this.displayName,
      command: remote.ssh ?? 'ssh',
      binaryPath: paths.nodePath,
      args: [
        ...(remote.sshOptions ?? []),
        remote.destination,
        `${shellQuote(paths.nodePath)} -p process.versions.node`,
      ],
      env: this.env,
      minimumVersion: PI_SDK_MIN_NODE.join('.'),
    });
    return this.remoteNodeCheck;
  }

  /**
   * A workcell profile keeps one host per workflow member: the member's session
   * lives in that unit, so reuse is what makes a multi-turn member cheap, and
   * releasing the key is what ends it.
   */
  private async ensureRunClient(opts: AgentRunOptions): Promise<PiHostClient> {
    // Only a workflow member carries a host key. An ordinary turn, and a member
    // that owns a git workspace (the engine disables its run host for those),
    // stay on the bridge machine: a cell cannot commit, and a per-conversation
    // unit would cost far more than it saves.
    const key = opts.host?.key;
    if (!this.config.workcell || !key) return this.ensureClient();
    const existing = this.workcellClients.get(key);
    if (existing) {
      const client = await existing.catch(() => undefined);
      if (client && !client.isClosed) return client;
      this.workcellClients.delete(key);
    }
    const opening = this.openWorkcellClient(key, opts.cwd, opts.env ? localWorkflowEndpoint(opts.env) : undefined);
    this.workcellClients.set(key, opening);
    try {
      return await opening;
    } catch (error) {
      if (this.workcellClients.get(key) === opening) this.workcellClients.delete(key);
      throw error;
    }
  }

  private async openWorkcellClient(key: string, workspace: string | undefined, endpoint: string | undefined): Promise<PiHostClient> {
    const pool = this.ensureWorkcellPool();
    const cell = await pool.acquire(key);
    // The unit's root is the provider's answer, so the host command uses the
    // paths that exist inside this particular unit.
    const layout = this.workcellLayout!(cell.root);
    // The host needs its agent directory and the workspace before it starts.
    if (workspace) await pool.ensureWorkspace(cell, workspace);
    await pool.startHost(cell, this.workcellHostScript(layout), this.workcellHostEnv(layout));
    const client = new PiHostClient({
      nodePath: layout.nodePath,
      hostScript: layout.hostScript,
      sdkPath: layout.sdkPath,
      agentDir: layout.agentDir,
      env: this.env,
      connection: { kind: 'tcp', host: '127.0.0.1', port: cell.hostPort },
      ...(this.config.idleTtlMs !== undefined ? { idleTtlMs: this.config.idleTtlMs } : {}),
      ...(this.config.maxSessions !== undefined ? { maxSessions: this.config.maxSessions } : {}),
    });
    this.workcellLocations.set(client, { root: cell.root, endpoint });
    client.onFrame((frame) => {
      if (frame.type === 'ipc.request') void this.answerWorkflowCall(client, frame);
    });
    try {
      await client.start();
    } catch (error) {
      // The unit is useless without a reachable host; do not leave it running.
      await pool.release(key);
      throw error;
    }
    log.info('agent', 'pi-workcell-host-connected', { key, workcell: cell.id, hostPort: cell.hostPort });
    return client;
  }

  private ensureWorkcellPool(): WorkcellPool {
    if (this.workcell) return this.workcell;
    const config = this.config.workcell;
    if (!config) throw new Error('pi.workcell is not configured');
    const paths = this.resolvePaths();
    const layoutFor = (root: string) => workcellRuntimeLayout({
      root,
      nodePath: paths.nodePath,
      sdkPath: paths.sdkPath,
      hostScript: paths.hostScript,
      workflowCli: bundledWorkflowCli(),
      ...(this.workcellSessions ? { archiveCacheDir: join(dirname(this.workcellSessions), 'workcell-runtime') } : {}),
    });
    this.workcellLayout = layoutFor;
    this.workcell = new WorkcellPool({
      config,
      layout: this.workcellLayout,
      canEvict: (key) => !this.workcellBusy.has(key),
      // A torn-down unit leaves its host client pointing at a closed port; drop
      // it so the member's next turn rents (and reconnects to) a fresh unit.
      onRelease: async (key) => {
        const opening = this.workcellClients.get(key);
        if (!opening) return;
        this.workcellClients.delete(key);
        const client = await opening.catch(() => undefined);
        await client?.dispose().catch(() => undefined);
      },
      agentFiles: piAgentFiles(resolvePiAgentDir(this.config)),
      ...(this.workcellSessions ? { sessionDir: this.workcellSessions } : {}),
      env: this.env,
    });
    return this.workcell;
  }

  private workcellHostScript(layout: WorkcellRuntimeLayout): string {
    const args = [
      layout.nodePath,
      layout.hostScript,
      // The forwarded connection arrives on the unit's interface (which may be
      // IPv6 only), so the host listens on every interface there.
      '--tcp', `:${WORKCELL_HOST_PORT}`,
      '--ipc-port', String(WORKCELL_IPC_PORT),
      '--sdk', layout.sdkPath,
      '--agent-dir', layout.agentDir,
      ...(this.config.idleTtlMs !== undefined ? ['--idle-ttl-ms', String(this.config.idleTtlMs)] : []),
      ...(this.config.maxSessions !== undefined ? ['--max-sessions', String(this.config.maxSessions)] : []),
      ...(this.config.sessionPersistence ? ['--session-persistence', this.config.sessionPersistence] : []),
    ];
    return `exec ${args.map(shellQuote).join(' ')}`;
  }

  private workcellHostEnv(layout: WorkcellRuntimeLayout): Record<string, string> {
    return {
      PI_TELEMETRY: '0',
      PI_SKIP_VERSION_CHECK: '1',
      PI_CODING_AGENT_DIR: layout.agentDir,
      // Tools inherit this, so `node "$AGENT_WORKFLOW_CLI"` works inside the unit.
      PATH: `${layout.nodePath.slice(0, layout.nodePath.lastIndexOf('/bin/'))}/bin:/usr/local/bin:/usr/bin:/bin`,
      AGENT_WORKFLOW_CLI: `${layout.hostScript.slice(0, layout.hostScript.lastIndexOf('/'))}/workflow-cli.js`,
    };
  }

  /**
   * A worker inside a unit cannot reach the bridge, so its workflow CLI calls
   * arrive as frames; the bridge performs the call against its own local-only
   * endpoint with the same bearer token the worker was given.
   */
  private async answerWorkflowCall(client: PiHostClient, frame: Record<string, unknown>): Promise<void> {
    const requestId = frame.requestId;
    const endpoint = this.workcellLocations.get(client)?.endpoint;
    if (!endpoint) {
      client.send({ type: 'ipc.response', requestId, status: 503, body: JSON.stringify({ ok: false, error: 'this run has no workflow endpoint' }) });
      return;
    }
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${String(frame.token ?? '')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: frame.method, args: frame.args }),
        signal: AbortSignal.timeout(30_000),
      });
      client.send({ type: 'ipc.response', requestId, status: response.status, body: await response.text() });
    } catch (error) {
      client.send({
        type: 'ipc.response',
        requestId,
        status: 502,
        body: JSON.stringify({ ok: false, error: `the bridge could not reach its workflow endpoint: ${errorMessage(error)}` }),
      });
    }
  }

  /**
   * Inside a unit the run's own environment has to point at the cell-local
   * workflow endpoint and the pushed CLI; the bridge-side paths mean nothing
   * there.
   */
  private withWorkcellEnv(opts: AgentRunOptions, root: string): AgentRunOptions {
    const cwd = opts.cwd ? posix.join(root, 'work') : opts.cwd;
    const env = opts.env;
    if (!env) return { ...opts, cwd };
    const next: Record<string, string> = { ...env };
    delete next.AGENT_WORKFLOW_ENDPOINT_FILE;
    if (next.AGENT_WORKFLOW_ENDPOINT || next.AGENT_WORKFLOW_CLI) {
      next.AGENT_WORKFLOW_ENDPOINT = `http://127.0.0.1:${WORKCELL_IPC_PORT}/workflow`;
      next.AGENT_WORKFLOW_CLI = posix.join(root, 'bin', 'workflow-cli.js');
    }
    return Object.freeze({ ...opts, cwd, env: Object.freeze(next) });
  }

  private async logHealth(context: string): Promise<void> {
    const client = this.client;
    if (!client || client.isClosed) return;
    try {
      const health = await client.request<Record<string, unknown>>('health', {}, 2_000);
      log.info('agent', 'pi-sdk-host-health', { context, ...health });
    } catch (error) {
      log.warn('agent', 'pi-sdk-host-health-failed', { context, message: errorMessage(error) });
    }
  }

  private runFinished(runId: string): void {
    this.activeRuns.delete(runId);
    if (this.activeRuns.size > 0) return;
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    let paths: PiSdkPaths;
    try {
      paths = this.resolvePaths();
    } catch (error) {
      const failure = new AgentPreflightError({
        code: 'agent-binary-not-found',
        agentId: 'pi',
        agentName: this.displayName,
        command: this.config.binaryPath,
        binaryPath: this.config.binaryPath,
        field: 'sdkPath',
        ...(error instanceof Error ? { stderrExcerpt: error.message.slice(0, 500) } : {}),
      });
      return { ok: false, error: failure, diagnostic: failure.diagnostic };
    }

    if (this.config.workcell && !existsSync(this.config.workcell.provider)) {
      const failure = new AgentPreflightError({
        code: 'agent-binary-not-found',
        agentId: 'pi',
        agentName: this.displayName,
        command: this.config.workcell.provider,
        binaryPath: this.config.workcell.provider,
        field: 'workcell.provider',
      });
      return { ok: false, error: failure, diagnostic: failure.diagnostic };
    }

    if (this.sandbox) {
      // The domain is applied when the host starts, so `require_landlock` has
      // to fail here — otherwise the profile looks healthy and every run fails.
      try {
        piHostSpawnCommand(paths.nodePath, [], this.sandbox, this.env);
      } catch (error) {
        const failure = new AgentPreflightError({
          code: 'agent-binary-not-found',
          agentId: 'pi',
          agentName: this.displayName,
          command: paths.nodePath,
          binaryPath: paths.nodePath,
          field: 'sandbox',
          ...(error instanceof Error ? { stderrExcerpt: error.message.slice(0, 500) } : {}),
        });
        return { ok: false, error: failure, diagnostic: failure.diagnostic };
      }
    }

    const node = await this.checkNode(paths);
    if (!node.ok) return node;

    for (const [file, field] of [
      [paths.sdkPath, 'sdkPath'],
      [paths.hostScript, 'hostScript'],
    ] as const) {
      if (existsSync(file)) continue;
      const failure = new AgentPreflightError({
        code: 'agent-binary-not-found',
        agentId: 'pi',
        agentName: this.displayName,
        command: file,
        binaryPath: file,
        field,
      });
      return { ok: false, error: failure, diagnostic: failure.diagnostic };
    }
    return { ok: true, version: node.version };
  }

  async prepareRun(input: AgentRunOptions): Promise<PreparedAgentRun> {
    const snapshot = snapshotRunOptions({
      ...input,
      systemPrompt: input.systemPrompt ?? resolveSystemPrompt(this.systemPrompt, this.botIdentity),
    });
    const opts = this.remote ? await this.withRemoteEndpoint(snapshot) : snapshot;
    if (!opts.cwd) throw new Error('cwd is required for pi sdk preparation');
    if (opts.forkSession && !opts.sessionId) throw new Error('fork requires a parent session');
    if (opts.model) validateModelId(opts.model);
    if (opts.reasoningEffort) parseEffort(opts.reasoningEffort, 'pi');
    if (opts.sandbox === 'workspace-write') {
      throw new SpawnFailed(
        'Pi has no portable workspace sandbox; use read-only or full access',
        new Error('Pi has no portable workspace sandbox; use read-only or full access'),
        'agent-prepare-failed',
      );
    }
    if (opts.execSandbox?.enabled && !this.sandbox) {
      // Only reachable when a run carries sandbox settings the adapter was not
      // built with. Refuse instead of running unsandboxed behind the caller's back.
      throw new SpawnFailed(
        'pi sdk host has no exec sandbox',
        new Error('The Pi SDK host was started without the profile exec sandbox; rebuild the adapter from the current profile'),
        'agent-prepare-failed',
      );
    }
    this.warnOnUnwritableCwd(opts);
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'pi sdk availability check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
    return preparedRun(
      { model: opts.model, reasoningEffort: opts.reasoningEffort },
      () => withExecutionContract(this.startRun(opts), this.capabilities),
    );
  }

  private startRun(opts: AgentRunOptions): NativeAgentRun {
    if (!opts.cwd) throw new Error('cwd is required for PiSdkAdapter.run');
    const sandbox = opts.sandbox ?? 'danger-full-access';
    if (sandbox === 'workspace-write') {
      throw new Error('Pi has no portable workspace sandbox; use read-only or full access');
    }

    const state = createRunState(opts, this.defaultStopGraceMs);
    if (opts.deadlineAt !== undefined) {
      state.deadlineTimer = setTimeout(() => {
        state.timedOut = true;
        state.resolveDeadline();
        void this.stopRun(state, 'deadline');
      }, Math.max(0, opts.deadlineAt - Date.now()));
      state.deadlineTimer.unref?.();
    }
    return {
      runId: opts.runId,
      events: this.runEvents(opts, state, sandbox),
      sendInput: async (input: AgentInput) => this.steerRun(state, input),
      stop: (reason?: RunStopReason) => this.stopRun(state, reason),
      waitForExit: async (timeoutMs: number) => waitForSignal(state.endSignal, timeoutMs),
    };
  }

  private async steerRun(state: RunState, input: AgentInput): Promise<AgentInputReceipt> {
    if (state.ended || !state.sessionId) {
      return { status: 'inactive', messageId: input.messageId };
    }
    const client = state.client ?? this.client;
    if (!client || client.isClosed) {
      return { status: 'inactive', messageId: input.messageId };
    }
    try {
      await client.request('run.steer', {
        sessionId: state.sessionId,
        runId: state.runId,
        text: input.text,
      }, 10_000);
      return { status: 'accepted', messageId: input.messageId, scope: 'active-turn' };
    } catch (error) {
      // A lost acknowledgement is not proof of rejection; never auto-replay.
      return { status: 'unknown', messageId: input.messageId, message: errorMessage(error) };
    }
  }

  private async *runEvents(
    opts: AgentRunOptions,
    state: RunState,
    sandbox: string,
  ): AsyncGenerator<AgentEvent> {
    const translator = new PiRunTranslator(opts.answerIncludesInterimText === true);
    let offFrame: (() => void) | undefined;
    let queue: AsyncEventQueue<AgentEvent> | undefined;
    this.activeRuns.add(state.runId);
    try {
      let client: PiHostClient;
      // Busy from before the unit is acquired: an eviction that lands while the
      // host is still starting would kill the cell this run is waiting for.
      if (opts.host?.key && this.config.workcell) {
        state.cellKey = opts.host.key;
        this.workcellBusy.add(opts.host.key);
      }
      try {
        client = await this.ensureRunClient(opts);
        state.client = client;
      } catch (error) {
        yield errorEvent(`failed to start pi sdk host: ${errorMessage(error)}`);
        return;
      }
      if (state.stopped || state.timedOut) {
        yield doneEvent(undefined, state.timedOut ? 'timeout' : 'interrupted');
        return;
      }

      const location = this.workcellLocations.get(client);
      const hostOpts = location ? this.withWorkcellEnv(opts, location.root) : opts;
      let opened: PiHostSessionInfo | undefined;
      try {
        opened = await untilDeadline(
          client.request<PiHostSessionInfo>('session.open', this.openParams(hostOpts, sandbox), OPEN_TIMEOUT_MS),
          state,
        );
      } catch (error) {
        if (state.timedOut) {
          yield doneEvent(undefined, 'timeout');
          return;
        }
        if (state.stopped) {
          yield doneEvent(undefined, 'interrupted');
          return;
        }
        yield errorEvent(`pi sdk session failed: ${errorMessage(error)}`);
        return;
      }
      if (!opened) {
        yield doneEvent(undefined, state.timedOut ? 'timeout' : 'interrupted');
        return;
      }
      state.sessionId = opened.sessionId;
      for (const event of translator.translate({
        type: 'session',
        id: opened.sessionId,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      })) {
        yield event;
      }
      // A stop/deadline can land while the consumer is between events.
      if (state.stopped || state.timedOut) {
        yield doneEvent(state.sessionId, state.timedOut ? 'timeout' : 'interrupted');
        return;
      }

      let endOutcome: string | undefined;
      let endError: string | undefined;
      queue = new AsyncEventQueue<AgentEvent>();
      state.forceEnd = () => queue!.end();
      offFrame = client.onFrame((frame) => {
        if (
          frame.type === 'run.event' &&
          frame.sessionId === state.sessionId &&
          frame.runId === state.runId &&
          frame.event !== undefined
        ) {
          for (const event of translator.translate(frame.event)) queue!.push(event);
          if (translator.terminalEmitted()) queue!.end();
          return;
        }
        if (frame.type === 'run.end' && frame.sessionId === state.sessionId && frame.runId === state.runId) {
          endOutcome = typeof frame.outcome === 'string' ? frame.outcome : 'settled';
          endError = typeof frame.error === 'string' ? frame.error : undefined;
          queue!.end();
          return;
        }
        if (frame.type === 'host.exit') {
          queue!.push({
            type: 'error',
            message: `pi sdk host exited during the run: ${String(frame.error ?? 'unknown reason')}`,
            terminationReason: 'failed',
          });
          queue!.end();
        }
      });

      try {
        if (state.stopped || state.timedOut) {
          yield doneEvent(state.sessionId, state.timedOut ? 'timeout' : 'interrupted');
          return;
        }
        state.promptDispatched = true;
        const ack = await untilDeadline(
          client.request<PiHostRunAck>('run.prompt', this.promptParams(hostOpts, state), PROMPT_ACK_TIMEOUT_MS),
          state,
        );
        if (!ack) throw new Error('pi sdk host did not acknowledge the prompt before the deadline');
      } catch (error) {
        if (state.timedOut) {
          void this.stopRun(state, 'deadline');
          yield doneEvent(state.sessionId, 'timeout');
          return;
        }
        if (state.stopped) {
          yield doneEvent(state.sessionId, 'interrupted');
          return;
        }
        yield errorEvent(`pi sdk prompt failed: ${errorMessage(error)}`);
        return;
      }

      let sawTerminal = false;
      for await (const event of queue) {
        const shaped = state.timedOut && (event.type === 'done' || event.type === 'error')
          ? doneEvent(state.sessionId, 'timeout')
          : event;
        if (shaped.type === 'done' || shaped.type === 'error') sawTerminal = true;
        yield shaped;
      }
      if (sawTerminal) return;
      if (state.timedOut) {
        yield doneEvent(state.sessionId, 'timeout');
        return;
      }
      if (endOutcome === 'error') {
        yield errorEvent(endError ?? 'pi sdk run failed');
        return;
      }
      if (endOutcome === 'aborted' || state.stopped) {
        yield doneEvent(state.sessionId, 'interrupted');
        return;
      }
      for (const event of translator.finish({
        exitCode: 0,
        stderr: '',
        interrupted: false,
        timedOut: false,
      })) {
        yield event;
      }
    } finally {
      offFrame?.();
      state.ended = true;
      if (state.deadlineTimer) clearTimeout(state.deadlineTimer);
      state.resolveEnd();
      if (state.cellKey) {
        this.workcellBusy.delete(state.cellKey);
        // The member's unit stays warm for its next turn, but only until the idle
        // release fires; a unit nobody comes back to is torn down and its
        // sessions are pulled out for the next one.
        this.workcell?.markIdle(state.cellKey);
      }
      this.runFinished(state.runId);
    }
  }

  private openParams(opts: AgentRunOptions, sandbox: string): Record<string, unknown> {
    const systemPrompt = opts.systemPrompt ?? resolveSystemPrompt(this.systemPrompt, this.botIdentity);
    const thinkingLevel = this.thinkingLevel(opts);
    const readOnly = sandbox === 'read-only';
    return {
      ...(opts.sessionId && !opts.forkSession ? { sessionId: opts.sessionId } : {}),
      ...(opts.forkSession ? { forkFrom: opts.sessionId } : {}),
      cwd: opts.cwd,
      systemPrompt,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.modelProvider?.pi ? { modelProvider: opts.modelProvider.pi } : {}),
      ...(opts.modelProvider?.env ? { providerEnv: opts.modelProvider.env } : {}),
      ...(opts.env ? { runEnv: opts.env } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(readOnly ? { tools: [...READ_ONLY_TOOLS] } : {}),
      noExtensions: readOnly || opts.deadlineAt !== undefined,
      ...(this.config.sessionPersistence ? { sessionPersistence: this.config.sessionPersistence } : {}),
    };
  }

  private promptParams(opts: AgentRunOptions, state: RunState): Record<string, unknown> {
    const thinkingLevel = this.thinkingLevel(opts);
    return {
      sessionId: state.sessionId,
      runId: state.runId,
      text: opts.prompt,
      systemPrompt: opts.systemPrompt ?? resolveSystemPrompt(this.systemPrompt, this.botIdentity),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.modelProvider?.pi ? { modelProvider: opts.modelProvider.pi } : {}),
      ...(opts.modelProvider?.env ? { providerEnv: opts.modelProvider.env } : {}),
      ...(opts.env ? { runEnv: opts.env } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  }

  private thinkingLevel(opts: AgentRunOptions): string | undefined {
    if (!opts.reasoningEffort) return undefined;
    const effort = parseEffort(opts.reasoningEffort, 'pi');
    return effort ? piThinkingLevel(effort) : undefined;
  }

  private async stopRun(state: RunState, reason?: RunStopReason): Promise<void> {
    if (reason === 'deadline') state.timedOut = true;
    state.stopped = !state.timedOut;
    if (state.ended || state.stopping) return;
    state.stopping = true;
    const client = state.client ?? this.client;
    if (!client || client.isClosed || !state.sessionId) {
      state.forceEnd?.();
      if (!state.sessionId) {
        // Startup never finished; the generator observes `stopped` once it runs.
        state.resolveDeadline();
      }
      return;
    }
    if (!state.promptDispatched) {
      // The run has not reached the host yet; the generator checks `stopped`
      // before dispatching and will not start it.
      state.forceEnd?.();
      return;
    }
    const graceMs = Math.max(500, state.stopGraceMs);
    try {
      await client.request('run.abort', { sessionId: state.sessionId, runId: state.runId }, graceMs);
    } catch (error) {
      log.warn('agent', 'pi-sdk-abort-failed', { message: errorMessage(error), runId: state.runId });
    }
    if (await waitForSignal(state.endSignal, graceMs)) return;
    try {
      await client.request('session.dispose', { sessionId: state.sessionId }, 5000);
    } catch (error) {
      log.warn('agent', 'pi-sdk-dispose-failed', { message: errorMessage(error), runId: state.runId });
    }
    state.forceEnd?.();
  }

  private async ensureClient(): Promise<PiHostClient> {
    if (this.client && !this.client.isClosed) return this.client;
    if (this.starting) return this.starting;
    const paths = this.resolvePaths();
    const agentDir = resolvePiAgentDir(this.config);
    const launch: PiHostLaunch = {
      nodePath: paths.nodePath,
      hostScript: paths.hostScript,
      sdkPath: paths.sdkPath,
      agentDir,
      ...(this.sandbox
        ? { sandbox: { ...this.sandbox, roots: [...this.sandbox.roots, agentDir] } }
        : {}),
      ...(this.remote ? { remote: this.remote } : {}),
      env: this.env,
      ...(this.config.idleTtlMs !== undefined ? { idleTtlMs: this.config.idleTtlMs } : {}),
      ...(this.config.maxSessions !== undefined ? { maxSessions: this.config.maxSessions } : {}),
    };
    const client = new PiHostClient(launch);
    this.client = client;
    const starting = client.start()
      .then(() => client)
      .catch((error) => {
        if (this.client === client) this.client = undefined;
        throw error;
      })
      .finally(() => {
        if (this.starting === starting) this.starting = undefined;
      });
    this.starting = starting;
    return starting;
  }

  private resolvePaths(): PiSdkPaths {
    this.paths ??= resolvePiSdkPaths(this.config);
    return this.paths;
  }
}

function createRunState(opts: AgentRunOptions, defaultStopGraceMs: number): RunState {
  let resolveDeadline!: () => void;
  const deadlineSignal = new Promise<void>((resolve) => {
    resolveDeadline = resolve;
  });
  let resolveEnd!: () => void;
  const endSignal = new Promise<void>((resolve) => {
    resolveEnd = resolve;
  });
  return {
    runId: opts.runId,
    promptDispatched: false,
    ended: false,
    stopped: false,
    timedOut: false,
    stopGraceMs: opts.stopGraceMs ?? defaultStopGraceMs,
    deadlineSignal,
    resolveDeadline,
    endSignal,
    resolveEnd,
  };
}

async function untilDeadline<T>(promise: Promise<T>, state: RunState): Promise<T | undefined> {
  const result = await Promise.race([
    promise.then((value) => ({ value })),
    state.deadlineSignal.then(() => ({ deadline: true as const })),
  ]);
  return 'deadline' in result ? undefined : result.value;
}

function waitForSignal(signal: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    void signal.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function doneEvent(
  sessionId: string | undefined,
  terminationReason: 'normal' | 'interrupted' | 'timeout',
): AgentEvent {
  return {
    type: 'done',
    ...(sessionId ? { sessionId } : {}),
    terminationReason,
  };
}

function errorEvent(message: string): AgentEvent {
  return { type: 'error', message: message.slice(0, 4096), terminationReason: 'failed' };
}

/** The workflow CLI bundled with this build, pushed so workers can call it. */
function bundledWorkflowCli(): string | undefined {
  const candidate = new URL('./workflow-cli.js', import.meta.url);
  return candidate.protocol === 'file:' && existsSync(fileURLToPath(candidate)) ? fileURLToPath(candidate) : undefined;
}

/** Credentials and catalog files the host needs; sessions are archived outside the unit. */
function piAgentFiles(agentDir: string): string[] {
  return ['auth.json', 'models.json', 'settings.json']
    .map((name) => join(agentDir, name))
    .filter((path) => existsSync(path));
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
