import { describe, expect, it } from 'vitest';
import {
  boundSlackText,
  normalizeSlackText,
  splitSlackText,
  toSlackMrkdwn,
} from '../../../src/channels/slack/format';

describe('Slack formatting', () => {
  it('converts agent Markdown to Slack mrkdwn', () => {
    expect(toSlackMrkdwn('## Result\n\n**done** [report](https://example.com)')).toBe(
      '*Result*\n\n*done* <https://example.com|report>',
    );
  });

  it('strips only the bridge mention and preserves line structure', () => {
    expect(normalizeSlackText('<@UBOT> inspect\n\nthis  file &amp; test', 'UBOT')).toBe(
      'inspect\n\nthis file & test',
    );
  });

  it('bounds progress by its tail and splits final answers without dropping text', () => {
    const progress = boundSlackText(`start\n${'x'.repeat(200)}`, 120);
    expect(progress).toContain('Earlier progress');
    expect(progress.endsWith('x'.repeat(20))).toBe(true);

    const source = Array.from({ length: 30 }, (_, index) => `line ${index} ${'y'.repeat(30)}`).join('\n');
    const chunks = splitSlackText(source, 180);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('\n').replace(/\s+/g, '')).toBe(source.replace(/\s+/g, ''));
  });
});
