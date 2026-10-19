import { createConversationRuntime, type ConversationRuntimeOptions } from '../../runtime/conversation';

export const WEB_SYSTEM_PROMPT = 'You are a coding assistant in a browser conversation. Reply in this conversation. The host displays your progress and final answer. Do not assume a Feishu/Lark chat, bot identity, or messaging credentials are available.';
export type WebChatRuntimeOptions = Omit<ConversationRuntimeOptions, 'channelId'>;
export type { ConversationIdentity as WebConversationIdentity, ConversationInput as WebConversationInput } from '../../runtime/conversation';
export { ConversationRuntime as WebChatRuntime } from '../../runtime/conversation';

export function createWebChatRuntime(options: WebChatRuntimeOptions) {
  return createConversationRuntime({ ...options, channelId: 'web', systemPrompt: options.systemPrompt ?? WEB_SYSTEM_PROMPT });
}
