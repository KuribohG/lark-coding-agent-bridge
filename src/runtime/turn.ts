import { getAgentStopGraceMs, getRunIdleTimeoutMs, type AppPreferences } from '../config/schema';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import type { ActiveRuns } from './active-runs';
import type { RunExecutor } from './run-executor';
import { startRunFlow, type StartRunFlowInput, type StartRunFlowResult } from './run-flow';
import { presentRunOutput, type RunOutputOptions, type RunOutputPlugin } from './run-output';
import { trackRunSession, type RunSessionSource } from './session-progress';

/** Execution and session state one conversation host shares across its turns. */
export interface TurnStores {
  executor: RunExecutor;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
}

export interface TurnRequest extends Omit<StartRunFlowInput,
  'executor' | 'sessions' | 'sessionCatalog' | 'workspaces' | 'now' | 'stopGraceMs'> {
  /** Where idle timeout and stop grace are read from; defaults to the run profile. */
  runPreferences?: { preferences?: Pick<AppPreferences, 'runIdleTimeoutMinutes' | 'agentStopGraceMs'> };
}

export type TurnRejected = Extract<StartRunFlowResult, { ok: false }>;

export type StartedTurn = Extract<StartRunFlowResult, { ok: true }> & {
  /** Persist session progress; call once the host has accepted the run. */
  track(source: RunSessionSource): Promise<void>;
  /** Render the run through a channel output with the turn's idle watchdog. */
  present(output: RunOutputPlugin, options?: Partial<RunOutputOptions>): Promise<void>;
  idleTimeoutMs?: number;
};

/**
 * One conversation turn, shared by every channel: policy, workspace and session
 * resolution, submission, session tracking and output. Channels add only what
 * is specific to them (prompt assembly, replies, cards) around it.
 */
export async function startTurn(stores: TurnStores, request: TurnRequest): Promise<StartedTurn | TurnRejected> {
  const { runPreferences = request.profileConfig, ...input } = request;
  const flow = await startRunFlow({
    ...input,
    executor: stores.executor,
    sessions: stores.sessions,
    sessionCatalog: stores.sessionCatalog,
    workspaces: stores.workspaces,
    stopGraceMs: getAgentStopGraceMs(runPreferences),
    now: Date.now(),
  });
  if (!flow.ok) return flow;
  const idleTimeoutMs = turnIdleTimeoutMs(stores.sessions, request.scopeId, runPreferences);
  return {
    ...flow,
    idleTimeoutMs,
    track: source => trackRunSession({
      scopeId: request.scopeId, sessions: stores.sessions, sessionCatalog: stores.sessionCatalog,
      capability: request.capability, policy: flow.policy, execution: flow.execution,
      activeRuns: stores.activeRuns, resumeFrom: flow.resumeFrom, source,
    }),
    present: (output, options = {}) => presentRunOutput(flow.execution, output, {
      idleTimeoutMs, filterForPrefs: state => state, ...options,
    }),
  };
}

/** A scope override (0 = off) wins over the profile default. */
function turnIdleTimeoutMs(
  sessions: SessionStore,
  scope: string,
  config: { preferences?: Pick<AppPreferences, 'runIdleTimeoutMinutes'> },
): number | undefined {
  const override = sessions.getIdleTimeoutMinutes(scope);
  if (override !== undefined) return override > 0 ? override * 60_000 : undefined;
  return getRunIdleTimeoutMs(config);
}
