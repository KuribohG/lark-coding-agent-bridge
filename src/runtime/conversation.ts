import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sendRunInput } from '../agent/execution';
import type { AgentInput, AgentInputReceipt, AgentQuestion, AgentQuestionMode, AgentQuestionAnswer } from '../agent/types';
import { AGENT_KINDS, agentBackendSpec } from '../agent/backend-spec';
import { readModelEnvironment } from '../agent/model-environment';
import { availableEfforts, parseEffort, resolveModelSettings, type ModelEnvironment, type ModelSettings,
  type ResolvedModelSettings } from '../agent/model-settings';
import { validateModelId, type ModelOption } from '../agent/models';
import { modelServiceName } from '../model-service/config';
import { NATIVE_MODEL_PROVIDER, type ModelProviderOption, type ModelProviderRegistry } from '../model-provider/provider';
import { ScopePreferencesStore } from '../session/scope-preferences';
import { checkRuntimeAgentAvailability } from './agent-runtime';
import { resolveAgentState } from '../agent/state-layout';
import { ActiveRuns, stopRun } from './active-runs';
import type { AgentEntry } from './agent-entry';
import { ConversationEvents, type ConversationCursor, type ConversationEvent, type ConversationStreamEvent,
  type SequencedConversationEvent } from './conversation-events';
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
   * Told every event as it is published to a conversation's stream, whether or not anyone follows that stream.
   * A host that keeps a record of its conversations takes it from here; a throw is logged and goes no further.
   */
  observe?: (identity: ConversationIdentity, event: SequencedConversationEvent) => void;
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
  /** Ask engines for the model's own thinking, for a host that shows it folded away. */
  rawThinking?: boolean;
  /**
   * Let each conversation choose its model and effort (`modelSettings`, `setModelSettings`, `modelChoices`).
   * `providers` is where the models of the configured model services are listed from. Without this every
   * conversation runs with its engine profile's settings.
   */
  modelChoice?: { providers?: ModelProviderRegistry };
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
  /** Trusted host environment for this turn only; never persisted as conversation settings. */
  env?: Readonly<Record<string, string>>;
  /** Resolved and validated by the host's upload pipeline. */
  attachments?: AgentAttachment[];
  signal?: AbortSignal;
  deadlineAt?: number;
  context1m?: boolean;
  additionalDirs?: readonly string[];
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

/** What a conversation's next run of one engine uses, and which part of that the conversation chose itself. */
export interface ConversationModelSettings extends ResolvedModelSettings {
  agentKind: AgentKind;
  /** The conversation's own choices; whatever is absent comes from the engine's profile or the CLI's own configuration. */
  overrides: ModelSettings;
}

/** What a conversation can choose from for one engine. */
export interface ConversationModelChoices {
  agentKind: AgentKind;
  /** Suggestions, not an allowlist: any model ID the engine accepts can be set. */
  models: ModelOption[];
  providers: ModelProviderOption[];
  efforts: string[];
  /** What a conversation that chose nothing runs with. */
  defaults: ResolvedModelSettings;
}

/** A change of a conversation's choices: a value sets it, `null` returns it to the default, an absent key leaves it. */
export interface ConversationModelPatch {
  model?: string | null;
  provider?: string | null;
  reasoningEffort?: string | null;
}

export interface ConversationEngine {
  agentKind: AgentKind;
  available: boolean;
  /** Why it cannot be used, in words for the person. */
  reason?: string;
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
  private readonly preferences?: ScopePreferencesStore;
  private readonly engineChecks = new Map<AgentKind, { at: number; result: Promise<ConversationEngine> }>();
  private closed = false;

