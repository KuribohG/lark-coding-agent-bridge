import type { AgentAdapter } from '../agent/types';
import type { ProfileConfig, RunProfileConfig } from '../config/profile-schema';
import { loadRootConfig } from '../config/profile-store';
import { resolveAppPaths, type AppPaths } from '../config/app-paths';
import { supportsBackgroundProfile } from '../runtime/agent-capabilities';
import { backgroundModelSettings } from '../runtime/background-model';
import { checkRuntimeAgentAvailability } from '../runtime/agent-runtime';
import type { ExecutionProfile, ExecutionProvider } from '../runtime/execution-provider';
import { processAnalysis } from '../work-items/analysis';

/** Reads execution profiles from disk; channel start/stop does not own these profiles. */
export class ProfileExecutionProvider implements ExecutionProvider {
  private policies = new Map<string, { key: string; controller: AbortController }>();
  constructor(private configPath: string, private rootDir: string | undefined,
    private createAgent: (profile: ProfileConfig, paths: AppPaths) => AgentAdapter) {}

  async resolve(name: string): Promise<ExecutionProfile | undefined> {
    if (!name) return;
    let profile: ProfileConfig | undefined;
    try { profile = (await loadRootConfig(this.configPath))?.profiles[name]; }
    catch (error) { this.revoke(name); throw error; }
    if (!profile || !supportsBackgroundProfile(profile)) { this.revoke(name); return; }
    const key = JSON.stringify([profile.agentKind, profile.mode, profile.claude, profile.codex, profile.pi,
      profile.sandbox, profile.permissions, profile.permissionSource, profile.access, profile.workspaces, profile.larkCli]);
    let policy = this.policies.get(name);
    if (!policy || policy.key !== key) {
      this.revoke(name); policy = { key, controller: new AbortController() }; this.policies.set(name, policy);
    }
    const paths = resolveAppPaths({ rootDir: this.rootDir, profile: name });
    const agent = this.createAgent(profile, paths);
    const availability = await checkRuntimeAgentAvailability(agent);
    const config: RunProfileConfig = { agentKind: profile.agentKind, access: profile.access, workspaces: profile.workspaces,
      permissions: profile.permissions, codex: profile.codex, pi: profile.pi, attachments: profile.attachments, preferences: profile.preferences };
    return {
      config, available: availability.ok, signal: policy.controller.signal,
      error: availability.ok ? undefined : `执行器不可用：${availability.diagnostic.code}`,
      settings: (model, effort) => backgroundModelSettings(profile, paths.profileDir, model, effort),
      execute: (options, signal, onEvent) => processAnalysis(agent, options, AbortSignal.any([signal, policy.controller.signal]), onEvent),
    };
  }

  private revoke(name: string): void {
    this.policies.get(name)?.controller.abort(); this.policies.delete(name);
  }
}
