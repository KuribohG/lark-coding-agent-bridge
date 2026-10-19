import type { AppPreferences, CotMessagesMode, MessageReplyMode } from '../../config/schema';
import type { FileLinkMapping } from '../../config/file-links';

export interface LarkDisplayConfig {
  reply_mode: MessageReplyMode;
  show_tools: boolean;
  progress: CotMessagesMode;
  file_links?: FileLinkMapping[];
}

export function larkDisplay(config: { channels?: { lark?: Partial<LarkDisplayConfig> }; preferences?: AppPreferences }): LarkDisplayConfig {
  const old = config.preferences;
  const reply = old?.messageReply;
  const progress = old?.cotMessages;
  return {
    reply_mode: reply === 'text' && old?.messageReplyMigrated !== true ? 'markdown' : reply ?? 'markdown',
    show_tools: old?.showToolCalls !== false,
    progress: progress === 'detailed' || progress === 'on' ? 'detailed'
      : progress === 'off' ? 'off' : 'brief',
    ...(old?.fileLinks ? { file_links: old.fileLinks } : {}),
    ...config.channels?.lark,
  };
}
