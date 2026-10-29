import type { AgentProviderBinding } from '../agent/backend-spec';
import { bindCodexProvider } from '../agent/codex/provider';
import { bindPiProvider } from '../agent/pi/provider';
import { bindAgyProvider } from '../agent/agy/provider';
import type { ProviderBindingInput, ResolvedModelProvider } from './types';

const BINDINGS: Record<AgentProviderBinding, (input: ProviderBindingInput) => ResolvedModelProvider> = {
  'codex-config': bindCodexProvider,
  'pi-extension': bindPiProvider,
  'agy-gemini': bindAgyProvider,
};

export function bindModelProvider(binding: AgentProviderBinding, input: ProviderBindingInput): ResolvedModelProvider {
  return BINDINGS[binding](input);
}
