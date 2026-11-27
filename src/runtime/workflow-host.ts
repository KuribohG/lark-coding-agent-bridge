import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_STALL_MS, handleWorkflowCommand, workflowDigest,
  type WorkflowKernel, type WorkflowRuntime, type WorkflowState,
} from '@kuribohg/agent-workflows';
import { capabilityForProfile } from '../agent/backends';
import { modelRunArguments, type ModelSettings, type ResolvedModelSettings } from '../agent/model-settings';
import type { AgentKind, RunProfileConfig } from '../config/profile-schema';
import { getCacheKeepalive, getWorkflowTimeoutMinutes } from '../config/schema';
import { sanitizeLogsForDoctor } from '../core/logger';
import type { AccessDecision } from '../policy/access';
import type { ScopeContext } from '../policy/run-policy';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import { bridgeAgentKind, resolveWorkerExecution } from '../workflows/bridge/execution';
import { createBridgeWorkflowRuntime } from '../workflows/bridge/runtime';
import { placementDirectory, workerSignalCell, type WorkflowMachineSettings } from '../workflows/machine';
import type { WorkspaceStore } from '../workspace/store';
import type { AgentEntry } from './agent-entry';
import { CacheKeepalive, type CachePing } from './cache-keepalive';
import { NoticeHandIn, type NoticeHandInDeps } from './notice-hand-in';
import type { RunExecutor } from './run-executor';
import { resolveRunFlowContext, startRunFlow } from './run-flow';
import type { ConversationTurns } from './turns';
import { WorkflowOrigins } from './workflow-origins';

/** A live view of a root workflow's progress in its conversation. */
export interface WorkflowProgress {
  start(): Promise<void>;
  /** Starts following a root workflow; repeated calls keep the existing view. */
  track(state: WorkflowState): void;
  close(): Promise<void>;
}

/**
 * What a channel does for the workflows of its conversations. `M` is the
 * channel's message: the latest one of a scope is the workflow's origin, which
 * addresses its notices and carries the identity its runs are authorized by.
 */
export interface WorkflowFrontend<M> {
  /** Whether a persisted origin still has the channel's shape. */
  accepts(origin: unknown): boolean;
  /** Posts to the origin's conversation; rejects unless delivery was confirmed. */
  reply(origin: M, text: string): Promise<void>;
  /**
   * The conversation an origin belongs to, and whether its sender may still run there.
   * `systemPrompt` must be the one the channel's turns run with when it is part of their
   * policy fingerprint, or the workflow cannot find the session it belongs to.
   */
  conversation(origin: M, profileConfig: RunProfileConfig): { scope: ScopeContext; access: AccessDecision; systemPrompt?: string };
  /** Queues `content` as a workflow turn sent from the origin; false when the queue is full. */
  queue(scope: string, origin: M, content: string, entry: AgentEntry): boolean;
  /** Runs one turn of the main conversation for the given inputs. */
  dispatch(scope: string, batch: M[], options: { signal: AbortSignal; entry: AgentEntry }): Promise<unknown>;
  progress?(kernel: WorkflowKernel, origins: ReadonlyMap<string, M>, stateDir: string): WorkflowProgress;
}

/** The host's run settings, read on every use so configuration changes apply to running workflows. */
export interface WorkflowSettings {
  /** Name recorded with a workflow's root and its runs. */
  profile: string;
  /** Run profile of an engine. */
  profileFor(agentKind: AgentKind, scope?: string): RunProfileConfig;
  /** Model and effort a scope runs an engine with, after `patch`. */
  modelSettings(scope: string, agentKind: AgentKind, patch?: Partial<ModelSettings>): Promise<ResolvedModelSettings>;
  /** How long a silent worker is left alone; the engine default when undefined. */
  stallMs(): number | undefined;
  stopGraceMs(): number;
  /** The `[workflow]` table: where trains and wsfs workspaces keep their files, and whether workers are confined. */
  machine(): WorkflowMachineSettings | undefined;
}

export interface WorkflowHostDeps<M> {
  frontend: WorkflowFrontend<M>;
  executor: RunExecutor;
  settings: WorkflowSettings;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  /** Profile state directory; workflows are disabled without one. */
  stateDir?: string;
  turns: ConversationTurns;
  resolveAgentKind(scope: string): AgentKind;
  /** Hands text to the turn that is running in a scope. Without it, a workflow's notices wait for the scope to be idle. */
  steer?: NoticeHandInDeps['steer'];
}

/** The `/workflow` surface of a started host. */
export interface WorkflowHostControl<M> {
  command(scope: string, args: string, message: M): Promise<string | undefined>;
  /** Whether the scope has a workflow that is still running. */
  active(scope: string): boolean;
  invalidate(scope: string): void;
}

// The fork shares the main session's request prefix, so this prompt is all it adds; the answer is discarded.
const KEEPALIVE_PROMPT = '这是 bridge 发出的缓存保活请求，不是用户输入。只回复 ok，不要调用任何工具，不要继续之前的任务。';

