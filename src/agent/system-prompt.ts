import type { AgentBotIdentity } from './types';

export type AgentSystemPrompt = string | ((identity: AgentBotIdentity | undefined) => string);

export function resolveSystemPrompt(configured: AgentSystemPrompt | undefined, identity: AgentBotIdentity | undefined): string {
  return typeof configured === 'function' ? configured(identity) : configured ?? '';
}

export function prefixSystemPrompt(prompt: string, systemPrompt: string): string {
  return systemPrompt ? `${systemPrompt}\n\n## user_message\n\n${prompt}` : prompt;
}
