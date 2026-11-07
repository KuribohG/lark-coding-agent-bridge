import { trackRunSession } from './session-progress';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sendRunInput } from '../agent/execution';
import type { AgentInput, AgentInputReceipt, AgentQuestionAnswer } from '../agent/types';
import { agentBackendSpec } from '../agent/backend-spec';
import { resolveAgentState } from '../agent/state-layout';
import { log } from '../core/logger';
import { ActiveRuns, stopRun } from './active-runs';
import { RunStopped } from './errors';
import { ProcessPool } from './process-pool';
import { resolveRunFlowContext, startRunFlow } from './run-flow';
import type { AgentKind, RunProfileConfig } from '../config/profile-schema';
import type { AgentAttachment } from '../policy/run-policy';
import { resolveWorkingDirectory } from '../policy/workspace';
import { RunExecutor } from './run-executor';
import { presentRunOutput, type RunOutputPlugin } from './run-output';
import { SessionCatalog } from '../session/catalog';
import { listCodexThreadHistory } from '../session/codex-history';
import { listRecentSessions } from '../session/history';
import { SessionStore } from '../session/store';
import { WorkspaceStore } from '../workspace/store';
import { profileForAgentKind, type ExecutionController } from './execution-controller';

export interface ConversationIdentity {
  /** Supplied by the host's authenticated session, never trusted from a request body. */
  actorId: string;
  conversationId: string;
}

export interface ConversationRuntimeOptions {
  /** Shared execution controller. */
  execution: ExecutionController;
  config: RunProfileConfig;
  /** Resolve engine-specific run settings for the selected backend, optionally per conversation. */
  configForAgent?: (agentKind: AgentKind, identity: ConversationIdentity) => RunProfileConfig;
  /** Use a private directory owned by this host process. */
  stateDir: string;
  namespace: string;
  channelId: string;
  authorize(identity: ConversationIdentity): Promise<boolean>;
  systemPrompt?: string;
  /** Let the agent ask the host blocking questions; the host answers them with answerQuestion. */
  userQuestions?: boolean;
  /** The execution controller's profile directory, where default agent homes such as Codex's live. */
  profileDir?: string;
  /** Native history readers; replaceable for tests. */
  history?: {
    claude?: typeof listRecentSessions;
    codex?: typeof listCodexThreadHistory;
  };
}

/** A native session the conversation could continue, as listed by the agent's own history. */
export interface ConversationSessionCandidate {
  /** Native session id (Claude, catalog kinds) or thread id (Codex). */
  id: string;
  preview: string;
  updatedAt?: number;
  current: boolean;
}

export interface ConversationSessionList {
  agentKind: AgentKind;
  cwd: string;
  current?: string;
  candidates: ConversationSessionCandidate[];
}

export interface ConversationInput extends ConversationIdentity {
  prompt: string;
  /** Resolved and validated by the host's upload pipeline. */
  attachments?: AgentAttachment[];
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface ConversationStatus {
  agentKind: AgentKind;
  activeRunId?: string;
}

export async function createConversationRuntime(options: ConversationRuntimeOptions): Promise<ConversationRuntime> {
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const runtime = new ConversationRuntime(options);
  await runtime.load();
  return runtime;
}

/** Server-side conversations using the same policy, session and executor as IM. */
export class ConversationRuntime {
  private readonly execution: ExecutionController;
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
    this.execution = options.execution;
    this.sessions = new SessionStore(join(options.stateDir, 'sessions.json'));
    this.catalog = new SessionCatalog(join(options.stateDir, 'sessions.catalog.json'));
    this.workspaces = new WorkspaceStore(join(options.stateDir, 'workspaces.json'));
    this.executor = new RunExecutor({
      resolveAgent: scope => this.execution.get(scope),
      resolveModelProvider: (agentKind, model) => this.execution.resolveModelProvider(agentKind, model),
      activeRuns: this.active,
      pool: new ProcessPool(() => Math.max(1, options.config.preferences.maxConcurrentRuns ?? 4)),
    });
  }

  async load(): Promise<void> {
    await Promise.all([this.sessions.load(), this.catalog.load(), this.workspaces.load()]);
  }

