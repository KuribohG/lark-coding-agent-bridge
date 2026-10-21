import type { AgentSystemPrompt } from '../../agent/system-prompt';
import type { AgentAdapter } from '../../agent/types';
import type { AppPaths } from '../../config/app-paths';
import type { AgentExecutionProfile } from '../../config/profile-schema';
import { createRuntimeAgent } from '../../runtime/agent-runtime';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../../agent/lark-channel-env';
import { buildBridgeSystemPrompt } from './system-prompt';

export interface LarkAgentHostContext {
  env: NodeJS.ProcessEnv;
  systemPrompt: AgentSystemPrompt;
}

export function larkAgentHostContext(
  appPaths: AppPaths,
  configPath = appPaths.configFile,
): LarkAgentHostContext {
  const larkChannel: LarkChannelEnvContext = {
    profile: appPaths.profile,
    rootDir: appPaths.rootDir,
    configPath,
    larkCliConfigDir: appPaths.larkCliConfigDir,
    larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
  };
  return {
    env: buildLarkChannelEnv(larkChannel),
    systemPrompt: buildBridgeSystemPrompt,
  };
}

export function createLarkRuntimeAgent(
  profile: AgentExecutionProfile,
  appPaths: AppPaths,
  configPath = appPaths.configFile,
): AgentAdapter {
  const host = larkAgentHostContext(appPaths, configPath);
  return createRuntimeAgent(profile, appPaths, host);
}
