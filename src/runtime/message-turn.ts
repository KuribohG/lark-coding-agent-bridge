import { capabilityForProfile } from '../agent/backends';
import { modelRunArguments, type ModelSettings } from '../agent/model-settings';
import { modelLabel, normalizeModelSelection } from '../agent/models';
import type { AgentAdapter } from '../agent/types';
import type { RunHostBinding } from '../agent/run-host';
import type { AgentCapability } from '../agent/capability';
import type { AgentKind } from '../config/profile-schema';
import type { MutableProfileState } from '../config/config-ops';
import { log } from '../core/logger';
import { toPolicyAttachment, type NormalizedAttachment } from '../media/attachment';
import type { AccessDecision } from '../policy/access';
import type { ScopeContext } from '../policy/run-policy';
import type { WorkflowRuntime } from '@kuribohg/agent-workflows';
import { bindAgentEntry, workflowWakePrompt, type AgentEntry } from './agent-entry';
import { profileForAgentKind } from './execution-controller';
import { resolveRunModelSettings } from './model-settings';
import type { RunExecution } from './run-executor';
import type { RunSessionSource } from './session-progress';
import type { ScopeRunMemory } from './scope-run-memory';
import { startTurn, type StartedTurn, type TurnRejected, type TurnStores } from './turn';

/** One inbound batch to answer, plus how it was started. */
export interface MessageTurn<M> {
  scope: string;
  batch: M[];
  agentKind: AgentKind;
  agent: AgentAdapter;
  entry?: AgentEntry;
  workflows?: WorkflowRuntime;
  workflowOrigins?: Map<string, M>;
  signal?: AbortSignal;
  /** Replay number of input whose earlier run was cut off by a bridge shutdown. */
  resumeAttempt?: number;
  /** Run host that keeps the agent alive across bridge restarts, or the one to reattach to. */
  host?: RunHostBinding;
}

/** What the host resolved before the channel prepares its part of the turn. */
export interface MessageTurnContext<M, T extends MessageTurn<M> = MessageTurn<M>> {
  turn: T;
  /** Input the agent answers; empty for a workflow wake. */
  input: M[];
  wake: boolean;
  /** Profile configuration scoped to `turn.agentKind`. */
  profileConfig: ReturnType<typeof profileForAgentKind>;
  capability: AgentCapability;
  /** Model and effort this turn runs with. */
  modelSettings: ModelSettings;
  /** Set when the scope's previous turn used another model. */
  modelSwitchedTo?: string;
  resumeAttempt?: number;
}

/** The channel-specific half of a turn: what to send and how to show it. */
export interface PreparedMessageTurn {
  /** Conversation scope used for policy, sessions and workspaces. */
  scope: ScopeContext;
  access: AccessDecision;
  attachments: NormalizedAttachment[];
  /** Channel instructions, before the model-switch, replay and entry ones. */
  instructions?: string[];
  /** Final prompt once the host appended its own instructions. */
  prompt(instructions: string[]): string;
  /** What the session record says this turn consumed. */
  sessionSource: RunSessionSource;
  /** Input message ids follow-ups are recorded against while the run is active. */
  inputMessageIds?: string[];
  /** Context counters logged with the assembled prompt. */
  details?: Record<string, number>;
  /** Observability source of this frontend. */
  observabilitySource: string;
  runOptions?: { userQuestions?: boolean; answerIncludesInterimText?: boolean };
}

export interface MessageTurnFrontend<M, T extends MessageTurn<M> = MessageTurn<M>> {
  /** Orders the batch oldest first, in place when the channel can; the given order is kept when absent. */
  order?(batch: M[]): M[];
  /** Gathers channel context and builds the prompt. */
  prepare(context: MessageTurnContext<M, T>): Promise<PreparedMessageTurn>;
  /** Tells the conversation why the run did not start. */
  reject(context: MessageTurnContext<M, T>, prepared: PreparedMessageTurn, reason: TurnRejected['rejectReason']): Promise<void>;
  /** Publishes questions raised by the run until its event stream ends. */
  questions?(context: MessageTurnContext<M, T>, prepared: PreparedMessageTurn, started: StartedTurn): Promise<void>;
  /** Renders the accepted run. */
  present(context: MessageTurnContext<M, T>, prepared: PreparedMessageTurn, started: StartedTurn): Promise<void>;
}

export interface MessageTurnHostDeps {
  /** Profile the turn's model, preferences and worktrees come from. */
  state: MutableProfileState;
  stores: TurnStores;
  /** Per-scope facts shared by turns of one channel connection. */
  memory: ScopeRunMemory;
}

/**
 * One message turn: model resolution, agent entry, policy submission, session
 * tracking and the question/output lifecycle. Channels supply only their
 * context, prompt, notice and presentation through `MessageTurnFrontend`.
 */