/** The workflow runtime of one channel connection, with its origin messages and progress display. */
export class WorkflowHost<M> {
  readonly origins: WorkflowOrigins<M>;
  private runtime: WorkflowRuntime | undefined;
  private progress: WorkflowProgress | undefined;
  private controlView: WorkflowHostControl<M> | undefined;
  private keepalive: CacheKeepalive | undefined;
  /** Gives a main agent that is in a turn the notices its workflow raises meanwhile. */
  private readonly handIn: NoticeHandIn | undefined;

  constructor(private readonly deps: WorkflowHostDeps<M>) {
    this.origins = new WorkflowOrigins(deps.stateDir ? join(deps.stateDir, 'workflow-origins.json') : undefined,
      origin => deps.frontend.accepts(origin));
    const { steer } = deps;
    this.handIn = steer && new NoticeHandIn({ steer,
      undelivered: scope => this.runtime?.kernel.undelivered(scope) ?? [],
      markNotified: (scope, ids, delivered) => this.runtime?.kernel.markNotified(scope, ids, delivered) });
  }

  /** Started runtime, for turns that bind to their workflow. */
  get current(): WorkflowRuntime | undefined {
    return this.runtime;
  }

  /** Command surface, available once the runtime has started. */
  control(): WorkflowHostControl<M> | undefined {
    return this.controlView;
  }

  async start(): Promise<void> {
    if (this.runtime) return;
    // Load after a handoff so origins recorded by the previous process are included.
    await this.origins.load();
    const stateDir = this.deps.stateDir;
    if (!this.deps.sessionCatalog || !stateDir) return;
    const runtime = this.runtime = this.createRuntime(this.deps.sessionCatalog, stateDir);
    this.progress = this.deps.frontend.progress?.(runtime.kernel, this.origins, stateDir);
    await this.progress?.start();
    await runtime.start();
    const { settings, frontend, turns } = this.deps;
    const sessionCatalog = this.deps.sessionCatalog;
    this.keepalive = new CacheKeepalive({
      scopes: () => {
        try {
          return [...this.origins.keys()].filter(scope => runtime.kernel.state(scope)?.status === 'active');
        } catch {
          // The kernel database is closed once shutdown starts.
          return [];
        }
      },
      // Only Claude's prompt cache expires on a timer that a read can push back.
      settings: scope => this.deps.resolveAgentKind(scope) === 'claude'
        ? getCacheKeepalive(settings.profileFor('claude', scope)) : undefined,
      isIdle: scope => turns.isIdle(scope),
      lastActivity: async scope => {
        const root = await this.rootContext(scope, sessionCatalog);
        return root && sessionCatalog.activeFor({ scopeId: scope, agentId: root.capability.agentId,
          cwdRealpath: root.context.workspace.cwdRealpath, policyFingerprint: root.context.policy.policyFingerprint })?.updatedAt;
      },
      ping: (scope, signal) => this.keepalivePing(scope, sessionCatalog, signal),
    });
    this.keepalive.start();
    this.controlView = {
      active: scope => runtime.kernel.state(scope)?.status === 'active',
      invalidate: scope => runtime.kernel.invalidate(scope),
      command: (scope, args, message) => handleWorkflowCommand(runtime.kernel, scope, args, content => {
        if (!frontend.queue(scope, message, content, { kind: 'workflow', trigger: 'command' })) return '消息队列已满，请稍后重试。';
        this.origins.set(scope, message);
        return undefined;
      }, { sanitize: sanitizeLogsForDoctor }),
    };
  }

  activity(): { scripts: number; tasks: number } {
    try {
      return this.runtime?.kernel.activity() ?? { scripts: 0, tasks: 0 };
    } catch {
      // The kernel database is closed once shutdown starts.
      return { scripts: 0, tasks: 0 };
    }
  }

  /** Stops the progress display before the runtime, so shutdown transitions are not published as progress. */
  close(): { progress: Promise<void> | undefined; runtime: Promise<void> | undefined } {
    this.controlView = undefined;
    const keepalive = this.keepalive?.close();
    return { progress: this.progress?.close(), runtime: Promise.all([keepalive, this.runtime?.close()]).then(() => {}) };
  }

  private async replyToOrigin(state: WorkflowState, text: string): Promise<void> {
    const message = this.origins.get(state.root.scopeId);
    if (!message) throw new Error('Workflow reply destination unavailable');
    await this.deps.frontend.reply(message, text);
  }

