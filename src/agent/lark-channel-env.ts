import { join } from 'node:path';

export const LARK_CHANNEL_ENV_KEYS = [
  'LARK_CHANNEL',
  'LARK_CHANNEL_PROFILE',
  'LARK_CHANNEL_HOME',
  'LARK_CHANNEL_CONFIG',
  'LARKSUITE_CLI_CONFIG_DIR',
] as const;

export interface LarkChannelEnvContext {
  profile?: string;
  rootDir?: string;
  configPath?: string;
  larkCliConfigDir?: string;
  larkCliSourceConfigFile?: string;
}

export function buildLarkChannelEnv(context?: LarkChannelEnvContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LARK_CHANNEL: '1',
    // Missing bindings must clear a parent process's frontend, not inherit it.
    LARK_CHANNEL_PROFILE: undefined,
    LARK_CHANNEL_HOME: undefined,
    LARK_CHANNEL_CONFIG: undefined,
    LARKSUITE_CLI_CONFIG_DIR: undefined,
  };
  const profile = nonEmpty(context?.profile);
  if (profile) env.LARK_CHANNEL_PROFILE = profile;

  const rootDir = nonEmpty(context?.rootDir);
  if (rootDir) env.LARK_CHANNEL_HOME = rootDir;

  const configPath =
    nonEmpty(context?.larkCliSourceConfigFile) ??
    (rootDir && profile ? join(rootDir, 'profiles', profile, 'lark-cli-source', 'config.json') : undefined);
  if (configPath) env.LARK_CHANNEL_CONFIG = configPath;

  const larkCliConfigDir = nonEmpty(context?.larkCliConfigDir);
  if (larkCliConfigDir) env.LARKSUITE_CLI_CONFIG_DIR = larkCliConfigDir;

  return env;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? value : undefined;
}
