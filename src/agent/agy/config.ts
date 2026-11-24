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
  context1m?: boolean;
  additionalDirs?: string[];
}

export function normalizeAgy(input: AgyConfig): AgyConfig {
  const additionalDirs = Array.isArray(input.additionalDirs)
    ? input.additionalDirs.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
    : undefined;
  return {
    ...normalizeExecutableLaunch(input, 'agy'),
    ...(input.authMode !== undefined ? { authMode: normalizeAuthMode(input.authMode, 'agy.authMode') } : {}),
    ...(typeof input.apiKey === 'string' && input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(typeof input.baseUrl === 'string' && input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(typeof input.model === 'string' && input.model ? { model: input.model } : {}),
    ...(typeof input.contextWindow === 'number' ? { contextWindow: input.contextWindow } : {}),
    ...(typeof input.context1m === 'boolean' ? { context1m: input.context1m } : {}),
    ...(additionalDirs?.length ? { additionalDirs } : {}),
  };
}
