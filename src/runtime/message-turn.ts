import { capabilityForProfile } from '../agent/backends';
import { modelRunArguments, type ModelSettings, type ResolvedModelSettings } from '../agent/model-settings';
import { modelLabel, normalizeModelSelection } from '../agent/models';
import type { AgentAdapter } from '../agent/types';
import type { RunHostBinding } from '../agent/run-host';
import type { AgentCapability } from '../agent/capability';
import type { AgentKind, RunProfileConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import type { AccessDecision } from '../policy/access';
import type { AgentAttachment, ScopeContext } from '../policy/run-policy';
import type { WorkflowRuntime } from '@kuribohg/agent-workflows';
import { bindAgentEntry, workflowWakePrompt, type AgentEntry } from './agent-entry';
import type { RunExecution } from './run-executor';
import type { RunSessionSource } from './session-progress';
import type { ScopeRunMemory } from './scope-run-memory';
import { startTurn, type StartedTurn, type TurnRejected, type TurnRequest, type TurnStores } from './turn';

/** One inbound batch to answer, plus how it was started. */
export interface MessageTurn<M> {
  scope: string;
  batch: M[];
  agentKind: AgentKind;
  agent: AgentAdapter;
  entry?: AgentEntry;
  workflows?: WorkflowRuntime;
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
  profileConfig: RunProfileConfig;
  capability: AgentCapability;
  /** Model and effort this turn runs with; absent when the host keeps profile defaults. */
  modelSettings?: ModelSettings;
  /** Set when the scope's previous turn used another model. */
  modelSwitchedTo?: string;
  resumeAttempt?: number;
}

/** The channel-specific half of a turn: what to send and how to show it. */
export interface PreparedMessageTurn {
  /** Conversation scope used for policy, sessions and workspaces. */
  scope: ScopeContext;
  access: AccessDecision;
  attachments: AgentAttachment[];
  /** Channel instructions, before the model-switch, replay and entry ones. */
  instructions?: string[];
  /** Final prompt once the host appended its own instructions. */
  prompt(instructions: string[]): string;
  /** System prompt the run's policy fingerprint includes, when the host sets one. */
  systemPrompt?: string;
  /** What the session record says this turn consumed. */
  sessionSource: RunSessionSource;
  /** Input message ids follow-ups are recorded against while the run is active. */
  inputMessageIds?: string[];
  /** Context counters logged with the assembled prompt. */
  details?: Record<string, number>;
  /** Observability source of this frontend. */
  observabilitySource: string;
  runOptions?: { deadlineAt?: number; userQuestions?: boolean; answerIncludesInterimText?: boolean };
  /**
   * What a rendering failure means: `fail` rejects the turn (hosts whose
   * output is their event stream), `log` keeps the completed run (channels
   * whose card write can fail without changing what happened).
   */
  presentFailure?: 'fail' | 'log';
}

export interface MessageTurnFrontend<M, T extends MessageTurn<M> = MessageTurn<M>> {
  /** Orders the batch oldest first, in place when the channel can; the given order is kept when absent. */
  order?(batch: M[]): M[];
  /** Gathers channel context and builds the prompt. */
  prepare(context: MessageTurnContext<M, T>): Promise<PreparedMessageTurn>;
  /** Called once the run was accepted, before its output starts. */
  started?(context: MessageTurnContext<M, T>, prepared: PreparedMessageTurn, started: StartedTurn): void;
  /** Tells the conversation why the run did not start. */
  reject(context: MessageTurnContext<M, T>, prepared: PreparedMessageTurn, reason: TurnRejected['rejectReason']): Promise<void>;
  /** Publishes questions raised by the run until its event stream ends. */
  questions?(context: MessageTurnContext<M, T>, prepared: PreparedMessageTurn, started: StartedTurn): Promise<void>;
  /** Renders the accepted run. */
  present(context: MessageTurnContext<M, T>, prepared: PreparedMessageTurn, started: StartedTurn): Promise<void>;
}

export interface MessageTurnHostDeps {
  stores: TurnStores;
  /** Profile configuration for the turn's engine. */
  profileFor(agentKind: AgentKind): RunProfileConfig;
  /**
   * Resolve the turn's model and effort. When absent the host keeps the
   * startTurn profile defaults and does not track model switches.
   */
  resolveModelSettings?(scope: string, agentKind: AgentKind): Promise<ResolvedModelSettings>;
  /** Preferences the stop grace and idle watchdog read; defaults to the scoped profile. */
  runPreferences?: TurnRequest['runPreferences'];
  /** Profile name recorded with the run's observability, when the host has one. */
  profile?: string;
  /** Per-scope facts shared by turns of one channel connection. */
  memory: ScopeRunMemory;
}

/** An accepted turn: what started, and when its output, session and questions have all settled. */
export interface StartedMessageTurn {
  /** The submitted execution with the policy and workspace it resolved. */
  flow: Omit<StartedTurn, 'track' | 'present'>;
  done: Promise<void>;
}

export type MessageTurnStart = { ok: true; turn: StartedMessageTurn } | { ok: false; reason: TurnRejected['rejectReason'] };

/**
 * Starts one message turn: model resolution, agent entry, policy submission,
 * session tracking, follow-up seeding and the question/output lifecycle.
 * Channels supply only their context, prompt, notice and presentation through
 * `MessageTurnFrontend`. Hosts that must return before rendering finishes use
 * this; `runMessageTurn` is the same thing awaited to completion.
 */
export async function startMessageTurn<M, T extends MessageTurn<M>>(
  deps: MessageTurnHostDeps,
  frontend: MessageTurnFrontend<M, T>,
  turn: T,
): Promise<MessageTurnStart> {
  const entry = turn.entry ?? { kind: 'direct' };
  const wake = entry.kind === 'workflow' && entry.trigger === 'event';
  const batch = frontend.order ? frontend.order(turn.batch) : turn.batch;
  const first = batch[0];
  if (!first) throw new Error('a message turn needs at least one input');

  const scopedProfile = deps.profileFor(turn.agentKind);
  const capability = capabilityForProfile(scopedProfile);
  const model = await resolveTurnModel(deps, turn);
  const context: MessageTurnContext<M, T> = {
    turn,
    input: wake ? [] : batch,
    wake,
    profileConfig: scopedProfile,
    capability,
    ...(model.settings ? { modelSettings: model.settings } : {}),
    ...(model.modelSwitched ? { modelSwitchedTo: modelLabel(turn.agentKind, model.modelPref) } : {}),
    ...(turn.resumeAttempt ? { resumeAttempt: turn.resumeAttempt } : {}),
  };

  const prepared = await frontend.prepare(context);
  const instructions = [...(prepared.instructions ?? [])];
  if (context.modelSwitchedTo !== undefined) instructions.push(modelSwitchInstruction(context.modelSwitchedTo));
  if (context.resumeAttempt) instructions.push(resumeInstruction(context.resumeAttempt));
  const entryBinding = bindAgentEntry(entry, turn.scope, turn.workflows);
  if (entryBinding) instructions.push(entryBinding.instructions);
  let prompt: string;
  try {
    prompt = wake ? workflowWakePrompt(entryBinding?.instructions) : prepared.prompt(instructions);
  } catch (error) { entryBinding?.release(); throw error; }
  log.info('prompt', 'built', {
    promptChars: prompt.length,
    ...prepared.details,
    ...(model.modelSwitched ? { modelSwitchedTo: model.modelSelection } : {}),
  });

  const flow = await startTurn(deps.stores, {
    env: entryBinding?.env,
    ...(model.settings ? { modelSettings: model.settings } : {}),
    signal: turn.signal,
    scopeId: turn.scope,
    scope: prepared.scope,
    prompt,
    ...(prepared.systemPrompt !== undefined ? { systemPrompt: prepared.systemPrompt } : {}),
    attachments: prepared.attachments,
    access: prepared.access,
    capability,
    profileConfig: scopedProfile,
    ...(deps.runPreferences ? { runPreferences: deps.runPreferences } : {}),
    agent: turn.agent,
    userQuestions: prepared.runOptions?.userQuestions ?? false,
    ...(prepared.runOptions?.deadlineAt !== undefined ? { deadlineAt: prepared.runOptions.deadlineAt } : {}),
    ...(prepared.runOptions?.answerIncludesInterimText !== undefined
      ? { answerIncludesInterimText: prepared.runOptions.answerIncludesInterimText }
      : {}),
    host: turn.host,
    ...(deps.profile
      ? {
          observability: {
            profile: deps.profile,
            agent: capability.agentId,
            source: prepared.observabilitySource,
            stage: 'submit',
          },
        }
      : {}),
  }).catch(error => { entryBinding?.release(); throw error; });
  if (!flow.ok) {
    entryBinding?.release();
    if (wake) throw new Error(flow.rejectReason.userVisible);
    log.info('run-flow', 'rejected', { scope: turn.scope, code: flow.rejectReason.code });
    log.warn('policy', 'denied', { scope: turn.scope, source: prepared.observabilitySource, code: flow.rejectReason.code });
    await frontend.reject(context, prepared, flow.rejectReason);
    return { ok: false, reason: flow.rejectReason };
  }

  if (entryBinding) {
    void flow.execution.result.finally(entryBinding.release);
    entryBinding.onStarted();
  }
  deps.memory.runStarted(turn.scope, flow.policy.policyFingerprint);
  deps.stores.activeRuns.seedInputMessages(turn.scope, flow.execution.handle.run, new Set(prepared.inputMessageIds ?? []));
  if (flow.resumeFrom) {
    log.info('session', 'resume', { sessionId: flow.resumeFrom, cwd: flow.cwdRealpath });
  } else {
    log.info('session', 'fresh', { cwd: flow.cwdRealpath });
  }
  frontend.started?.(context, prepared, flow);

  const sessionDone = flow.track(wake ? { kind: 'internal' } : prepared.sessionSource);
  // The observer starts with execution, even if rendering cannot start.
  void sessionDone.catch(err => log.warn('session', 'tracking-failed', { scope: turn.scope, err: String(err) }));
  const questionsDone = frontend.questions ? frontend.questions(context, prepared, flow) : Promise.resolve();
  const rendered = frontend.present(context, prepared, flow).catch(err => {
    // A channel's card write can fail without changing what the run did; a
    // host whose output is its event stream reports the failure instead.
    if ((prepared.presentFailure ?? 'fail') === 'log') { log.fail('stream', err); return; }
    throw err;
  });
  const done = Promise.allSettled([rendered, sessionDone, questionsDone]).then(results => {
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }).finally(() => deps.memory.runEnded(turn.scope));

  const { track: _track, present: _present, ...started } = flow;
  return { ok: true, turn: { flow: started, done } };
}

/** Runs one message turn to completion; returns the execution once its output has been presented. */
export async function runMessageTurn<M, T extends MessageTurn<M>>(
  deps: MessageTurnHostDeps,
  frontend: MessageTurnFrontend<M, T>,
  turn: T,
): Promise<RunExecution | undefined> {
  const started = await startMessageTurn(deps, frontend, turn);
  if (!started.ok) return undefined;
  await started.turn.done;
  return started.turn.flow.execution;
}

async function resolveTurnModel<M, T extends MessageTurn<M>>(deps: MessageTurnHostDeps, turn: T) {
  if (!deps.resolveModelSettings) return { modelSwitched: false as const };
  const settings = await deps.resolveModelSettings(turn.scope, turn.agentKind);
  const runArguments = modelRunArguments(settings);
  const modelPref = runArguments.model;
  const modelSelection = normalizeModelSelection(turn.agentKind, modelPref);
  const modelSwitched = deps.memory.modelSwitched(turn.agentKind, turn.scope, modelSelection);
  return { settings: runArguments, modelPref, modelSelection, modelSwitched };
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
