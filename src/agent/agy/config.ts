import {
  normalizeAuthMode,
  normalizeExecutableLaunch,
  type AgentAuthMode,
  type ExecutableLaunchConfig,
} from '../launch-options';

export interface AgyConfig extends ExecutableLaunchConfig {
  authMode?: AgentAuthMode;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  contextWindow?: number;
}

export function normalizeAgy(input: AgyConfig): AgyConfig {
  return {
    ...normalizeExecutableLaunch(input, 'agy'),
    ...(input.authMode !== undefined ? { authMode: normalizeAuthMode(input.authMode, 'agy.authMode') } : {}),
    ...(typeof input.apiKey === 'string' && input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(typeof input.baseUrl === 'string' && input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(typeof input.model === 'string' && input.model ? { model: input.model } : {}),
    ...(typeof input.contextWindow === 'number' ? { contextWindow: input.contextWindow } : {}),
  };
}
