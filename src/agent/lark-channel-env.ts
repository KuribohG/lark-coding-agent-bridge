import { join } from 'node:path';

export const LARK_CHANNEL_ENV_KEYS = [
  'LARK_CHANNEL',
  'LARK_CHANNEL_PROFILE',
  'LARK_CHANNEL_HOME',
  'LARK_CHANNEL_CONFIG',
  'LARKSUITE_CLI_CONFIG_DIR',
] as const;

/** Per-turn chat bindings: which conversation the agent may act on, when it must act on it. */
export const LARK_CHANNEL_CHAT_ENV_KEYS = [
  'LARK_CHANNEL_CHAT_ID',
  'LARK_CHANNEL_CHAT_TYPE',
  'LARK_CHANNEL_THREAD_ID',
] as const;

export interface LarkChannelEnvContext {
  profile?: string;
  rootDir?: string;
  configPath?: string;
  larkCliConfigDir?: string;
  larkCliSourceConfigFile?: string;
}

export interface LarkChatEnvContext {
  chatId?: string;
  chatType?: string;
  threadId?: string;
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

/**
 * The conversation of this turn. Kept out of the prompt (the agent reads it
 * only when it has to send something); absent keys mean the turn has no
 * conversation of that kind, e.g. a run without a thread.
 */
export function buildLarkChatEnv(context: LarkChatEnvContext = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const chatId = nonEmpty(context.chatId);
  if (chatId) env.LARK_CHANNEL_CHAT_ID = chatId;
  const chatType = nonEmpty(context.chatType);
  if (chatType) env.LARK_CHANNEL_CHAT_TYPE = chatType;
  const threadId = nonEmpty(context.threadId);
  if (threadId) env.LARK_CHANNEL_THREAD_ID = threadId;
  return env;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? value : undefined;
}
