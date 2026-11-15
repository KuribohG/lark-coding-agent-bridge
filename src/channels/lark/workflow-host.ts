import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { join } from 'node:path';
import { handleWorkflowCommand, workflowDigest, type WorkflowRuntime, type WorkflowState } from '@kuribohg/agent-workflows';
import { capabilityForProfile } from '../../agent/backends';
import { modelRunArguments, type ModelSettings } from '../../agent/model-settings';
import type { Controls, WorkflowControl } from '../../commands';
import type { AgentKind } from '../../config/profile-schema';
import { getAgentStopGraceMs, getCacheKeepalive, getRunIdleTimeoutMs, getWorkflowTimeoutMinutes } from '../../config/schema';
import { DEFAULT_STALL_MS } from '@kuribohg/agent-workflows';
import { sanitizeLogsForDoctor } from '../../core/logger';
import { canUseDm, canUseGroup } from '../../policy/access';
import type { AgentEntry } from '../../runtime/agent-entry';
import { profileForAgentKind } from '../../runtime/execution-controller';
import { resolveRunModelSettings } from '../../runtime/model-settings';
import type { RunExecutor } from '../../runtime/run-executor';
import { resolveRunFlowContext, startRunFlow } from '../../runtime/run-flow';
import type { SessionCatalog } from '../../session/catalog';
import type { SessionStore } from '../../session/store';
import { bridgeAgentKind, resolveWorkerExecution } from '../../workflows/bridge/execution';
import { createBridgeWorkflowRuntime } from '../../workflows/bridge/runtime';
import type { WorkspaceStore } from '../../workspace/store';
import { CacheKeepalive, type CachePing } from '../../runtime/cache-keepalive';
import type { PendingMessage, PendingQueue } from './pending-queue';
import type { ConversationTurns } from '../../runtime/turns';
import { WorkflowOrigins } from '../../runtime/workflow-origins';
import { WorkflowProgressCards } from './workflow-progress-cards';

export interface LarkWorkflowHostDeps {
  channel: LarkChannel;
  executor: RunExecutor;
  controls: Controls;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  /** Profile state directory; workflows are disabled without one. */
  stateDir?: string;
  turns: ConversationTurns;
  pending: PendingQueue;
  resolveAgentKind(scope: string): AgentKind;
  dispatch(scope: string, batch: PendingMessage[], options: { signal: AbortSignal; entry: AgentEntry }): Promise<unknown>;
}

// The fork shares the main session's request prefix, so this prompt is all it adds; the answer is discarded.
const KEEPALIVE_PROMPT = '这是 bridge 发出的缓存保活请求，不是用户输入。只回复 ok，不要调用任何工具，不要继续之前的任务。';

/** The workflow runtime of one Lark connection, with its origin messages and progress cards. */
export class LarkWorkflowHost {
  readonly origins: WorkflowOrigins<NormalizedMessage>;
  private runtime: WorkflowRuntime | undefined;
  private progressCards: WorkflowProgressCards | undefined;
  private controlView: WorkflowControl | undefined;
  private keepalive: CacheKeepalive | undefined;

  constructor(private readonly deps: LarkWorkflowHostDeps) {
    this.origins = new WorkflowOrigins(deps.stateDir ? join(deps.stateDir, 'workflow-origins.json') : undefined,
      origin => typeof (origin as Partial<NormalizedMessage>).chatId === 'string');
  }

  /** Started runtime, for turns that bind to their workflow. */
  get current(): WorkflowRuntime | undefined {
    return this.runtime;
  }

  /** Command surface, available once the runtime has started. */
  control(): WorkflowControl | undefined {
    return this.controlView;
  }

