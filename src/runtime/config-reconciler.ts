import {
  autoApplied,
  planProfileChanges,
  withChanges,
  type ConfigApplyReport,
  type FailedComponent,
  type SettingChange,
} from '../config/apply';
import type { AppConfig } from '../config/schema';
import { effectiveLarkCliIdentity, type AgentExecutionProfile, type LarkCliIdentityPreset, type ProfileConfig, type RootConfig } from '../config/profile-schema';
import { runtimeProfileConfig } from '../config/profile-store';
import type { ApplyClass } from '../config/settings';
import type { ModelServiceConfig } from '../model-service/config';
import { ModelProviderRegistry } from '../model-provider/provider';

/** Everything a running profile exposes to the reconciler; the supervisor wires the real objects. */
export interface ReconcileTarget {
  profile: string;
  /** The running view; `cfg` and `profileConfig` are replaced on commit. */
  state: { cfg: AppConfig; profileConfig: ProfileConfig };
  execution?: {
    reconfigure(profile: AgentExecutionProfile, providers: ModelProviderRegistry): Promise<void>;
    updateProfile(profile: AgentExecutionProfile): void;
  };
  modelServices: Record<string, ModelServiceConfig>;
  applyLarkCliIdentity(identity: LarkCliIdentityPreset): Promise<boolean>;
  reconcileMeeting?(): Promise<void>;
  onApplied?(): void;
  /** Bridge-wide pending items shown with every profile report. */
  rootPending?(): SettingChange[];
}

export interface ReconcileResult {
  report: ConfigApplyReport;
  cfg: AppConfig;
  profileConfig: ProfileConfig;
  modelServices: Record<string, ModelServiceConfig>;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Bring one running profile in line with an accepted config:
 *  - `live` leaves are copied into the running view;
 *  - component classes are rebuilt make-before-break, and a failed component
 *    keeps its old values (reported in `failed` and still pending);
 *  - `reconnect` / `restart` leaves stay as they are and are reported pending.
 */
export async function reconcileProfile(
  target: ReconcileTarget,
  root: RootConfig,
  meta: { trigger: string; revision?: string; at?: number },
): Promise<ReconcileResult> {
  const base = { profile: target.profile, trigger: meta.trigger, ...(meta.revision ? { revision: meta.revision } : {}), at: meta.at ?? Date.now() };
  let cfg = target.state.cfg;
  let profileConfig = target.state.profileConfig;
  let modelServices = target.modelServices;
  if (!root.profiles[target.profile]) {
    return { cfg, profileConfig, modelServices, report: { ...base, applied: [], components: [], failed: [], pending: [{
      path: ['profiles', target.profile], label: `profiles.${target.profile}`, apply: 'restart', running: '(running)', disk: undefined,
    }] } };
  }
  const nextCfg = runtimeProfileConfig(root, target.profile);
  const changes = planProfileChanges(cfg, nextCfg);
  const servicesChanged = JSON.stringify(modelServices ?? {}) !== JSON.stringify(root.modelServices ?? {});
  // Without an execution controller to rebuild, engine settings cannot apply in place.
  let auto = autoApplied(changes).filter(change => target.execution || change.apply !== 'execution');
  const failed: FailedComponent[] = [];
  const components = new Set<ApplyClass>();
  const fail = (component: ApplyClass, error: unknown, list: SettingChange[], extra: string[] = []) => {
    const deferred = (error as { deferred?: unknown })?.deferred === true;
    failed.push({ component, error: message(error), paths: [...list.map(c => c.label), ...extra], ...(deferred ? { deferred } : {}) });
    auto = auto.filter(change => !list.includes(change));
  };

  const execution = auto.filter(change => change.apply === 'execution');
  if ((execution.length || servicesChanged) && target.execution) {
    try {
      await target.execution.reconfigure(withChanges(profileConfig, auto), new ModelProviderRegistry(root.modelServices));
      modelServices = root.modelServices ?? {};
      components.add('execution');
    } catch (error) {
      fail('execution', error, execution, servicesChanged ? ['model_services'] : []);
    }
  }
  const larkCli = auto.filter(change => change.apply === 'lark-cli');
  if (larkCli.length) {
    const ok = await target.applyLarkCliIdentity(effectiveLarkCliIdentity(withChanges(profileConfig, larkCli)))
      .catch(() => false);
    if (ok) components.add('lark-cli');
    else fail('lark-cli', 'lark-cli 身份策略未生效', larkCli);
  }
  const commit = (next: ProfileConfig, nextAppConfig: AppConfig) => {
    profileConfig = target.state.profileConfig = next;
    cfg = target.state.cfg = nextAppConfig;
  };
  if (auto.length) commit(withChanges(profileConfig, auto), withChanges(cfg, auto));
  const meeting = auto.filter(change => change.apply === 'meeting');
  if (meeting.length) {
    try {
      await target.reconcileMeeting?.();
      components.add('meeting');
    } catch (error) {
      commit(withChanges(profileConfig, meeting, 'running'), withChanges(cfg, meeting, 'running'));
      fail('meeting', error, meeting);
      try { await target.reconcileMeeting?.(); } catch { /* back on the old setting; nothing else to undo */ }
    }
  }
  if (auto.some(change => change.apply === 'monitoring')) components.add('monitoring');
  if (auto.length) {
    // The controller keeps the final view, including rollbacks after its rebuild.
    target.execution?.updateProfile(profileConfig);
    target.onApplied?.();
  }

  const pending = [...planProfileChanges(cfg, nextCfg), ...(target.rootPending?.() ?? [])];
  return { cfg, profileConfig, modelServices, report: { ...base, applied: auto.map(change => change.label),
    components: [...components], pending, failed } };
}