  private createRuntime(sessionCatalog: SessionCatalog, stateDir: string): WorkflowRuntime {
    const { settings, executor, turns } = this.deps;
    return createBridgeWorkflowRuntime({
      path: join(stateDir, 'workflows.sqlite'), executor,
      // On the local disk: the state directory may be on a network filesystem, where builds and caches do not belong.
      scratchRoot: process.env.LARK_WORKFLOW_SCRATCH_DIR || join(tmpdir(), 'lark-wf-scratch'),
      trainRoot: () => placementDirectory(settings.machine()?.trainDirectory),
      wsfsStateRoot: () => placementDirectory(settings.machine()?.wsfsStateDirectory),
      signalCell: sessionKey => workerSignalCell(settings.machine(), sessionKey, stateDir),
      getTimeoutMinutes: root => getWorkflowTimeoutMinutes(settings.profileFor(bridgeAgentKind(root.agentKind), root.scopeId)),
      // A silent worker is stopped and retried; the conversation idle timeout is the natural knob for it.
      stallMs: settings.stallMs() ?? DEFAULT_STALL_MS,
      showPlan: async (state, text) => {
        await this.replyToOrigin(state, text);
        this.progress?.track(state);
      },
      notify: (state, text) => this.replyToOrigin(state, text),
      resolveWorker: async (root, selection, policy) => {
        const { agentKind: kind, ...overrides } = selection;
        const agentKind = bridgeAgentKind(kind);
        const profile = settings.profileFor(agentKind, root.scopeId);
        // bridgeWorkerPolicy has already validated the engine's string-typed efforts.
        const requested = overrides as ModelSettings;
        const chosen = agentKind === root.agentKind ? { ...root.modelSettings as ModelSettings, ...requested }
          : await settings.modelSettings(root.scopeId, agentKind, requested);
        return resolveWorkerExecution(root, profile, policy,
          { model: chosen.model, reasoningEffort: chosen.reasoningEffort });
      },
      resolve: scope => this.resolveRoot(scope, sessionCatalog),
      wakeMain: async scope => {
        const message = this.origins.get(scope);
        if (!message) return;
        if (!turns.isIdle(scope)) return this.handIn?.run(scope);
        const turn = turns.claim(scope);
        const eventIds = this.runtime?.kernel.state(scope)?.events.filter(event => !event.acknowledged).map(event => event.id) ?? [];
        try {
          await turn.run(async signal => { await this.deps.frontend.dispatch(scope, [message], { signal, entry: { kind: 'workflow', trigger: 'event' } }); });
        } catch (error) {
          // Failed automatic wakes remain visible through /workflow status, without a retry loop.
          this.runtime?.kernel.markNotified(scope, eventIds);
          throw error;
        }
      },
    });
  }

  /** Policy, workspace and resumable session of the conversation that owns a scope's workflow. */
  private async rootContext(scope: string, sessionCatalog: SessionCatalog) {
    const message = this.origins.get(scope);
    if (!message) return undefined;
    const { settings, sessions, workspaces } = this.deps;
    const agentKind = this.deps.resolveAgentKind(scope);
    const profileConfig = settings.profileFor(agentKind, scope);
    const capability = capabilityForProfile(profileConfig);
    const input = { scopeId: scope, ...this.deps.frontend.conversation(message, profileConfig),
      prompt: '', attachments: [],
      capability, profileConfig, sessions, sessionCatalog, workspaces, now: Date.now(),
    };
    const context = await resolveRunFlowContext(input);
    if (!context.ok || !context.resumeFrom) return undefined;
    return { input, context, agentKind, capability };
  }

  private async resolveRoot(scope: string, sessionCatalog: SessionCatalog) {
    const resolved = await this.rootContext(scope, sessionCatalog);
    if (!resolved) return undefined;
    const { context, agentKind } = resolved;
    const { settings } = this.deps;
    const modelSettings = modelRunArguments(await settings.modelSettings(scope, agentKind));
    return { policy: context.policy, root: { scopeId: scope, profile: settings.profile, agentKind,
      cwdRealpath: context.workspace.cwdRealpath, policyFingerprint: context.policy.policyFingerprint,
      catalogBinding: workflowDigest({ nativeId: context.resumeFrom!, agentKind }), modelSettings } };
  }

  /**
   * One request from a discarded fork of the main session. It must launch exactly like a conversation turn
   * (model, effort, question tool): any difference in the request prefix misses the cache it is meant to read.
   */
  private async keepalivePing(scope: string, sessionCatalog: SessionCatalog, signal: AbortSignal): Promise<CachePing | undefined> {
    const resolved = await this.rootContext(scope, sessionCatalog);
    if (!resolved) return undefined;
    const { settings, executor } = this.deps;
    const modelSettings = modelRunArguments(await settings.modelSettings(scope, resolved.agentKind));
    const started = await startRunFlow({
      ...resolved.input, prompt: KEEPALIVE_PROMPT, now: Date.now(), executor, signal, modelSettings,
      stopGraceMs: settings.stopGraceMs(), userQuestions: true,
      fork: { executionScopeId: `cache-keepalive:${scope}`, ephemeral: true, prompt: () => KEEPALIVE_PROMPT },
      observability: { profile: settings.profile, agent: resolved.capability.agentId, source: 'cache-keepalive', stage: 'submit' },
    });
    if (!started.ok) return undefined;
    let usage: { inputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; costUsd?: number } | undefined;
    for await (const event of started.execution.subscribe()) if (event.type === 'usage') usage = event;
    if (await started.execution.result !== 'completed' || !usage) return undefined;
    const cachedTokens = usage.cachedInputTokens ?? 0;
    return { promptTokens: (usage.inputTokens ?? 0) + cachedTokens + (usage.cacheWriteInputTokens ?? 0), cachedTokens,
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}) };
  }
}