export async function runMessageTurn<M, T extends MessageTurn<M>>(
  deps: MessageTurnHostDeps,
  frontend: MessageTurnFrontend<M, T>,
  turn: T,
): Promise<RunExecution | undefined> {
  const entry = turn.entry ?? { kind: 'direct' };
  const wake = entry.kind === 'workflow' && entry.trigger === 'event';
  const batch = frontend.order ? frontend.order(turn.batch) : turn.batch;
  const [first] = batch;
  if (!first) return undefined;
  if (!wake) turn.workflowOrigins?.set(turn.scope, first);

  const scopedProfile = profileForAgentKind(deps.state.profileConfig, turn.agentKind);
  const capability = capabilityForProfile(scopedProfile);
  const model = await resolveTurnModel(deps, turn);
  const context: MessageTurnContext<M, T> = {
    turn,
    input: wake ? [] : batch,
    wake,
    profileConfig: scopedProfile,
    capability,
    modelSettings: model.runArguments,
    ...(model.modelSwitched ? { modelSwitchedTo: modelLabel(turn.agentKind, model.modelPref) } : {}),
    ...(turn.resumeAttempt ? { resumeAttempt: turn.resumeAttempt } : {}),
  };

  const prepared = await frontend.prepare(context);
  const instructions = [...(prepared.instructions ?? [])];
  if (context.modelSwitchedTo !== undefined) instructions.push(modelSwitchInstruction(context.modelSwitchedTo));
  if (context.resumeAttempt) instructions.push(resumeInstruction(context.resumeAttempt));
  const entryBinding = bindAgentEntry(entry, turn.scope, turn.workflows);
  if (entryBinding) instructions.push(entryBinding.instructions);
  const prompt = wake ? workflowWakePrompt(entryBinding?.instructions) : prepared.prompt(instructions);
  log.info('prompt', 'built', {
    promptChars: prompt.length,
    ...prepared.details,
    ...(model.modelSwitched ? { modelSwitchedTo: model.modelSelection } : {}),
  });

  const flow = await startTurn(deps.stores, {
    env: entryBinding?.env,
    modelSettings: model.runArguments,
    signal: turn.signal,
    scopeId: turn.scope,
    scope: prepared.scope,
    prompt,
    attachments: prepared.attachments.map(toPolicyAttachment),
    access: prepared.access,
    capability,
    profileConfig: scopedProfile,
    runPreferences: deps.state.cfg,
    agent: turn.agent,
    userQuestions: prepared.runOptions?.userQuestions ?? false,
    ...(prepared.runOptions?.answerIncludesInterimText !== undefined
      ? { answerIncludesInterimText: prepared.runOptions.answerIncludesInterimText }
      : {}),
    host: turn.host,
    observability: {
      profile: deps.state.profile,
      agent: capability.agentId,
      source: prepared.observabilitySource,
      stage: 'submit',
    },
  }).catch(error => { entryBinding?.release(); throw error; });
  if (!flow.ok) {
    entryBinding?.release();
    if (wake) throw new Error(flow.rejectReason.userVisible);
    log.info('run-flow', 'rejected', { scope: turn.scope, code: flow.rejectReason.code });
    log.warn('policy', 'denied', { scope: turn.scope, source: prepared.observabilitySource, code: flow.rejectReason.code });
    await frontend.reject(context, prepared, flow.rejectReason);
    return undefined;
  }

  const { execution } = flow;
  if (entryBinding) {
    void execution.result.finally(entryBinding.release);
    entryBinding.onStarted();
  }
  deps.memory.runStarted(turn.scope, flow.policy.policyFingerprint);
  deps.stores.activeRuns.seedInputMessages(turn.scope, execution.handle.run, new Set(prepared.inputMessageIds ?? []));
  if (flow.resumeFrom) {
    log.info('session', 'resume', { sessionId: flow.resumeFrom, cwd: flow.cwdRealpath });
  } else {
    log.info('session', 'fresh', { cwd: flow.cwdRealpath });
  }
  const sessionDone = flow.track(wake ? { kind: 'internal' } : prepared.sessionSource);
  // The observer starts with execution, even if rendering cannot start.
  void sessionDone.catch(err => log.warn('session', 'tracking-failed', { scope: turn.scope, err: String(err) }));

  const questionsDone = frontend.questions ? frontend.questions(context, prepared, flow) : Promise.resolve();
  try {
    try {
      await frontend.present(context, prepared, flow);
    } catch (err) {
      // Rendering is not part of the model transaction. A failed write must
      // not make the next turn forget that this run actually completed.
      log.fail('stream', err);
    }
    await sessionDone;
  } finally {
    deps.memory.runEnded(turn.scope);
    await questionsDone;
  }
  return execution;
}

async function resolveTurnModel<M, T extends MessageTurn<M>>(deps: MessageTurnHostDeps, turn: T) {
  const settings = await resolveRunModelSettings(deps.state, turn.scope, undefined, turn.agentKind);
  const runArguments = modelRunArguments(settings);
  const modelPref = runArguments.model;
  const modelSelection = normalizeModelSelection(turn.agentKind, modelPref);
  const modelSwitched = deps.memory.modelSwitched(turn.agentKind, turn.scope, modelSelection);
  return { runArguments, modelPref, modelSelection, modelSwitched };
}

function modelSwitchInstruction(model: string): string {
  return `用户刚把本会话使用的模型切换为「${model}」。` +
    '之前的对话里可能提到别的模型,请以当前模型为准;若被问到你用的是什么模型,据此回答。';
}

function resumeInstruction(attempt: number): string {
  return `bridge 进程在你处理这批消息期间被终止，现已重启并自动续跑（第 ${attempt} 次）。` +
    '如果当前会话里已有这批消息及部分进展，先核对已完成的工作（文件、命令结果、已发出的消息），从中断处继续，' +
    '不要重复已经生效的操作；如果会话里没有，就按正常流程处理。';
}