  get defaultAgentKind(): AgentKind {
    return this.execution.defaultAgentKind;
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
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    this.pending.add(controller);
    const dispose = () => {
      this.pending.delete(controller);
      input.signal?.removeEventListener('abort', abort);
    };
    const config = this.runConfigFor(scopeId, input);
    const capability = this.execution.capabilityFor(scopeId);
    const agent = this.execution.get(scopeId);
    try {
      const flow = await startRunFlow({
        scopeId, scope: this.scopeContext(input),
        prompt: input.prompt, systemPrompt: this.options.systemPrompt ?? '',
        signal: controller.signal, deadlineAt: input.deadlineAt,
        attachments: input.attachments ?? [], access: { ok: true, reason: 'allowed-user' },
        agent, capability, profileConfig: config, sessions: this.sessions, sessionCatalog: this.catalog,
        workspaces: this.workspaces, executor: this.executor, now: Date.now(),
        userQuestions: this.options.userQuestions,
      });
      if (!flow.ok) { dispose(); return flow; }
      const sessionDone = trackRunSession({ scopeId, sessions: this.sessions, sessionCatalog: this.catalog,
        capability, policy: flow.policy, execution: flow.execution, activeRuns: this.active, resumeFrom: flow.resumeFrom,
        source: { kind: 'message', summary: input.prompt.slice(0, 180) } });
      const rendered = presentRunOutput(flow.execution, output, {
        idleTimeoutMs: config.preferences.runIdleTimeoutMinutes
          ? config.preferences.runIdleTimeoutMinutes * 60_000 : undefined,
        filterForPrefs: state => state,
      });
      const done = Promise.allSettled([rendered, sessionDone]).then(results => {
        for (const result of results) if (result.status === 'rejected') throw result.reason;
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
    await stopRun(handle, 'cancelled');
    return true;
  }

  async sendInput(identity: ConversationIdentity, runId: string, input: AgentInput): Promise<AgentInputReceipt> {
    const scope = await this.authorizedScope(identity);
    const run = this.active.get(scope)?.run;
    if (!run || run.runId !== runId) return { status: 'inactive', messageId: input.messageId };
    return sendRunInput(run, input);
  }

  /** Answer a blocking question of the active run; inactive once that run or question has ended. */
  async answerQuestion(
    identity: ConversationIdentity,
    runId: string,
    questionId: string,
    answer: AgentQuestionAnswer,
  ): Promise<'accepted' | 'inactive'> {
    const scope = await this.authorizedScope(identity);
    const run = this.active.get(scope)?.run;
    if (!run || run.runId !== runId || !run.answerUserInput) return 'inactive';
    return run.answerUserInput(questionId, answer);
  }

  async workingDirectory(identity: ConversationIdentity): Promise<string | undefined> {
    const scope = await this.authorizedScope(identity);
    return this.workspaces.cwdFor(scope);
  }

  /** Select the conversation's working directory; undefined returns to the profile default. */
  async setWorkingDirectory(identity: ConversationIdentity, cwd: string | undefined): Promise<string | undefined> {
    const scope = await this.authorizedScope(identity);
    if (this.active.get(scope)) throw new Error('cannot change the working directory while a run is active');
    if (cwd === undefined) {
      this.workspaces.removeCwd(scope);
      await this.workspaces.flush();
      return undefined;
    }
    const workspace = await resolveWorkingDirectory(cwd);
    if (!workspace.ok) throw new Error(workspace.userVisible);
    this.workspaces.setCwd(scope, workspace.cwdRealpath);
    await this.workspaces.flush();
    return workspace.cwdRealpath;
  }

  /** Native sessions of the current engine, working directory and policy that this conversation could continue. */
  async nativeSessions(identity: ConversationIdentity, options: { limit?: number } = {}): Promise<ConversationSessionList> {
    const scope = await this.authorizedScope(identity);
    const { kind, config, capability, cwd, catalogIdentity } = await this.catalogContext(scope, identity);
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 10), 1), 50);
    const active = this.catalog.activeFor(catalogIdentity);
    const current = capability.sessionIdField === 'threadId' ? active?.threadId : active?.sessionId;
    const historySource = agentBackendSpec(kind).historySource;
    let candidates: ConversationSessionCandidate[] = [];
    try {
      if (historySource === 'claude-jsonl') {
        const list = await (this.options.history?.claude ?? listRecentSessions)(cwd, limit, config.claude?.configDir);
        candidates = list.map(item => ({ id: item.sessionId, preview: item.preview, updatedAt: item.mtime, current: item.sessionId === current }));
      } else if (historySource === 'codex-thread-list' && config.codex?.binaryPath) {
        const profileDir = this.options.profileDir ?? this.options.stateDir;
        const state = resolveAgentState(config, 'codex', { profileDir });
        const list = await (this.options.history?.codex ?? listCodexThreadHistory)({
          binary: config.codex.binaryPath, cwd, limit, profileStateDir: profileDir,
          ...(state.exportHome ? { codexHome: state.home } : { inheritCodexHome: config.codex.inheritCodexHome === true }),
        });
        candidates = list.map(item => ({ id: item.threadId, preview: item.name || item.preview, updatedAt: item.updatedAtMs, current: item.threadId === current }));
      }
    } catch (error) {
      log.warn('session', 'conversation-history-failed', { message: error instanceof Error ? error.message : String(error) });
    }
    if (current && !candidates.some(item => item.id === current)) candidates.unshift({ id: current, preview: '', current: true });
    return { agentKind: kind, cwd, ...(current ? { current } : {}), candidates };
  }

