import type { FileLinkMapping } from './file-links';

type MessageReplyMode = 'card' | 'markdown' | 'text';
type CotMessagesMode = 'off' | 'brief' | 'detailed';

export interface LarkDisplayPreferences {
  messageReply?: MessageReplyMode;
  cotMessages?: CotMessagesMode;
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
  return {
    reply_mode: old?.messageReply ?? 'markdown',
    show_tools: old?.showToolCalls !== false,
    progress: old?.cotMessages ?? 'brief',
    message_debounce_ms: 600,
    ...(old?.fileLinks ? { file_links: old.fileLinks } : {}),
    ...config.channels?.lark,
  };
}
