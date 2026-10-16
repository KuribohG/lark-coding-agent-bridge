import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { useBundledLarkCli } from '../../../src/platform/bundled-tools';

it('discovers hoisted tool binaries from the package entry without changing bridge binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundled-tools-'));
  const bin = join(root, 'node_modules', '.bin'); await mkdir(bin, { recursive: true });
  await writeFile(join(bin, process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli'), 'fixture');
  const env = { PATH: 'original', LARK_CHANNEL: '1', LARK_CHANNEL_HOME: '/binding', LARK_CHANNEL_PROFILE: 'my-profile' };
  const entry = pathToFileURL(join(root, 'node_modules', 'lark-channel-bridge', 'dist', 'cli.js')).href;
  useBundledLarkCli(entry, env); useBundledLarkCli(entry, env);
  expect(env).toEqual({ PATH: `${bin}${delimiter}original`, LARK_CHANNEL: '1', LARK_CHANNEL_HOME: '/binding', LARK_CHANNEL_PROFILE: 'my-profile' });
});
