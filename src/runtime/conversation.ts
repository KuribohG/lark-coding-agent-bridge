import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeCapability, codexCapability } from '../agent/capability';
import { sendRunInput } from '../agent/execution';
import type { AgentAdapter, AgentInput, AgentInputReceipt } from '../agent/types';
import { ActiveRuns } from './active-runs';
import { ProcessPool } from './process-pool';
import { recordRunSessionEvent, startRunFlow } from './run-flow';
import type { RunProfileConfig } from '../config/profile-schema';
import type { AgentAttachment } from '../policy/run-policy';
import { RunExecutor } from './run-executor';
import { presentRunOutput, type RunOutputPlugin } from './run-output';
import { SessionCatalog } from '../session/catalog';
import { SessionStore } from '../session/store';
import { WorkspaceStore } from '../workspace/store';

export interface ConversationIdentity {
  /** Supplied by the host's authenticated session, never trusted from a request body. */
  actorId: string;
  conversationId: string;
}

export interface ConversationRuntimeOptions {
  agent: AgentAdapter;
  config: RunProfileConfig;
  /** Use a private directory owned by this host process. */
  stateDir: string;
  namespace: string;
  channelId: string;
  authorize(identity: ConversationIdentity): Promise<boolean>;
  systemPrompt?: string;
}

export interface ConversationInput extends ConversationIdentity {
  prompt: string;
  /** Resolved and validated by the host's upload pipeline. */
  attachments?: AgentAttachment[];
  signal?: AbortSignal;
  deadlineAt?: number;
}

export async function createConversationRuntime(options: ConversationRuntimeOptions): Promise<ConversationRuntime> {
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const runtime = new ConversationRuntime(options);
  await runtime.load();
  return runtime;
}

/** Server-side conversations using the same policy, session and executor as IM. */
export class ConversationRuntime {
  private readonly sessions: SessionStore;
  private readonly catalog: SessionCatalog;
  private readonly workspaces: WorkspaceStore;
  private readonly active = new ActiveRuns();
  private readonly executor: RunExecutor;
  private readonly pending = new Set<AbortController>();
  private readonly starts = new Set<Promise<unknown>>();
  private readonly outputs = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly options: ConversationRuntimeOptions) {
    if (!options.channelId.trim()) throw new Error('channelId is required');
    if (!options.namespace.trim()) throw new Error('namespace is required');
    if (options.agent.id !== options.config.agentKind) throw new Error('agent does not match config.agentKind');
    this.sessions = new SessionStore(join(options.stateDir, 'sessions.json'));
    this.catalog = new SessionCatalog(join(options.stateDir, 'sessions.catalog.json'));
    this.workspaces = new WorkspaceStore(join(options.stateDir, 'workspaces.json'));
    this.executor = new RunExecutor({ agent: options.agent, activeRuns: this.active,
      pool: new ProcessPool(() => Math.max(1, options.config.preferences.maxConcurrentRuns ?? 4)) });
  }

  async load(): Promise<void> {
    await Promise.all([this.sessions.load(), this.catalog.load(), this.workspaces.load()]);
  }

  start(input: ConversationInput, output: RunOutputPlugin) {
    const pending = this.startRun(input, output);
    this.starts.add(pending);
    void pending.then(() => this.starts.delete(pending), () => this.starts.delete(pending));
    return pending;
  }

  private async startRun(input: ConversationInput, output: RunOutputPlugin) {
    const scopeId = await this.authorizedScope(input);
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('prompt is required');
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    this.pending.add(controller);
    const dispose = () => {
      this.pending.delete(controller);
      input.signal?.removeEventListener('abort', abort);
    };
    const config = this.options.config;
    const capability = config.agentKind === 'codex' ? codexCapability(config) : claudeCapability(config);
    try {
      const flow = await startRunFlow({
        scopeId, scope: { source: 'channel', channelId: this.options.channelId,
          actorId: input.actorId, conversationId: input.conversationId },
        prompt: input.prompt, systemPrompt: this.options.systemPrompt ?? '',
        signal: controller.signal, deadlineAt: input.deadlineAt,
        attachments: input.attachments ?? [], access: { ok: true, reason: 'allowed-user' },
        capability, profileConfig: config, sessions: this.sessions, sessionCatalog: this.catalog,
        workspaces: this.workspaces, executor: this.executor, now: Date.now(),
      });
      if (!flow.ok) { dispose(); return flow; }
      const done = presentRunOutput(flow.execution, output, {
        idleTimeoutMs: config.preferences.runIdleTimeoutMinutes
          ? config.preferences.runIdleTimeoutMinutes * 60_000 : undefined,
        filterForPrefs: state => state,
        recordSession: event => recordRunSessionEvent({ scopeId, sessions: this.sessions,
          sessionCatalog: this.catalog, capability, policy: flow.policy, event }),
      }).finally(dispose);
      this.outputs.add(done);
      // Keep rejection observable on `done`, while close() tracks all active outputs.
      void done.then(() => this.outputs.delete(done), () => this.outputs.delete(done));
      return { ...flow, done };
    } catch (error) { dispose(); throw error; }
  }

  async stop(identity: ConversationIdentity, runId: string): Promise<boolean> {
    const scope = await this.authorizedScope(identity);
    const handle = this.active.get(scope);
    if (!handle || handle.run.runId !== runId) return false;
    handle.interrupted = true;
    await handle.run.stop();
    return true;
  }

  async sendInput(identity: ConversationIdentity, runId: string, input: AgentInput): Promise<AgentInputReceipt> {
    const scope = await this.authorizedScope(identity);
    const run = this.active.get(scope)?.run;
    if (!run || run.runId !== runId) return { status: 'inactive', messageId: input.messageId };
    return sendRunInput(run, input);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.pending) controller.abort();
    await Promise.allSettled(this.active.snapshot().map(handle => handle.run.stop()));
    await Promise.allSettled(this.starts);
    await Promise.allSettled(this.outputs);
    await Promise.all([this.sessions.flush(), this.catalog.flush(), this.workspaces.flush()]);
  }

  private async authorizedScope(identity: ConversationIdentity): Promise<string> {
    if (this.closed) throw new Error('runtime is closed');
    for (const value of [identity.actorId, identity.conversationId]) {
      if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) throw new Error('invalid conversation identity');
    }
    if (!await this.options.authorize({ actorId: identity.actorId, conversationId: identity.conversationId })) {
      throw new Error('conversation access denied');
    }
    if (this.closed) throw new Error('runtime is closed');
    return `channel:${JSON.stringify([this.options.channelId, this.options.namespace, identity.actorId, identity.conversationId])}`;
  }
}
