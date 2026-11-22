import { isAgentKind, isRegisteredAgentKind, sessionIdFieldForAgent } from '../../agent/backend-spec';
import { parseEffort } from '../../agent/model-settings';
import { validateModelId } from '../../agent/models';
import { backendFor, capabilityForProfile } from '../../agent/backends';
import { accessToClaudePermissionMode, accessToCodexSandbox, clampAccess } from '../../config/permissions';
import type { AgentExecutionProfile, AgentKind } from '../../config/profile-schema';
import type { RunPolicyAllow } from '../../policy/run-policy';
import { parseModelJson } from '../../utils/model-json';
import { workflowDigest } from '@kuribohg/agent-workflows';
import type { ModelSettings, WorkerExecution, WorkerExecutionPolicy, WorkflowRoot } from '@kuribohg/agent-workflows';

export interface BridgeWorkerPolicyOptions {
  /** Allow host-managed harnesses such as `'dsh'` when the host supplies a custom runner or policy. */
  allowHostManaged?: boolean;
}

export function createBridgeWorkerPolicy(
  options: BridgeWorkerPolicyOptions = {},
): Required<WorkerExecutionPolicy> {
  const allowKind = options.allowHostManaged ? isRegisteredAgentKind : isAgentKind;
  return {
    checkSelection(selection) {
      if (!allowKind(selection.agentKind)) throw new Error('Unknown worker agentKind');
      if (selection.model !== undefined) validateModelId(selection.model);
      parseEffort(selection.reasoningEffort, selection.agentKind, { extended: true });
    },
    nativeIdKind: agentKind => sessionIdFieldForAgent(bridgeAgentKind(agentKind, options)),
    repairJson: parseModelJson,
  };
}

/** Bridge harness, model-ID and effort rules for workflow workers. */
export const bridgeWorkerPolicy: Required<WorkerExecutionPolicy> = createBridgeWorkerPolicy();

export function bridgeAgentKind(value: string, options: BridgeWorkerPolicyOptions = {}): AgentKind {
  const allowKind = options.allowHostManaged ? isRegisteredAgentKind : isAgentKind;
  if (!allowKind(value)) throw new Error(`Unknown agentKind: ${value}`);
  return value;
}

/**
 * Launch settings that decide which harness a pinned worker session belongs to. Launch env is left out: it tunes the
 * process (compaction window, endpoints, proxies) and changing it mid-workflow must not strand the workers already pinned.
 */
function launchIdentity(launch: Partial<AgentExecutionProfile>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(launch).map(([kind, value]) => {
    if (!value || typeof value !== 'object') return [kind, value];
    const { env: _env, ...identity } = value as Record<string, unknown>;
    return [kind, identity];
  }));
}

export function resolveWorkerExecution(root: WorkflowRoot, profile: AgentExecutionProfile,
  rootPolicy: RunPolicyAllow, modelSettings: ModelSettings): { execution: WorkerExecution; policy: RunPolicyAllow } {
  const backend = backendFor(profile.agentKind);
  const capability = capabilityForProfile(profile);
  if (backend.executionCapabilities(profile).finalAnswer !== 'separate-event') {
    throw new Error('Worker backend does not provide authoritative final answers');
  }
  const accessMode = clampAccess(rootPolicy.accessMode, profile.permissions.maxAccess, capability.permissions.maxAccess);
  if (capability.permissions.supportedAccess && !capability.permissions.supportedAccess.includes(accessMode)) {
    throw new Error(`${profile.agentKind} does not support ${accessMode} worker access`);
  }
  const configurationFingerprint = workflowDigest({ profile: root.profile, agentKind: profile.agentKind,
    launch: launchIdentity(backend.existingProfile(profile)), permissions: profile.permissions });
  const policyFingerprint = workflowDigest({ root: rootPolicy.policyFingerprint, configurationFingerprint, accessMode });
  return {
    execution: { agentKind: profile.agentKind, profile: root.profile, modelSettings, configurationFingerprint, policyFingerprint },
    policy: { ...rootPolicy, accessMode, sandbox: accessToCodexSandbox(accessMode),
      permissionMode: accessToClaudePermissionMode(accessMode, profile.permissions), policyFingerprint },
  };
}
