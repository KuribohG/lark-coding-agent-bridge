import type { AgentCapability } from '../agent/capability';
import { resolveModelArg } from '../agent/models';
import type { AgentEvent } from '../agent/types';
import type { RunProfileConfig } from '../config/profile-schema';
import type { AccessDecision } from '../policy/access';
import {
  evaluateRunPolicy,
  type AgentAttachment,
  type RunPolicyAllow,
  type RunPolicyReject,
  type ScopeContext,
} from '../policy/run-policy';
import {
  resolveWorkingDirectory,
  type WorkingDirectoryRejectReason,
  type WorkingDirectoryResolveResult,
} from '../policy/workspace';
import type { RunExecution, RunExecutor } from '../runtime/run-executor';
import { RunRejected, type RunRejectedCode } from '../runtime/errors';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { agentBackendSpec } from '../agent/backend-spec';
import { agentStateDirectory } from '../agent/capability';

export interface RunFlowContextInput {
  scopeId: string;
  fork?: {
    executionScopeId: string;
    prompt(parentId: string, policy: RunPolicyAllow): string;
  };
  scope: ScopeContext;
  prompt: string;
  systemPrompt?: string;
  attachments: AgentAttachment[];
  access: AccessDecision;
  capability: AgentCapability;
  profileConfig: RunProfileConfig;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  now: number;
}

export interface StartRunFlowInput extends RunFlowContextInput {
  deadlineAt?: number;
  signal?: AbortSignal;
  modelSettings?: import('../agent/model-settings').ModelSettings;
  executor: RunExecutor;
  stopGraceMs?: number;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export type RunFlowRejectCode =
  | 'parent-session-missing'
  | WorkingDirectoryRejectReason
  | RunPolicyReject['rejectReason']['code']
  | RunRejectedCode;

export type StartRunFlowResult =
  | {
      ok: true;
      execution: RunExecution;
      policy: RunPolicyAllow;
      cwdRealpath: string;
      resumeFrom?: string;
    }
  | {
      ok: false;
      rejectReason: {
        code: RunFlowRejectCode;
        userVisible: string;
      };
      workspace?: WorkingDirectoryResolveResult;
    };

export type RunFlowContextResult =
  | {
      ok: true;
      policy: RunPolicyAllow;
      workspace: Extract<WorkingDirectoryResolveResult, { ok: true }>;
      sessionId?: string;
      threadId?: string;
      resumeFrom?: string;
    }
  | Extract<StartRunFlowResult, { ok: false }>;

export interface RecordRunSessionEventInput {
  scopeId: string;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  capability: AgentCapability;
  policy: RunPolicyAllow;
  event: AgentEvent;
}

/** Resolve policy, workspace, and resumable identity without spawning an agent. */
export async function resolveRunFlowContext(
  input: RunFlowContextInput,
): Promise<RunFlowContextResult> {
  const requestedCwd =
    input.workspaces.cwdFor(input.scopeId) ?? input.profileConfig.workspaces.default ?? '';
  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    return {
      ok: false,
      rejectReason: {
        code: workspace.reason,
        userVisible: workspace.userVisible,
      },
      workspace,
    };
  }

  const policy = evaluateRunPolicy({
    scope: input.scope,
    attachments: input.attachments,
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: input.access,
    capability: input.capability,
    profileConfig: input.profileConfig,
    now: input.now,
    agentStateDir: agentBackendSpec(input.profileConfig.agentKind).includeStateDirectoryInPolicy
      ? agentStateDirectory(input.profileConfig)
      : undefined,
    codexHome: input.profileConfig.codex?.codexHome,
    inheritCodexHome: input.profileConfig.codex?.inheritCodexHome,
  });
  if (!policy.ok) {
    return {
      ok: false,
      rejectReason: policy.rejectReason,
      workspace,
    };
  }

