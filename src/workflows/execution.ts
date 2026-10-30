import { isAgentKind } from '../agent/backend-spec';
import { parseEffort } from '../agent/model-settings';
import { validateModelId } from '../agent/models';
import { backendFor, capabilityForProfile } from '../agent/backends';
import { accessToClaudePermissionMode, accessToCodexSandbox, clampAccess } from '../config/permissions';
import type { AgentExecutionProfile } from '../config/profile-schema';
import type { ModelSettings } from '../agent/model-settings';
import type { RunPolicyAllow } from '../policy/run-policy';
import { workflowDigest } from './digest';
import type { WorkerExecution, WorkerExecutionSelection, WorkflowRoot } from './types';

export function workerSelection(value: unknown, root: WorkflowRoot): WorkerExecutionSelection {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('execution must be an object');
  }
  const input = (value ?? {}) as Record<string, unknown>;
  if (Object.keys(input).some(key => !['agentKind', 'model', 'reasoningEffort'].includes(key))) {
    throw new Error('execution supports agentKind, model and reasoningEffort within the current profile');
  }
  const agentKind = input.agentKind ?? root.agentKind;
  if (!isAgentKind(agentKind)) throw new Error('Unknown worker agentKind');
  if (input.model !== undefined && (typeof input.model !== 'string' || !input.model.trim() || input.model === 'default')) {
    throw new Error('Worker model must be an explicit nonempty model ID');
  }
  const model = input.model === undefined ? undefined : validateModelId(input.model as string);
  const reasoningEffort = parseEffort(input.reasoningEffort, agentKind, { timedRun: true });
  return { agentKind, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export function inheritedWorkerExecution(root: WorkflowRoot, selection: WorkerExecutionSelection): WorkerExecution {
  if (selection.agentKind !== root.agentKind) throw new Error('Host does not support cross-harness workers');
  const { agentKind, ...overrides } = selection;
  return { agentKind, profile: root.profile, modelSettings: { ...root.modelSettings, ...overrides },
    policyFingerprint: root.policyFingerprint, configurationFingerprint: root.policyFingerprint };
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
