import type { ModelSettings } from './model-settings';
import type { AgentRun, AgentRunOptions, PreparedAgentRun } from './types';

/** Capture caller-owned values before preparation crosses an asynchronous boundary. */
export function snapshotRunOptions(options: AgentRunOptions): AgentRunOptions {
  return Object.freeze({
    ...options,
    ...(options.env ? { env: Object.freeze({ ...options.env }) } : {}),
    ...(options.images ? { images: Object.freeze([...options.images]) } : {}),
    ...(options.modelProvider ? { modelProvider: structuredClone(options.modelProvider) } : {}),
  });
}

/** A prepared attempt can start once; a retry must prepare a new attempt. */
export function preparedRun(
  modelSettings: ModelSettings,
  start: () => AgentRun,
  provider?: PreparedAgentRun['provider'],
): PreparedAgentRun {
  let started = false;
  return Object.freeze({
    modelSettings: Object.freeze({ ...modelSettings }),
    ...(provider ? { provider: Object.freeze({ ...provider }) } : {}),
    start() {
      if (started) throw new Error('Prepared agent run has already been started');
      started = true;
      return start();
    },
  });
}