  constructor(private readonly options: ConversationRuntimeOptions) {
    if (!options.channelId.trim()) throw new Error('channelId is required');
    if (!options.namespace.trim()) throw new Error('namespace is required');
    this.execution = options.execution;
    this.sessions = new SessionStore(join(options.stateDir, 'sessions.json'));
    this.catalog = new SessionCatalog(join(options.stateDir, 'sessions.catalog.json'));
    this.workspaces = new WorkspaceStore(join(options.stateDir, 'workspaces.json'));
    if (options.modelChoice) this.preferences = new ScopePreferencesStore(join(options.stateDir, 'scope-preferences.json'));
    const executor = new RunExecutor({
      resolveAgent: (scope, agentKind) => this.execution.get(scope, agentKind),
      resolveModelProvider: (agentKind, model) => this.execution.resolveModelProvider(agentKind, model),
      activeRuns: this.active,
      pool: new ProcessPool(() => Math.max(1, options.config.preferences.maxConcurrentRuns ?? 4)),
    });
    this.stores = { executor, sessions: this.sessions, sessionCatalog: this.catalog,
      workspaces: this.workspaces, activeRuns: this.active };
    // Answers to questions and workflow notices enter a running turn through the same router, so they do not interleave.
    const followups = new FollowupRouter();
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
      activeRuns: this.active, followups, catalog: this.catalog,
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
      steer: (scope, messageId, text) => followups.deliver({ scope, messageId, activeRuns: this.active, internal: true, prepare: async () => text }),
      settings: {
        profile: options.namespace, profileFor,
        // A workflow runs with its conversation's choice where the host keeps one, otherwise with the engine profile's.
        modelSettings: async (scope, agentKind, patch) => {
          const origin = this.workflows?.origins.get(scope);
          if (this.preferences && origin) return this.resolveModel(scope, agentKind, origin, patch);
          const { model, modelProvider, reasoningEffort } = profileFor(agentKind, scope).preferences;
          return {
            model, reasoningEffort, ...patch, modelSource: 'profile', providerSource: 'profile', effortSource: 'profile',
            ...(modelProvider ? { provider: modelProvider } : {}),
          };
        },
        stallMs: () => getRunIdleTimeoutMs(options.config),
        stopGraceMs: () => getAgentStopGraceMs(options.config),
        placement: () => options.config.workflow,
      },
      frontend: {
        accepts: origin => typeof (origin as Partial<ConversationIdentity>).actorId === 'string'
          && typeof (origin as Partial<ConversationIdentity>).conversationId === 'string',
        reply: async (origin, text) => { this.publish(origin, { type: 'notice', text }); },
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
    await Promise.all([this.sessions.load(), this.catalog.load(), this.workspaces.load(), this.preferences?.load()]);
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
          runOptions: {
            env: input.env,
            userQuestions: input.questions ? true : this.options.userQuestions,
            ...(this.options.rawThinking ? { rawThinking: true } : {}),
            deadlineAt: input.deadlineAt,
            ...(input.context1m !== undefined ? { context1m: input.context1m } : {}),
            ...(input.additionalDirs ? { additionalDirs: input.additionalDirs } : {}),
          },
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
      // Without a per-conversation model store, startTurn applies the profile defaults.
      ...(this.preferences ? { resolveModelSettings: (scope: string, kind: AgentKind) => this.resolveModel(scope, kind, { actorId, conversationId }) } : {}),
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
    await this.authorizedScope(input);
    const identity = { actorId: input.actorId, conversationId: input.conversationId };
    const publish = (event: ConversationEvent) => { this.publish(identity, event); };
    const filter = this.options.filterState ?? (state => state);
    const output: RunOutputPlugin = {
      id: 'conversation-events',
      render: async context => {
        const chosen = context.handle.modelSettings;
        publish({ type: 'run.started', runId: context.runId, settings: {
          agent: this.execution.kindFor(context.scope),
          ...(chosen?.model ? { model: chosen.model } : {}), ...(chosen?.provider ? { provider: chosen.provider } : {}),
          ...(chosen?.reasoningEffort ? { effort: chosen.reasoningEffort } : {}) } });
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

  /** Publishes to the conversation's stream and tells the host's observer. */
  private publish(identity: ConversationIdentity, event: ConversationEvent): void {
    const published = this.events.publish(this.scopeKey(identity), event);
    if (!this.options.observe) return;
    try { this.options.observe({ actorId: identity.actorId, conversationId: identity.conversationId }, published); }
    catch (err) { log.fail('conversation', err, { step: 'observe' }); }
  }

  /** A queued turn, run while it holds the conversation's lane; a rejection is told to the conversation. */
  private async runQueued(batch: QueuedInput[], signal: AbortSignal): Promise<void> {
    for (const item of batch) {
      const identity = { actorId: item.actorId, conversationId: item.conversationId };
      const run = await this.publishRun({ ...identity, prompt: item.content, signal }, { entry: item.agentEntry, claimed: true });
      if (run.ok) await run.done;
      else this.publish(identity, { type: 'notice', text: run.rejectReason.userVisible });
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

  /** Whether conversations of this runtime choose their own model and effort. */
  get choosesModels(): boolean {
    return this.preferences !== undefined;
  }

  /**
   * What the conversation's next run of an engine (its current one unless named) uses. `assume` answers for
   * choices the conversation has not made: what it would run with if it had.
   */
  async modelSettings(identity: ConversationIdentity, agentKind?: AgentKind, assume?: ModelSettings): Promise<ConversationModelSettings> {
    const scope = await this.authorizedScope(identity);
    const kind = agentKind ?? this.execution.kindFor(scope);
    const overrides = assume ?? this.preferences?.get(kind, scope) ?? {};
    const resolved = resolveModelSettings(this.profileModel(kind, identity), overrides, await this.modelEnvironment(kind, identity));
    return { ...resolved, agentKind: kind, overrides };
  }

  /** Changes the conversation's choices for an engine; a run that is going keeps what it started with. */
  async setModelSettings(identity: ConversationIdentity, patch: ConversationModelPatch, agentKind?: AgentKind): Promise<ConversationModelSettings> {
    const scope = await this.authorizedScope(identity);
    if (!this.preferences) throw new Error('This host does not keep a model choice per conversation');
    const kind = agentKind ?? this.execution.kindFor(scope);
    const providers = this.options.modelChoice?.providers?.options(kind) ?? [];
    const change: ModelSettings = {};
    if (patch.model !== undefined) {
      const model = patch.model === null || patch.model === 'default' ? undefined : validateModelId(patch.model);
      // `service/model` names both; they are kept apart, so a later change of model alone keeps the service.
      const service = model ? providers.find(option => model.startsWith(`${option.id}/`)) : undefined;
      change.model = service ? model!.slice(service.id.length + 1) : model;
      if (service) change.provider = service.id;
      else if (!model) change.provider = undefined;
    }
    if (patch.provider !== undefined) {
      const provider = patch.provider === null || patch.provider === 'default' ? undefined : modelServiceName(patch.provider);
      if (provider && provider !== NATIVE_MODEL_PROVIDER && !providers.some(option => option.id === provider)) {
        throw new Error(`模型服务「${provider}」不存在，或不支持 ${kind}。`);
      }
      if (change.provider && provider && change.provider !== provider) throw new Error(`模型 ${patch.model} 属于模型服务「${change.provider}」，与所选的「${provider}」不一致。`);
      if (provider || !change.provider) change.provider = provider;
    }
    if (patch.reasoningEffort !== undefined) change.reasoningEffort = parseEffort(patch.reasoningEffort ?? undefined, kind);
    const overrides = { ...this.preferences.get(kind, scope), ...change };
    // Refuses a model and effort that do not go together before anything is saved.
    const resolved = resolveModelSettings(this.profileModel(kind, identity), overrides, await this.modelEnvironment(kind, identity));
    await this.preferences.update(kind, scope, change);
    return { ...resolved, agentKind: kind, overrides: this.preferences.get(kind, scope) };
  }

  /** Drops what the conversation chose, for every engine; for a host that is deleting the conversation. */
  async forgetModelSettings(identity: ConversationIdentity): Promise<void> {
    const scope = await this.authorizedScope(identity);
    if (!this.preferences) return;
    for (const kind of AGENT_KINDS) {
      const chosen = this.preferences.get(kind, scope);
      if (chosen.model || chosen.provider || chosen.reasoningEffort) {
        await this.preferences.update(kind, scope, { model: undefined, provider: undefined, reasoningEffort: undefined });
      }
    }
  }

  /** The models, model services and efforts to choose from for an engine; `refresh` asks the services again. */
  async modelChoices(identity: ConversationIdentity, agentKind?: AgentKind, options: { refresh?: boolean } = {}): Promise<ConversationModelChoices> {
    const scope = await this.authorizedScope(identity);
    const kind = agentKind ?? this.execution.kindFor(scope);
    const environment = await this.modelEnvironment(kind, identity, options.refresh);
    return {
      agentKind: kind, models: environment.models, providers: this.options.modelChoice?.providers?.options(kind) ?? [],
      efforts: availableEfforts(kind), defaults: resolveModelSettings(this.profileModel(kind, identity), {}, environment),
    };
  }

  /** Whether an engine can be used here; asked of the engine itself, and remembered for a minute. */
  async engine(identity: ConversationIdentity, agentKind: AgentKind): Promise<ConversationEngine> {
    const scope = await this.authorizedScope(identity);
    const known = this.engineChecks.get(agentKind);
    if (known && Date.now() - known.at < 60_000) return known.result;
    const result = (async (): Promise<ConversationEngine> => {
      try {
        const availability = await checkRuntimeAgentAvailability(this.execution.get(scope, agentKind));
        return availability.ok ? { agentKind, available: true } : { agentKind, available: false, reason: availability.error.message };
      } catch (error) {
        return { agentKind, available: false, reason: error instanceof Error ? error.message : String(error) };
      }
    })();
    this.engineChecks.set(agentKind, { at: Date.now(), result });
    return result;
  }

  private profileModel(kind: AgentKind, identity: ConversationIdentity): ModelSettings {
    const { model, modelProvider, reasoningEffort } = this.profileConfigFor(kind, identity).preferences;
    return { model, ...(modelProvider ? { provider: modelProvider } : {}), reasoningEffort };
  }

  private profileConfigFor(kind: AgentKind, identity: ConversationIdentity): RunProfileConfig {
    return profileForAgentKind(this.options.configForAgent?.(kind, { actorId: identity.actorId, conversationId: identity.conversationId })
      ?? this.options.config, kind);
  }

  private async modelEnvironment(kind: AgentKind, identity: ConversationIdentity, refresh = false): Promise<ModelEnvironment> {
    const [native, services] = await Promise.all([
      readModelEnvironment(this.profileConfigFor(kind, identity), this.options.profileDir ?? this.options.stateDir),
      this.options.modelChoice?.providers?.modelOptions(kind, refresh) ?? [],
    ]);
    return { ...native, models: [...native.models, ...services] };
  }

  private async resolveModel(scope: string, kind: AgentKind, identity: ConversationIdentity, patch?: Partial<ModelSettings>): Promise<ResolvedModelSettings> {
    return resolveModelSettings(this.profileModel(kind, identity), { ...this.preferences?.get(kind, scope), ...patch },
      await this.modelEnvironment(kind, identity));
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

  /** The scope a conversation's runs, sessions and workflows are kept under. */
  scopeKey(identity: ConversationIdentity): string {
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
