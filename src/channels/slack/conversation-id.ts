/** One Slack thread is one bridge conversation. */
export function slackConversationId(channel: string, threadTs: string): string {
  return `${channel}/${threadTs}`;
}

export function parseSlackConversationId(value: string): { channel: string; threadTs: string } | undefined {
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { channel: value.slice(0, separator), threadTs: value.slice(separator + 1) };
}
