import { describe, expect, it, vi } from 'vitest';
import {
  boundProgressMarkdown,
  createProgressMarkdownWriter,
} from '../../../../src/channels/lark/progress-markdown.js';

describe('progress Markdown streaming', () => {
  it('appends cumulative snapshots instead of replacing the full transcript', async () => {
    const append = vi.fn(async (_chunk: string) => {});
    const setContent = vi.fn(async (_content: string) => {});
    const write = createProgressMarkdownWriter({ append, setContent });

    await write('step 1');
    await write('step 1\nstep 2');
    await write('step 1\nstep 2\nstep 3');

    expect(setContent).toHaveBeenCalledOnce();
    expect(setContent).toHaveBeenCalledWith('step 1');
    expect(append.mock.calls).toEqual([['\nstep 2'], ['\nstep 3']]);
  });

  it('bounds non-prefix snapshots and retains the latest progress', async () => {
    const setContent = vi.fn(async (_content: string) => {});
    const write = createProgressMarkdownWriter({ setContent }, 120);
    const oldProgress = `OLD_START\n${'old line\n'.repeat(40)}`;
    const latestProgress = `${oldProgress}NEW_TAIL`;

    await write(oldProgress);
    await write(latestProgress);

    const bounded = setContent.mock.calls.at(-1)![0];
    expect(bounded.length).toBeLessThanOrEqual(120);
    expect(bounded).toContain('较早过程已折叠');
    expect(bounded).toContain('NEW_TAIL');
    expect(bounded).not.toContain('OLD_START');
  });

  it('never resets the SDK to a repeated oversized snapshot', async () => {
    const setContent = vi.fn(async (_content: string) => {});
    const write = createProgressMarkdownWriter({ setContent }, 512);

    for (let index = 0; index < 25; index += 1) {
      await write(`snapshot ${index}\n${'x'.repeat(900)}`);
    }

    expect(setContent).toHaveBeenCalledTimes(25);
    for (const [content] of setContent.mock.calls) expect(content.length).toBeLessThanOrEqual(512);
  });

  it('leaves content below the cap unchanged', () => {
    expect(boundProgressMarkdown('short progress', 100)).toBe('short progress');
  });
});
