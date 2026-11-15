import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sendRunInput } from '../agent/execution';
import type { AgentInput, AgentInputReceipt, AgentQuestion, AgentQuestionMode } from '../agent/types';
import { ActiveRuns, stopRun } from './active-runs';
import { ConversationEvents, type ConversationCursor, type ConversationStreamEvent } from './conversation-events';
import { RunStopped } from './errors';
import { FollowupRouter } from './followup';
import { QuestionBroker } from './questions';
import { ProcessPool } from './process-pool';
import { startTurn, type StartedTurn, type TurnStores } from './turn';
import type { AgentKind, RunProfileConfig } from '../config/profile-schema';
import type { AgentAttachment } from '../policy/run-policy';
import { RunExecutor } from './run-executor';
import type { RunOutputPlugin } from './run-output';
import type { RunState } from './run-state';
import { processAgentStream } from './run-stream';
import { SessionCatalog, type SessionCatalogIdentity } from '../session/catalog';
import { log } from '../core/logger';
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
  /** Resolve engine-specific run settings for the selected backend. */
  configForAgent?: (agentKind: AgentKind) => RunProfileConfig;
  /** Use a private directory owned by this host process. */
  stateDir: string;
  namespace: string;
  channelId: string;
  authorize(identity: ConversationIdentity): Promise<boolean>;
  systemPrompt?: string;
  /** What of a run's state this host shows in its conversation event streams. */
  filterState?: (state: RunState) => RunState;
}

export interface ConversationInput extends ConversationIdentity {
  prompt: string;
  /** Resolved and validated by the host's upload pipeline. */
  attachments?: AgentAttachment[];
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Where this run's questions are shown. Without it the agent is not offered the question tool. */
  questions?: ConversationQuestionSink;
}

/** One run's questions, as the host shows them; answers come back through `answerQuestion`. */
export interface ConversationQuestionSink {
  ask(question: { id: string; runId: string; mode: AgentQuestionMode; questions: readonly AgentQuestion[] }): Promise<void>;
  settled(question: { id: string; runId: string; status: string }): Promise<void>;
}

export interface ConversationStatus {
  agentKind: AgentKind;
  activeRunId?: string;
}