  async start(): Promise<void> {
    if (this.runtime) return;
    // Load after a handoff so origins recorded by the previous process are included.
    await this.origins.load();
    const stateDir = this.deps.stateDir;
    if (!this.deps.sessionCatalog || !stateDir) return;
    const runtime = this.runtime = this.createRuntime(this.deps.sessionCatalog, stateDir);
    this.progressCards = new WorkflowProgressCards({ channel: this.deps.channel, kernel: runtime.kernel,
      origins: this.origins, path: join(stateDir, 'workflow-progress-cards.json') });
    await this.progressCards.start();
    await runtime.start();
    const { controls, pending, turns } = this.deps;
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
        ? getCacheKeepalive(profileForAgentKind(controls.profileConfig, 'claude')) : undefined,
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
        if (controls.channel?.activeTimedRun(scope)) return '请先结束当前限时任务。';
        const queued = pending.push(scope, { ...message, content, agentEntry: { kind: 'workflow', trigger: 'command' } });
        if (queued === undefined) return '消息队列已满，请稍后重试。';
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

  /** Stops card edits before the runtime, so shutdown transitions are not published as progress. */
  close(): { progressCards: Promise<void> | undefined; runtime: Promise<void> | undefined } {
    this.controlView = undefined;
    const keepalive = this.keepalive?.close();
    return { progressCards: this.progressCards?.close(), runtime: Promise.all([keepalive, this.runtime?.close()]).then(() => {}) };
  }

  private async replyToOrigin(state: WorkflowState, text: string): Promise<void> {
    const message = this.origins.get(state.root.scopeId);
    if (!message) throw new Error('Workflow reply destination unavailable');
    const receipt = await this.deps.channel.send(message.chatId, { markdown: text },
      { replyTo: message.messageId, replyInThread: Boolean(message.threadId) });
    if (!receipt.messageId?.trim()) throw new Error('Workflow message delivery returned no message receipt');
  }

  private createRuntime(sessionCatalog: SessionCatalog, stateDir: string): WorkflowRuntime {
    const { controls, executor, turns } = this.deps;
    return createBridgeWorkflowRuntime({
      path: join(stateDir, 'workflows.sqlite'), executor,
      getTimeoutMinutes: root => getWorkflowTimeoutMinutes(profileForAgentKind(controls.profileConfig, bridgeAgentKind(root.agentKind))),
      // A silent worker is stopped and retried; the conversation idle timeout is the natural knob for it.
      stallMs: getRunIdleTimeoutMs(controls.profileConfig) ?? DEFAULT_STALL_MS,
      showPlan: async (state, text) => {
        await this.replyToOrigin(state, text);
        this.progressCards?.track(state);
      },
      notify: (state, text) => this.replyToOrigin(state, text),
      resolveWorker: async (root, selection, policy) => {
        const { agentKind: kind, ...overrides } = selection;
        const agentKind = bridgeAgentKind(kind);
        const profile = profileForAgentKind(controls.profileConfig, agentKind);
        // bridgeWorkerPolicy has already validated the engine's string-typed efforts.
        const requested = overrides as ModelSettings;
        const settings = agentKind === root.agentKind ? { ...root.modelSettings as ModelSettings, ...requested }
          : await resolveRunModelSettings(controls, root.scopeId, requested, agentKind);
        return resolveWorkerExecution(root, profile, policy,
          { model: settings.model, reasoningEffort: settings.reasoningEffort });
      },
      resolve: scope => this.resolveRoot(scope, sessionCatalog),
      wakeMain: async scope => {
        const message = this.origins.get(scope);
        if (!message || !turns.isIdle(scope)) return;
        const turn = turns.claim(scope);
        const eventIds = this.runtime?.kernel.state(scope)?.events.filter(event => !event.acknowledged).map(event => event.id) ?? [];
        try {
          await turn.run(async signal => { await this.deps.dispatch(scope, [message], { signal, entry: { kind: 'workflow', trigger: 'event' } }); });
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
    const message: NormalizedMessage | undefined = this.origins.get(scope);
    if (!message) return undefined;
    const { controls, sessions, workspaces } = this.deps;
    const agentKind = this.deps.resolveAgentKind(scope);
    const profileConfig = profileForAgentKind(controls.profileConfig, agentKind);
    const capability = capabilityForProfile(profileConfig);
    const input = { scopeId: scope,
      scope: { source: 'im' as const, chatId: message.chatId, actorId: message.senderId, ...(message.threadId ? { threadId: message.threadId } : {}) },
      prompt: '', attachments: [],
      access: message.chatType === 'p2p' ? canUseDm(profileConfig, controls, message.senderId)
        : canUseGroup(profileConfig, controls, message.chatId, message.senderId),
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
    const { controls } = this.deps;
    const modelSettings = modelRunArguments(await resolveRunModelSettings(controls, scope, undefined, agentKind));
    return { policy: context.policy, root: { scopeId: scope, profile: controls.profile, agentKind,
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
    const { controls, executor } = this.deps;
    const modelSettings = modelRunArguments(await resolveRunModelSettings(controls, scope, undefined, resolved.agentKind));
    const started = await startRunFlow({
      ...resolved.input, prompt: KEEPALIVE_PROMPT, now: Date.now(), executor, signal, modelSettings,
      stopGraceMs: getAgentStopGraceMs(controls.cfg), userQuestions: true,
      fork: { executionScopeId: `cache-keepalive:${scope}`, ephemeral: true, prompt: () => KEEPALIVE_PROMPT },
      observability: { profile: controls.profile, agent: resolved.capability.agentId, source: 'cache-keepalive', stage: 'submit' },
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
