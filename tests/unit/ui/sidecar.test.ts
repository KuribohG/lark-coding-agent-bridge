import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { liveConsole } from '../../../src/ui/sidecar';

it('does not send the console token to non-local URLs and rejects stale process identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sidecar-'));
  const path = join(dir, 'ui.json');
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ hosted: true, pid: 999 })));
  try {
    await writeFile(path, JSON.stringify({ url: 'https://example.com:1234', port: 1234, pid: 123, token: 'private' }));
    expect(await liveConsole(path)).toBeUndefined(); expect(request).not.toHaveBeenCalled();
    await writeFile(path, JSON.stringify({ url: 'http://127.0.0.1:1234', port: 1234, pid: 123, token: 'private' }));
    expect(await liveConsole(path)).toBeUndefined(); expect(request).toHaveBeenCalledTimes(1);
  } finally {
    request.mockRestore();
  }
});
