import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sendRunInput } from '../agent/execution';
import type { AgentInput, AgentInputReceipt, AgentQuestion, AgentQuestionMode, AgentQuestionAnswer } from '../agent/types';
import { agentBackendSpec } from '../agent/backend-spec';
import { resolveAgentState } from '../agent/state-layout';
import { ActiveRuns, stopRun } from './active-runs';
import type { AgentEntry } from './agent-entry';
import { ConversationEvents, type ConversationCursor, type ConversationStreamEvent } from './conversation-events';
import { RunStopped } from './errors';
import { FollowupRouter } from './followup';
import { QuestionBroker } from './questions';
import { PendingQueue, type PendingItem } from './pending-queue';
import { ProcessPool } from './process-pool';
import { ConversationTurns } from './turns';
import { WorkflowHost } from './workflow-host';
import { startMessageTurn, type MessageTurn, type MessageTurnFrontend } from './message-turn';
import type { TurnStores } from './turn';
import { resolveRunFlowContext } from './run-flow';
import type { AgentKind, RunProfileConfig } from '../config/profile-schema';
import { getAgentStopGraceMs, getRunIdleTimeoutMs } from '../config/schema';
import type { AgentAttachment } from '../policy/run-policy';
import { RunExecutor, type RunExecution } from './run-executor';
import type { RunOutputPlugin } from './run-output';
import type { RunState } from './run-state';
import { processAgentStream } from './run-stream';
import { ScopeRunMemory } from './scope-run-memory';
import { SessionCatalog, type SessionCatalogIdentity } from '../session/catalog';
import { log } from '../core/logger';
import { resolveWorkingDirectory } from '../policy/workspace';
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
  /** What of a run's state this host shows in its conversation event streams. */
  filterState?: (state: RunState) => RunState;
  /**
   * Let conversations run workflows: `workflowCommand`, workflow turns queued
   * behind the active run, and wakes of the main session when workers report.
   * Their turns and notices are published to the conversation event streams.
   */
  workflows?: boolean;
  /**
   * Offer the question tool to runs this host starts itself (`submit` and
   * workflow turns). A front end without an answer UI sets false, so those
   * runs never block on a question nobody can answer.
   */
  questionSinks?: boolean;
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

/** A turn the runtime starts itself, queued until the conversation is free. */
type QueuedInput = ConversationIdentity & PendingItem;

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

type TurnExecution = RunExecution;

/** How the runtime itself started a turn; absent for a person's message. */
interface StartedBy {
  entry?: AgentEntry;
  /** The caller holds the conversation's turn lane for this run. */
  claimed?: boolean;
}