  let resumeFrom: string | undefined;
  let sessionId: string | undefined;
  let threadId: string | undefined;
  if (input.sessionCatalog) {
    const catalogEntry = input.sessionCatalog.activeFor({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint,
    });
    if (input.capability.sessionIdField === 'sessionId' && catalogEntry?.sessionId) {
      sessionId = catalogEntry.sessionId;
      resumeFrom = sessionId;
    } else if (input.capability.sessionIdField === 'threadId' && catalogEntry?.threadId) {
      threadId = catalogEntry.threadId;
      resumeFrom = threadId;
    }
  }
  if (!resumeFrom && input.capability.legacySessionStore && input.scope.source !== 'channel') {
    resumeFrom = input.sessions.resumeFor(input.scopeId, workspace.cwdRealpath);
    sessionId = resumeFrom;
    const stale = input.sessions.getRaw(input.scopeId);
    if (!input.fork && !resumeFrom && stale?.cwd && stale.cwd !== workspace.cwdRealpath) {
      input.sessions.clear(input.scopeId);
    }
  }

  if (input.fork) {
    if (input.fork.executionScopeId === input.scopeId) throw new Error('fork must use a separate execution scope');
    if (!resumeFrom) return {
      ok: false,
      rejectReason: { code: 'parent-session-missing', userVisible: '当前还没有可用的主会话，请先在这里发送一条普通消息，再使用 /btw。' },
    };
    policy.prompt = input.fork.prompt(resumeFrom, policy);
  }

  return {
    ok: true,
    policy,
    workspace,
    ...(resumeFrom ? { resumeFrom } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

export async function startRunFlow(input: StartRunFlowInput): Promise<StartRunFlowResult> {
  const context = await resolveRunFlowContext(input);
  if (!context.ok) return context;
  const { policy, workspace, resumeFrom, sessionId, threadId } = context;

  let execution: RunExecution;
  try {
    execution = await input.executor.submit({
      deadlineAt: input.deadlineAt,
      signal: input.signal,
      scopeId: input.fork?.executionScopeId ?? input.scopeId,
      policy,
      systemPrompt: input.systemPrompt,
      forkSession: Boolean(input.fork),
      sessionId,
      threadId,
      ...(input.modelSettings ?? {
        model: resolveModelArg(input.capability.agentId, input.profileConfig.preferences.model),
        reasoningEffort: input.profileConfig.preferences.reasoningEffort,
      }),
      images:
        input.capability.imageInput === 'paths'
          ? policy.attachments
              .filter((attachment) => attachment.kind === 'image' && attachment.decision === 'accepted')
              .map((attachment) => attachment.path)
              .filter((path): path is string => Boolean(path))
          : undefined,
      stopGraceMs: input.stopGraceMs,
      observability: input.observability,
    });
  } catch (err) {
    if (err instanceof RunRejected) {
      return {
        ok: false,
        rejectReason: {
          code: err.code,
          userVisible:
            err.code === 'deadline-expired' ? '已到限时任务停止时间，未启动任务。'
              : err.code === 'run-cancelled' ? '限时任务已取消，未启动任务。'
              : err.code === 'reconnect-in-progress'
              ? '当前 bot 正在重连，稍后会继续处理新消息。'
              : err.code === 'run-already-active'
                ? '当前会话已有运行在执行，请稍后再试或先停止当前运行。'
              : '当前无法发起运行，请稍后重试。',
        },
        workspace,
      };
    }
    throw err;
  }

  return {
    ok: true,
    execution,
    policy,
    cwdRealpath: workspace.cwdRealpath,
    ...(resumeFrom ? { resumeFrom } : {}),
  };
}

export function recordRunSessionEvent(input: RecordRunSessionEventInput): void {
  if (input.event.type !== 'system') return;
  if (input.capability.sessionIdField === 'sessionId' && input.event.sessionId) {
    const cwdRealpath = input.event.cwd ?? input.policy.cwdRealpath;
    if (input.capability.legacySessionStore) {
      input.sessions.set(input.scopeId, input.event.sessionId, cwdRealpath);
    }
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      sessionId: input.event.sessionId,
    });
    return;
  }
  if (input.capability.sessionIdField === 'threadId' && input.event.threadId) {
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath: input.policy.cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      threadId: input.event.threadId,
    });
  }
}
