import { join } from 'node:path';
import type { ModelServiceConfig } from '../model-service/config';
import { ModelProviderRegistry } from '../model-provider/provider';
import { SCOPE_AGENTS_FILE, ScopeExecutionStore } from '../session/scope-execution';
import { checkRuntimeAgentAvailability } from './agent-runtime';
import {
  ProfileExecutionController,
  type ProfileExecutionControllerOptions,
} from './execution-controller';

/** What a channel host supplies; everything else about engine assembly is fixed here. */
export interface ExecutionHostOptions
  extends Pick<ProfileExecutionControllerOptions, 'profileConfig' | 'appPaths' | 'systemPrompt' | 'env'> {
  modelServices?: Record<string, ModelServiceConfig>;
}

export interface OpenedExecution {
  execution: ProfileExecutionController;
  scopeExecution: ScopeExecutionStore;
}

/**
 * Build the execution controller of a channel host. Every front end goes
 * through here, so the state file, model services and availability check
 * cannot drift apart between them.
 */
export async function openExecution(
  options: ExecutionHostOptions,
  { preflight = true }: { preflight?: boolean } = {},
): Promise<OpenedExecution> {
  const scopeExecution = new ScopeExecutionStore(join(options.appPaths.profileDir, SCOPE_AGENTS_FILE));
  await scopeExecution.load();
  const execution = rebuildExecution(options, scopeExecution);
  if (preflight) {
    const availability = await checkRuntimeAgentAvailability(execution.defaultAgent());
    if (!availability.ok) throw availability.error;
  }
  return { execution, scopeExecution };
}

/** A new controller for changed settings that keeps the conversations' engine choices. */
export function rebuildExecution(
  options: ExecutionHostOptions,
  scopeExecution: ScopeExecutionStore,
): ProfileExecutionController {
  const { modelServices, ...controller } = options;
  return new ProfileExecutionController({
    ...controller,
    scopeExecution,
    modelProviders: new ModelProviderRegistry(modelServices),
  });
}