/** One turn of a server-side conversation, run through the shared message-turn host. */
type ConversationTurn = MessageTurn<ConversationInput>;

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
  private readonly turnMemory = new ScopeRunMemory();
  private readonly pending = new Set<AbortController>();
  private readonly starts = new Set<Promise<unknown>>();
  private readonly outputs = new Set<Promise<void>>();
  private readonly questions: QuestionBroker<ConversationQuestionSink>;
  private readonly events = new ConversationEvents();
  private readonly queue?: PendingQueue<QueuedInput>;
  private readonly turns?: ConversationTurns;
  private readonly workflows?: WorkflowHost<ConversationIdentity>;
  private closed = false;

  constructor(private readonly options: ConversationRuntimeOptions) {
    if (!options.channelId.trim()) throw new Error('channelId is required');
    if (!options.namespace.trim()) throw new Error('namespace is required');
    this.execution = options.execution;
    this.sessions = new SessionStore(join(options.stateDir, 'sessions.json'));
    this.catalog = new SessionCatalog(join(options.stateDir, 'sessions.catalog.json'));
    this.workspaces = new WorkspaceStore(join(options.stateDir, 'workspaces.json'));
    const executor = new RunExecutor({
      resolveAgent: (scope, agentKind) => this.execution.get(scope, agentKind),
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
      activeRuns: this.active, followups: new FollowupRouter(), catalog: this.catalog,
    });
    if (!options.workflows) return;
    const queue = this.queue = new PendingQueue<QueuedInput>(0, (scope, batch) => {
      const turn = turns.claim(scope);
      void turn.run(signal => this.runQueued(batch, signal)).catch(err => log.fail('conversation', err, { scope, step: 'queued-turn' }));
    });
    const turns = this.turns = new ConversationTurns(queue, this.active);
    const profileFor = (agentKind: AgentKind, scope?: string) => {
      const identity = scope ? this.workflows?.origins.get(scope) : undefined;
      const config = identity ? options.configForAgent?.(agentKind, identity) : undefined;
      return profileForAgentKind(config ?? options.config, agentKind);
    };
    this.workflows = new WorkflowHost<ConversationIdentity>({
      executor, sessions: this.sessions, sessionCatalog: this.catalog, workspaces: this.workspaces,
      stateDir: options.stateDir, turns, resolveAgentKind: scope => this.execution.kindFor(scope),
      settings: {
        profile: options.namespace, profileFor,
        // These hosts keep no per-conversation model choice: a workflow runs with the engine profile's.
        modelSettings: async (scope, agentKind, patch) => {
          const { model, reasoningEffort } = profileFor(agentKind, scope).preferences;
          return { model, reasoningEffort, ...patch, modelSource: 'profile', effortSource: 'profile' };
        },
        stallMs: () => getRunIdleTimeoutMs(options.config),
        stopGraceMs: () => getAgentStopGraceMs(options.config),
      },
      frontend: {
        accepts: origin => typeof (origin as Partial<ConversationIdentity>).actorId === 'string'
          && typeof (origin as Partial<ConversationIdentity>).conversationId === 'string',
        reply: async (origin, text) => { this.events.publish(this.scopeKey(origin), { type: 'notice', text }); },
        // The origin was authorized when it was recorded, and is authorized again by every turn started for it.
        conversation: origin => ({ scope: { source: 'channel', channelId: options.channelId, ...origin },
          access: { ok: true, reason: 'allowed-user' }, systemPrompt: options.systemPrompt ?? '' }),
        queue: (scope, origin, content, agentEntry) =>
          queue.push(scope, { ...origin, messageId: randomUUID(), content, agentEntry }) !== undefined,
        dispatch: async (_scope, [origin], { signal, entry }) => {
          if (!origin) return;
          const run = await this.publishRun({ ...origin, prompt: '', signal }, { entry, claimed: true });
          if (!run.ok) throw new Error(run.rejectReason.userVisible);
          await run.done;
        },
      },
    });
  }

  async load(): Promise<void> {
    await Promise.all([this.sessions.load(), this.catalog.load(), this.workspaces.load()]);
    await this.workflows?.start();
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

  private async startRun(input: ConversationInput, output: RunOutputPlugin, started: StartedBy = {}) {
    const scopeId = await this.authorizedScope(input);
    const entry = started.entry ?? { kind: 'direct' };
    // A workflow wake carries no user input.
    const wake = entry.kind === 'workflow' && entry.trigger === 'event';
    if (!wake && (typeof input.prompt !== 'string' || !input.prompt.trim())) throw new Error('prompt is required');
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    this.pending.add(controller);
    const dispose = () => {
      this.pending.delete(controller);
      input.signal?.removeEventListener('abort', abort);
    };

    const frontend: MessageTurnFrontend<ConversationInput, ConversationTurn> = {
      prepare: async context => {
        // The latest sender of a conversation is who its workflow answers to and is authorized by.
        if (!context.wake) this.workflows?.origins.set(context.turn.scope,
          { actorId: input.actorId, conversationId: input.conversationId });
        return {
          scope: { source: 'channel', channelId: this.options.channelId,
            actorId: input.actorId, conversationId: input.conversationId },
          access: { ok: true, reason: 'allowed-user' },
          attachments: input.attachments ?? [],
          prompt: instructions => instructions.length
            ? `<bridge_instructions>\n${instructions.join('\n')}\n</bridge_instructions>\n\n${input.prompt}`
            : input.prompt,
          systemPrompt: this.options.systemPrompt ?? '',
          sessionSource: { kind: 'message', summary: input.prompt.slice(0, 180) },
          observabilitySource: 'channel',
          runOptions: { userQuestions: input.questions ? true : this.options.userQuestions, deadlineAt: input.deadlineAt },
        };
      },
      // A turn that claimed the conversation's lane already holds its queue.
      started: () => { if (!started.claimed) this.queue?.block(scopeId); },
      // Slack and Web report the rejection themselves; queued turns publish a notice.
      reject: async () => {},
      questions: (context, _prepared, flow) => input.questions
        ? this.relayQuestions(flow.execution, input.questions, {
            input, cancelled: () => controller.signal.aborted,
            identity: { scopeId, agentId: context.capability.agentId, cwdRealpath: flow.cwdRealpath,
              policyFingerprint: flow.policy.policyFingerprint },
          })
        : Promise.resolve(),
      present: (_context, _prepared, flow) => flow.present(output),
    };

    const turn: ConversationTurn = {
      scope: scopeId,
      batch: [input],
      agentKind: this.execution.kindFor(scopeId),
      agent: this.execution.get(scopeId),
      entry,
      signal: controller.signal,
      workflows: this.workflows?.current,
    };

    let result;
    try {
      result = await startMessageTurn(this.turnDeps(input), frontend, turn);
    } catch (error) { dispose(); throw error; }
    if (!result.ok) { dispose(); return { ok: false as const, rejectReason: result.reason }; }
    const done = result.turn.done.finally(() => {
      dispose();
      if (!started.claimed) this.queue?.unblock(scopeId);
    });
    this.outputs.add(done);
    // Keep rejection observable on `done`, while close() tracks all active outputs.
    void done.then(() => this.outputs.delete(done), () => this.outputs.delete(done));
    return { ...result.turn.flow, done };
  }

  /** The shared message-turn host's view of this runtime. */
  private turnDeps({ actorId, conversationId }: ConversationIdentity) {
    return {
      stores: this.stores,
      profileFor: (kind: AgentKind) =>
        profileForAgentKind(this.options.configForAgent?.(kind, { actorId, conversationId }) ?? this.options.config, kind),
      // No per-conversation model store: startTurn applies the profile defaults.
      memory: this.turnMemory,
    };
  }

  /**
   * Starts a run whose progress, questions and outcome are published to the
   * conversation's event stream instead of one caller's output. The run does
   * not depend on any subscriber being connected.
   */
  async submit(input: Omit<ConversationInput, 'questions' | 'signal'>) {
    const run = await this.publishRun(input);
    return run.ok ? { ok: true as const, runId: run.runId } : run;
  }

  private async publishRun(input: Omit<ConversationInput, 'questions'>, started: StartedBy = {}) {
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
    const questions = this.options.questionSinks === false ? undefined : {
      ask: async (question: { id: string; runId: string; mode: AgentQuestionMode; questions: readonly AgentQuestion[] }) => {
        publish({ type: 'run.question', ...question });
      },
      settled: async (question: { id: string; runId: string; status: string }) => {
        publish({ type: 'run.question.settled', ...question });
      },
    };
    const pending = this.startRun({ ...input, ...(questions ? { questions } : {}) }, output, started);
    this.starts.add(pending);
    void pending.then(() => this.starts.delete(pending), () => this.starts.delete(pending));
    const run = await pending;
    if (!run.ok) return run;
    const runId = run.execution.runId;
    const done = run.done.then(
      async () => { publish({ type: 'run.finished', runId, result: await run.execution.result }); },
      () => { publish({ type: 'run.failed', runId, error: 'conversation failed' }); });
    return { ok: true as const, runId, done };
  }

  /** A queued turn, run while it holds the conversation's lane; a rejection is told to the conversation. */
  private async runQueued(batch: QueuedInput[], signal: AbortSignal): Promise<void> {
    for (const item of batch) {
      const identity = { actorId: item.actorId, conversationId: item.conversationId };
      const run = await this.publishRun({ ...identity, prompt: item.content, signal }, { entry: item.agentEntry, claimed: true });
      if (run.ok) await run.done;
      else this.events.publish(this.scopeKey(identity), { type: 'notice', text: run.rejectReason.userVisible });
    }
  }

  /**
   * `/workflow <args>` for this conversation. Returns what to show the person;
   * undefined when the command queued a turn whose run will appear in the event stream.
   */
  async workflowCommand(identity: ConversationIdentity, args: string): Promise<string | undefined> {
    const scope = await this.authorizedScope(identity);
    const control = this.workflows?.control();
    if (!control) return '当前会话未启用工作流。';
    return control.command(scope, args, { actorId: identity.actorId, conversationId: identity.conversationId });
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

  answerQuestion(identity: ConversationIdentity, requestId: string, answers: string[][]): Promise<{ settled: boolean; message: string }>;
  answerQuestion(identity: ConversationIdentity, runId: string, questionId: string, answer: AgentQuestionAnswer): Promise<'accepted' | 'inactive'>;
  answerQuestion(identity: ConversationIdentity, id: string, input: string[][] | string, answer?: AgentQuestionAnswer) {
    return typeof input === 'string' && answer
      ? this.answerNativeQuestion(identity, id, input, answer)
      : Array.isArray(input) ? this.answerBrokerQuestion(identity, id, input) : Promise.resolve('inactive' as const);
  }

  private async answerNativeQuestion(
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

  /** Answer a question shown through a run's sink; `message` is what to show the person either way. */
  private async answerBrokerQuestion(identity: ConversationIdentity, requestId: string, answers: string[][]):
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
    this.questions.close();
    this.turns?.close();
    for (const controller of this.pending) controller.abort(new RunStopped('shutdown'));
    await this.active.stopAll('shutdown');
    await Promise.allSettled(this.starts);
    await Promise.allSettled(this.outputs);
    await this.turns?.settled();
    const workflows = this.workflows?.close();
    await Promise.allSettled([workflows?.progress, workflows?.runtime]);
    this.queue?.cancelAll();
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
    return this.scopeKey(identity);
  }

  private scopeKey(identity: ConversationIdentity): string {
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
