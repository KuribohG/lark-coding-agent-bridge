import { isAgentKind, sessionIdFieldForAgent } from '../../agent/backend-spec';
import { parseEffort } from '../../agent/model-settings';
import { validateModelId } from '../../agent/models';
import { backendFor, capabilityForProfile } from '../../agent/backends';
import { accessToClaudePermissionMode, accessToCodexSandbox, clampAccess } from '../../config/permissions';
import type { AgentExecutionProfile, AgentKind } from '../../config/profile-schema';
import type { RunPolicyAllow } from '../../policy/run-policy';
import { workflowDigest } from '@kuribohg/agent-workflows';
import type { ModelSettings, WorkerExecution, WorkerExecutionPolicy, WorkflowRoot } from '@kuribohg/agent-workflows';

/** Bridge harness, model-ID and effort rules for workflow workers. */
export const bridgeWorkerPolicy: Required<WorkerExecutionPolicy> = {
  checkSelection(selection) {
    if (!isAgentKind(selection.agentKind)) throw new Error('Unknown worker agentKind');
    if (selection.model !== undefined) validateModelId(selection.model);
    parseEffort(selection.reasoningEffort, selection.agentKind, { timedRun: true });
  },
  nativeIdKind: agentKind => sessionIdFieldForAgent(bridgeAgentKind(agentKind)),
};

export function bridgeAgentKind(value: string): AgentKind {
  if (!isAgentKind(value)) throw new Error(`Unknown agentKind: ${value}`);
  return value;
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
    launch: backend.existingProfile(profile), permissions: profile.permissions });
  const policyFingerprint = workflowDigest({ root: rootPolicy.policyFingerprint, configurationFingerprint, accessMode });
  return {
    execution: { agentKind: profile.agentKind, profile: root.profile, modelSettings, configurationFingerprint, policyFingerprint },
    policy: { ...rootPolicy, accessMode, sandbox: accessToCodexSandbox(accessMode),
      permissionMode: accessToClaudePermissionMode(accessMode, profile.permissions), policyFingerprint },
  };
}
