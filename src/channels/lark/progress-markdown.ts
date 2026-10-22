// The SDK rolls cards over at 30k; keep replacement snapshots safely below it.
const PROGRESS_STREAM_MAX_CHARS = 24_000;
const TRUNCATION_MARKER = '_（较早过程已折叠）_\n\n';

export interface ProgressMarkdownController {
  append?(chunk: string): Promise<void>;
  setContent(content: string): Promise<void>;
}

/**
 * Feed cumulative run snapshots into a Markdown streaming card without resetting
 * the SDK's rollover state to the start of the run on every update.
 */
export function createProgressMarkdownWriter(
  controller: ProgressMarkdownController,
  maxChars = PROGRESS_STREAM_MAX_CHARS,
): (content: string) => Promise<void> {
  let previous = '';

  return async (content) => {
    if (content === previous) return;

    const prior = previous;
    previous = content;
    if (prior && controller.append && content.startsWith(prior)) {
      await controller.append(content.slice(prior.length));
      return;
    }
    await controller.setContent(boundProgressMarkdown(content, maxChars));
  };
}

/**
 * Keep replacement snapshots below the CardKit element limit. The latest
 * progress is more useful than the beginning of a long transcript; already
 * rolled-over cards retain the older history.
 */
export function boundProgressMarkdown(content: string, maxChars = PROGRESS_STREAM_MAX_CHARS): string {
  if (content.length <= maxChars) return content;

  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  let tail = content.slice(-budget);
  const firstLineEnd = tail.indexOf('\n');
  if (firstLineEnd >= 0 && firstLineEnd < 200) tail = tail.slice(firstLineEnd + 1);
  return `${TRUNCATION_MARKER}${tail}`;
}
