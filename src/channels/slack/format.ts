const DEFAULT_SINGLE_MESSAGE_LIMIT = 11_000;
const DEFAULT_CHUNK_LIMIT = 3_500;
const TRUNCATION_MARKER = '_Earlier progress was folded._\n\n';

/**
 * Convert the Markdown emitted by agent backends into Slack mrkdwn. Fenced
 * code and inline code are left intact; Slack already understands those.
 */
export function toSlackMrkdwn(input: string): string {
  return input
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
}

export function boundSlackText(
  input: string,
  maxChars = DEFAULT_SINGLE_MESSAGE_LIMIT,
): string {
  if (input.length <= maxChars) return input;
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  let tail = input.slice(-budget);
  const firstBreak = tail.indexOf('\n');
  if (firstBreak >= 0 && firstBreak < 240) tail = tail.slice(firstBreak + 1);
  return `${TRUNCATION_MARKER}${tail}`;
}

/** Split a final answer into thread-safe Slack messages without dropping text. */
export function splitSlackText(
  input: string,
  maxChars = DEFAULT_CHUNK_LIMIT,
): string[] {
  if (input.length <= maxChars) return [input];
  const chunks: string[] = [];
  let remaining = input;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n', maxChars);
    if (splitAt < Math.floor(maxChars * 0.55)) splitAt = remaining.lastIndexOf(' ', maxChars);
    if (splitAt <= 0) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

export function normalizeSlackText(text: string, botUserId: string): string {
  const withoutBotMention = text.replace(
    new RegExp(`<@${escapeRegExp(botUserId)}(?:\\|[^>]+)?>`, 'g'),
    ' ',
  );
  return decodeSlackEntities(withoutBotMention)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeSlackEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