type TurnExecution = StartedTurn['execution'];

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
  private readonly stores: TurnStores;
  private readonly pending = new Set<AbortController>();
  private readonly starts = new Set<Promise<unknown>>();
  private readonly outputs = new Set<Promise<void>>();
  private readonly questions: QuestionBroker<ConversationQuestionSink>;
  private readonly events = new ConversationEvents();
  private closed = false;

  constructor(private readonly options: ConversationRuntimeOptions) {
    if (!options.channelId.trim()) throw new Error('channelId is required');
    if (!options.namespace.trim()) throw new Error('namespace is required');
    this.execution = options.execution;
    this.sessions = new SessionStore(join(options.stateDir, 'sessions.json'));
    this.catalog = new SessionCatalog(join(options.stateDir, 'sessions.catalog.json'));
    this.workspaces = new WorkspaceStore(join(options.stateDir, 'workspaces.json'));
    const executor = new RunExecutor({
      resolveAgent: scope => this.execution.get(scope),
      resolveModelProvider: (agentKind, model) => this.execution.resolveModelProvider(agentKind, model),
      activeRuns: this.active,
      pool: new ProcessPool(() => Math.max(1, options.config.preferences.maxConcurrentRuns ?? 4)),
    });
    this.stores = { executor, sessions: this.sessions, sessionCatalog: this.catalog,
      workspaces: this.workspaces, activeRuns: this.active };
    this.questions = new QuestionBroker({
      presenter: {
        present: async request => {
          await request.origin.ask({ id: request.id, runId: request.runId, mode: request.mode, questions: request.questions });
          return request.id;
        },
        settle: request => request.origin.settled({ id: request.id, runId: request.runId, status: request.status ?? '' }),
        forget: () => {},
      },
      delivery: { prompt: async (_request, content) => content },
      activeRuns: this.active, followups: new FollowupRouter(), catalog: this.catalog, isTimed: () => false,
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
    const config = this.runConfigFor(scopeId);
    const capability = this.execution.capabilityFor(scopeId);
    const agent = this.execution.get(scopeId);
    try {
      const turn = await startTurn(this.stores, {
        scopeId, scope: { source: 'channel', channelId: this.options.channelId,
          actorId: input.actorId, conversationId: input.conversationId },
        prompt: input.prompt, systemPrompt: this.options.systemPrompt ?? '',
        signal: controller.signal, deadlineAt: input.deadlineAt,
        attachments: input.attachments ?? [], access: { ok: true, reason: 'allowed-user' },
        agent, capability, profileConfig: config, userQuestions: Boolean(input.questions),
      });
      if (!turn.ok) { dispose(); return turn; }
      const { track, present, ...flow } = turn;
      const sessionDone = track({ kind: 'message', summary: input.prompt.slice(0, 180) });
      const asked = input.questions ? this.relayQuestions(flow.execution, input.questions, {
        input, cancelled: () => controller.signal.aborted,
        identity: { scopeId, agentId: capability.agentId, cwdRealpath: flow.cwdRealpath,
          policyFingerprint: flow.policy.policyFingerprint },
      }) : undefined;
      const rendered = present(output);
      const done = Promise.allSettled([rendered, sessionDone, asked]).then(results => {
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      }).finally(dispose);
      this.outputs.add(done);
      // Keep rejection observable on `done`, while close() tracks all active outputs.
      void done.then(() => this.outputs.delete(done), () => this.outputs.delete(done));
      return { ...flow, done };
    } catch (error) { dispose(); throw error; }
  }

  /**
   * Starts a run whose progress, questions and outcome are published to the
   * conversation's event stream instead of one caller's output. The run does
   * not depend on any subscriber being connected.
   */
  async submit(input: Omit<ConversationInput, 'questions' | 'signal'>) {
    const scope = await this.authorizedScope(input);
    const publish = this.events.publish.bind(this.events, scope);
    const filter = this.options.filterState ?? (state => state);
    const output: RunOutputPlugin = {
      id: 'conversation-events',
      render: async context => {
        publish({ type: 'run.started', runId: context.runId });
        let previous: string | undefined;
        await processAgentStream(context.handle, context.events, context.scope, context.idleTimeoutMs, () => {}, async current => {
          const state = structuredClone(filter(current));
          const serialized = JSON.stringify(state);
          if (serialized === previous) return;
          previous = serialized;
          publish({ type: 'run.state', runId: context.runId, state });
        });
      },
    };
    const run = await this.start({ ...input, questions: {
      ask: async question => { publish({ type: 'run.question', ...question }); },
      settled: async question => { publish({ type: 'run.question.settled', ...question }); },
    } }, output);
    if (!run.ok) return run;
    const runId = run.execution.runId;
    void run.done.then(
      async () => { publish({ type: 'run.finished', runId, result: await run.execution.result }); },
      () => { publish({ type: 'run.failed', runId, error: 'conversation failed' }); });
    return { ok: true as const, runId };
  }

  /**
   * Follows a conversation: first `stream.opened`, then the buffered events
   * after the cursor, then live ones. Returns the unsubscribe function.
   */
  async subscribe(identity: ConversationIdentity, cursor: ConversationCursor,
    listener: (event: ConversationStreamEvent) => void): Promise<() => void> {
    return this.events.subscribe(await this.authorizedScope(identity), cursor, listener);
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

  /** Answer a question shown through a run's sink; `message` is what to show the person either way. */
  async answerQuestion(identity: ConversationIdentity, requestId: string, answers: string[][]):
    Promise<{ settled: boolean; message: string }> {
    const scope = await this.authorizedScope(identity);
    const result = await this.questions.answer({
      requestId, scope, conversationId: identity.conversationId, actorId: identity.actorId,
      // The host authenticated the identity above, so the session the question was asked in stands.
      identity: this.questions.get(requestId)?.identity, answers, verify: () => true,
    });
    return result.kind === 'settled'
      ? { settled: true, message: result.request.status ?? '' } : { settled: false, message: result.notice };
  }

  /** Shows the run's questions until its event stream ends. */
  private async relayQuestions(execution: TurnExecution, sink: ConversationQuestionSink, context: {
    input: ConversationInput; identity: SessionCatalogIdentity; cancelled(): boolean;
  }): Promise<void> {
    for await (const event of execution.subscribe()) {
      if (event.type !== 'user_input') continue;
      try {
        await this.questions.publish(event, {
          runId: execution.runId, identity: context.identity, conversationId: context.input.conversationId,
          actorId: context.input.actorId, messageId: execution.runId, origin: sink, allowQueue: false,
          isCancelled: () => execution.handle.interrupted || context.cancelled(),
        });
      } catch (err) { log.warn('question', 'delivery-failed', { scope: context.identity.scopeId, err: String(err) }); }
    }
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
    this.questions.close();
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

  private runConfigFor(scope: string): RunProfileConfig {
    const base = this.options.configForAgent?.(this.execution.kindFor(scope)) ?? this.options.config;
    return profileForAgentKind(base, this.execution.kindFor(scope));
  }
}
