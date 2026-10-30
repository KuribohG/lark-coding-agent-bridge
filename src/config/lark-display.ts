import type { FileLinkMapping } from './file-links';

type MessageReplyMode = 'card' | 'markdown' | 'text';
type CotMessagesMode = 'off' | 'brief' | 'detailed';

export interface LarkDisplayPreferences {
  messageReply?: MessageReplyMode;
  messageReplyMigrated?: boolean;
  cotMessages?: CotMessagesMode | 'on' | 'simple';
  showToolCalls?: boolean;
  fileLinks?: FileLinkMapping[];
}

export interface LarkDisplayConfig {
  network?: import('./lark-network').LarkNetworkConfig;
  reply_mode: MessageReplyMode;
  show_tools: boolean;
  progress: CotMessagesMode;
  message_debounce_ms: number;
  file_links?: FileLinkMapping[];
}

export function larkDisplay(config: {
  channels?: { lark?: Partial<LarkDisplayConfig> };
  preferences?: LarkDisplayPreferences;
}): LarkDisplayConfig {
  const old = config.preferences;
  const reply = old?.messageReply;
  const progress = old?.cotMessages;
  return {
    reply_mode:
      reply === 'text' && old?.messageReplyMigrated !== true
        ? 'markdown'
        : reply ?? 'markdown',
    show_tools: old?.showToolCalls !== false,
    progress:
      progress === 'detailed' || progress === 'on'
        ? 'detailed'
        : progress === 'off'
          ? 'off'
          : 'brief',
    message_debounce_ms: 600,
    ...(old?.fileLinks ? { file_links: old.fileLinks } : {}),
    ...config.channels?.lark,
  };
}
