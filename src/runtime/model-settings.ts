import { dirname, join } from 'node:path';
import type { MutableProfileState } from '../config/config-ops';
import { resolveAppPaths } from '../config/app-paths';
import { ScopePreferencesStore } from '../session/scope-preferences';
import { readModelEnvironment, resolveModelSettings, type ModelSettings } from '../agent/model-settings';

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

export function modelEnvironment(state: MutableProfileState) {
  const paths = resolveAppPaths({ rootDir: dirname(state.configPath), profile: state.profile });
  return readModelEnvironment(state.profileConfig, paths.profileDir);
}

export async function resolveRunModelSettings(state: MutableProfileState, scope: string, patch?: Partial<ModelSettings>) {
  const [store, environment] = await Promise.all([scopePreferences(state), modelEnvironment(state)]);
  const overrides = { ...store.get(state.profileConfig.agentKind, scope), ...patch };
  return resolveModelSettings(state.profileConfig.preferences, overrides, environment);
}
