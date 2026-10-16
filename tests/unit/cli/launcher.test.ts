import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { liveConsole, parseLauncherArgs } from '../../../src/cli/launcher';
import { normalizeInbox } from '../../../src/inbox/config';

it('keeps legacy positional commands and supports named profiles in either order', () => {
  expect(parseLauncherArgs([])).toMatchObject({ action: 'start', profile: undefined });
  expect(parseLauncherArgs(['codex', 'fg'])).toMatchObject({ action: 'fg', profile: 'codex' });
  expect(parseLauncherArgs(['status', 'claude'])).toMatchObject({ action: 'status', profile: 'claude' });
  expect(parseLauncherArgs(['--profile', '工作', 'start'])).toMatchObject({ action: 'start', profile: '工作' });
  for (const args of [['--profile'], ['--profile', '../other'], ['stop', 'start'], ['codex', 'claude'], ['--unknown']]) expect(() => parseLauncherArgs(args)).toThrow();
});

it('does not send the console token to non-local URLs and rejects stale process identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launcher-'));
  const path = join(dir, 'ui.json');
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ hosted: true, pid: 999 })));
  try {
    await writeFile(path, JSON.stringify({ url: 'https://example.com:1234', port: 1234, pid: 123, token: 'private' }));
    expect(await liveConsole(path)).toBeUndefined(); expect(request).not.toHaveBeenCalled();
    await writeFile(path, JSON.stringify({ url: 'http://127.0.0.1:1234', port: 1234, pid: 123, token: 'private' }));
    expect(await liveConsole(path)).toBeUndefined(); expect(request).toHaveBeenCalledTimes(1);
  } finally { request.mockRestore(); }
});

it('uses the provider default for new installs and preserves legacy Flash routing', () => {
  expect(normalizeInbox(undefined)).toMatchObject({ enabled: false, analysisModel: '' });
  expect(normalizeInbox({ enabled: false }).analysisModel).toBeUndefined();
  expect(normalizeInbox({ analysisModel: '' }).analysisModel).toBe('');
  expect(normalizeInbox({ analysisModel: 'custom/model' }).analysisModel).toBe('custom/model');
});
