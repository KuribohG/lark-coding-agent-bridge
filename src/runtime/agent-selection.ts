import type { AgentAdapter } from '../agent/types';
import type { MutableProfileState } from '../config/config-ops';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import { loadRootConfig, runtimeProfileConfig, saveRootConfig, withConfigFileLock } from '../config/profile-store';
import { preserveLegacyRunDefaults } from './run-defaults';
import type { ActiveRuns } from '../bot/active-runs';

export function pauseAgentSwitch(state: { agentSwitching?: boolean }, runs: ActiveRuns, otherWork: () => boolean): () => void {
  if (state.agentSwitching || runs.newRunsPaused()) throw new Error('正在重连或切换，请稍后重试。');
  if (runs.hasWork() || otherWork()) throw new Error('仍有运行中、排队中的任务或会议，请完成后再切换。');
  state.agentSwitching = true;
  const resume = runs.pauseNewRuns('agent-switch-in-progress');
  return () => { state.agentSwitching = false; resume(); };
}

export interface AgentSelectionDeps {
  pause(): () => void;
  prepare(profile: ProfileConfig): Promise<AgentAdapter>;
  metadata(kind: AgentKind): Promise<void>;
  activate(agent: AgentAdapter): void;
}

/** Save only engine-specific fields; unrelated settings remain under the same file lock. */
export async function selectAgent(
  state: MutableProfileState,
  next: AgentKind,
  expected: AgentKind,
  deps: AgentSelectionDeps,
): Promise<void> {
  if (next !== 'claude' && next !== 'codex') throw new Error('请选择 claude 或 codex。');
  if (state.profileConfig.agentKind !== expected) throw new Error('执行引擎已改变，请重新打开 /agent。');
  if (next === expected) return;
  const resume = deps.pause();
  try {
    await withConfigFileLock(state.configPath, async () => {
      const root = await loadRootConfig(state.configPath);
      const current = root?.profiles[state.profile];
      if (!root || !current) throw new Error('找不到当前 bot 配置。');
      if (current.agentKind !== expected) throw new Error('执行引擎已改变，请重新打开 /agent。');
      const agentModels = {
        ...current.agentModels,
        [expected]: { model: current.preferences.model, reasoningEffort: current.preferences.reasoningEffort },
      };
      const selected = agentModels[next];
      const candidate: ProfileConfig = {
        ...current, agentKind: next, agentModels,
        preferences: { ...current.preferences, model: selected?.model, reasoningEffort: selected?.reasoningEffort },
        ...(next === 'codex' && !current.codex ? { codex: {
          binaryPath: process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex',
          inheritCodexHome: true, ignoreUserConfig: false, ignoreRules: true,
        } } : {}),
      };
      const agent = await deps.prepare(candidate);
      await preserveLegacyRunDefaults({ ...state, profileConfig: current });
      root.profiles[state.profile] = candidate;
      try {
        await deps.metadata(next);
        await saveRootConfig(root, state.configPath);
      } catch (err) {
        await deps.metadata(expected);
        throw err;
      }
      state.profileConfig = candidate;
      state.cfg = runtimeProfileConfig(root, state.profile);
      deps.activate(agent);
    });
  } finally {
    resume();
  }
}
