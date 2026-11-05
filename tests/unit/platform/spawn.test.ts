import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ pid: 1 })),
  sync: vi.fn(() => ({ status: 0 })),
}));

vi.mock('cross-spawn', () => ({ default: Object.assign(mocks.spawn, { sync: mocks.sync }) }));

import { spawnProcess, spawnProcessSync } from '../../../src/platform/spawn';

beforeEach(() => {
  mocks.spawn.mockClear();
  mocks.sync.mockClear();
});

it('hides console windows by default so tray-launched children stay invisible', () => {
  spawnProcess('lark-cli', ['--version'], { stdio: 'ignore' });
  expect(mocks.spawn).toHaveBeenCalledWith('lark-cli', ['--version'], { windowsHide: true, stdio: 'ignore' });

  spawnProcessSync('lark-cli', ['--version']);
  expect(mocks.sync).toHaveBeenCalledWith('lark-cli', ['--version'], { windowsHide: true });
});

it('lets callers opt out of window hiding', () => {
  spawnProcess('cmd', ['/c', 'start', '', 'https://example'], { windowsHide: false });
  expect(mocks.spawn).toHaveBeenCalledWith('cmd', ['/c', 'start', '', 'https://example'], { windowsHide: false });
});
