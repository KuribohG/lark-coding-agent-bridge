import type { WorkerExecution, WorkerExecutionPolicy, WorkerExecutionSelection, WorkflowRoot } from './types';

/** Structural parse of a worker execution override; host-specific names are checked by `policy`. */
export function workerSelection(value: unknown, root: WorkflowRoot, policy: WorkerExecutionPolicy = {}): WorkerExecutionSelection {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('execution must be an object');
  }
  const input = (value ?? {}) as Record<string, unknown>;
  if (Object.keys(input).some(key => !['agentKind', 'model', 'reasoningEffort'].includes(key))) {
    throw new Error('execution supports agentKind, model and reasoningEffort within the current profile');
  }
  const agentKind = input.agentKind ?? root.agentKind;
  if (typeof agentKind !== 'string' || !agentKind) throw new Error('Unknown worker agentKind');
  if (input.model !== undefined && (typeof input.model !== 'string' || !input.model.trim() || input.model === 'default')) {
    throw new Error('Worker model must be an explicit nonempty model ID');
  }
  const model = input.model === undefined ? undefined : (input.model as string).trim();
  const effort = input.reasoningEffort;
  if (effort !== undefined && typeof effort !== 'string') throw new Error('reasoningEffort must be a string');
  const reasoningEffort = effort === '' || effort === 'default' ? undefined : effort;
  const selection = { agentKind, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) };
  policy.checkSelection?.(selection);
  return selection;
}

export function inheritedWorkerExecution(root: WorkflowRoot, selection: WorkerExecutionSelection): WorkerExecution {
  if (selection.agentKind !== root.agentKind) throw new Error('Host does not support cross-harness workers');
  const { agentKind, ...overrides } = selection;
  return { agentKind, profile: root.profile, modelSettings: { ...root.modelSettings, ...overrides },
    policyFingerprint: root.policyFingerprint, configurationFingerprint: root.policyFingerprint };
}
