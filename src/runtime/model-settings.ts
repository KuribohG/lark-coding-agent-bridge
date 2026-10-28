import { dirname, join } from 'node:path';
import type { MutableProfileState } from '../config/config-ops';
import { resolveAppPaths } from '../config/app-paths';
import { ScopePreferencesStore } from '../session/scope-preferences';
import { readModelEnvironment, resolveModelSettings, type ModelSettings } from '../agent/model-settings';
import type { AgentKind } from '../config/profile-schema';
import { profileForAgentKind } from './execution-controller';
import { loadRootConfig } from '../config/profile-store';
import {
  ModelProviderRegistry,
  type ModelProviderOption,
} from '../model-provider/provider';

const stores = new WeakMap<object, Promise<ScopePreferencesStore>>();

export function scopePreferences(state: MutableProfileState): Promise<ScopePreferencesStore> {
  let pending = stores.get(state);
  if (!pending) {
    const paths = resolveAppPaths({ rootDir: dirname(state.configPath), profile: state.profile });
    pending = (async () => {
      const store = new ScopePreferencesStore(join(paths.profileDir, 'scope-preferences.json'));
      await store.load();
      return store;
    })();
    stores.set(state, pending);
    pending.catch(() => stores.delete(state));
  }
  return pending;
}

export function modelEnvironment(
  state: MutableProfileState,
  agentKind: AgentKind = state.profileConfig.agentKind,
) {
  const paths = resolveAppPaths({ rootDir: dirname(state.configPath), profile: state.profile });
  return readModelEnvironment(profileForAgentKind(state.profileConfig, agentKind), paths.profileDir);
}

export async function modelProviderOptions(
  state: MutableProfileState,
  agentKind: AgentKind = state.profileConfig.agentKind,
): Promise<ModelProviderOption[]> {
  const root = await loadRootConfig(state.configPath);
  return new ModelProviderRegistry(root?.modelServices ?? {}).options(agentKind);
}

export async function resolveRunModelSettings(
  state: MutableProfileState,
  scope: string,
  patch?: Partial<ModelSettings>,
  agentKind: AgentKind = state.profileConfig.agentKind,
) {
  const [store, environment] = await Promise.all([scopePreferences(state), modelEnvironment(state, agentKind)]);
  const overrides = { ...store.get(agentKind, scope), ...patch };
  const profilePreferences = agentKind === state.profileConfig.agentKind
    ? state.profileConfig.preferences
    : { ...state.profileConfig.preferences, model: undefined, reasoningEffort: undefined };
  return resolveModelSettings(profilePreferences, overrides, environment);
}
