import { backendFor, createAgentAdapter, isAgentKind } from '../agent/backends';
import { AgentPreflightError, type AgentAvailability } from '../agent/preflight';
import type { AgentAdapter } from '../agent/types';
import type { AgentSystemPrompt } from '../agent/system-prompt';
import type { AppPaths } from '../config/app-paths';
import type { AgentExecutionProfile, AgentKind } from '../config/profile-schema';
import type { AcquiredRuntimeLock } from './locks';

/**
 * Build a generic agent adapter. Channel-specific environment and prompts are
 * supplied by the host instead of being inferred here.
 */
export function createRuntimeAgent(
  profileConfig: AgentExecutionProfile,
  appPaths: Pick<AppPaths, 'profileDir'>,
  host: {
    env?: NodeJS.ProcessEnv;
    systemPrompt?: AgentSystemPrompt;
  } = {},
): AgentAdapter {
  return createAgentAdapter({
    profile: profileConfig,
    profileDir: appPaths.profileDir,
    env: host.env ?? {},
    systemPrompt: host.systemPrompt ?? '',
  });
}

export async function checkRuntimeAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {
  if (agent.checkAvailability) return agent.checkAvailability();
  const ok = await agent.isAvailable();
  if (ok) return { ok: true };
  const backend = backendFor(isAgentKind(agent.id) ? agent.id : 'claude');
  const diagnostic = {
    code: 'agent-binary-not-found' as const,
    agentId: backend.kind,
    agentName: agent.displayName,
    command: backend.defaultCommand,
  };
  return { ok: false, diagnostic, error: new AgentPreflightError(diagnostic) };
}

/** Guard: reconnect/restart must not switch a profile's agent kind mid-flight. */
export function assertReconnectAgentKindUnchanged(
  current: AgentKind | undefined,
  next: AgentKind | undefined,
): void {
  const currentKind = current ?? 'claude';
  const nextKind = next ?? 'claude';
  if (nextKind !== currentKind) {
    throw new Error(
      `agent kind cannot change during reconnect (${currentKind} -> ${nextKind}); stop/start is required`,
    );
  }
}

/** Release a set of runtime locks, swallowing individual failures. */
export async function releaseRuntimeLocks(locks: AcquiredRuntimeLock[]): Promise<void> {
  for (const lock of locks) {
    await lock.release().catch(() => undefined);
  }
}