  /** Continue a listed native session; the conversation's next run resumes it. */
  async resume(identity: ConversationIdentity, sessionId: string): Promise<boolean> {
    const scope = await this.authorizedScope(identity);
    if (this.active.get(scope)) throw new Error('cannot resume another session while a run is active');
    const listed = await this.nativeSessions(identity, { limit: 50 });
    if (!listed.candidates.some(item => item.id === sessionId)) return false;
    const { capability, catalogIdentity } = await this.catalogContext(scope, identity);
    if (this.active.get(scope)) throw new Error('cannot resume another session while a run is active');
    this.catalog.upsertActive({
      ...catalogIdentity,
      ...(capability.sessionIdField === 'threadId' ? { threadId: sessionId } : { sessionId }),
    });
    await this.catalog.flush();
    return true;
  }

  async agentKind(identity: ConversationIdentity): Promise<AgentKind> {
    const scope = await this.authorizedScope(identity);
    return this.execution.kindFor(scope);
  }

  async setAgentKind(identity: ConversationIdentity, kind: AgentKind): Promise<void> {
    const scope = await this.authorizedScope(identity);
    if (this.active.get(scope)) throw new Error('cannot switch execution engine while a run is active');
    await this.execution.setScopeKind(scope, kind);
  }

  async status(identity: ConversationIdentity): Promise<ConversationStatus> {
    const scope = await this.authorizedScope(identity);
    const activeRunId = this.active.get(scope)?.run.runId;
    return {
      agentKind: this.execution.kindFor(scope),
      ...(activeRunId ? { activeRunId } : {}),
    };
  }

  /** Forget native session state for one conversation without changing cwd or policy. */
  async reset(identity: ConversationIdentity): Promise<boolean> {
    const scope = await this.authorizedScope(identity);
    if (this.active.get(scope)) throw new Error('cannot reset a conversation while a run is active');
    const hadStoredSession = this.sessions.getRaw(scope) !== undefined;
    this.sessions.clear(scope);
    const archived = this.catalog.archiveScope(scope);
    await Promise.all([this.sessions.flush(), this.catalog.flush()]);
    return hadStoredSession || archived > 0;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.pending) controller.abort(new RunStopped('shutdown'));
    await this.active.stopAll('shutdown');
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

  private runConfigFor(scope: string, identity: ConversationIdentity): RunProfileConfig {
    const kind = this.execution.kindFor(scope);
    const base = this.options.configForAgent?.(kind, { actorId: identity.actorId, conversationId: identity.conversationId })
      ?? this.options.config;
    return profileForAgentKind(base, kind);
  }

  private scopeContext(identity: ConversationIdentity) {
    return { source: 'channel' as const, channelId: this.options.channelId,
      actorId: identity.actorId, conversationId: identity.conversationId };
  }

  /** The session-catalog identity a run of this conversation would use now, computed without starting one. */
  private async catalogContext(scope: string, identity: ConversationIdentity) {
    const kind = this.execution.kindFor(scope);
    const config = this.runConfigFor(scope, identity);
    const capability = this.execution.capabilityFor(scope);
    const context = await resolveRunFlowContext({
      scopeId: scope, scope: this.scopeContext(identity), prompt: '', systemPrompt: this.options.systemPrompt ?? '',
      attachments: [], access: { ok: true, reason: 'allowed-user' }, capability, profileConfig: config,
      sessions: this.sessions, workspaces: this.workspaces, now: Date.now(),
    });
    if (!context.ok) throw new Error(context.rejectReason.userVisible);
    const cwd = context.workspace.cwdRealpath;
    return { kind, config, capability, cwd, catalogIdentity: {
      scopeId: scope, agentId: capability.agentId, cwdRealpath: cwd, policyFingerprint: context.policy.policyFingerprint } };
  }
}
