import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  nodeVersionAtLeast,
  PiSdkPathError,
  resolvePiAgentDir,
  resolvePiSdkPaths,
} from '../../../src/agent/pi-sdk/paths';

const dirs: string[] = [];

afterEach(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolvePiSdkPaths', () => {
  it('derives the SDK and Node runtime from the pi launcher wrapper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-sdk-paths-'));
    dirs.push(root);
    const runtime = join(root, 'pi-agent-runtime', '1.3.0', 'node_modules');
    const sdk = join(runtime, '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
    const node = join(runtime, 'node', 'bin', 'node');
    await mkdir(join(runtime, '@earendil-works', 'pi-coding-agent', 'dist', 'bundle'), { recursive: true });
    await mkdir(join(runtime, 'node', 'bin'), { recursive: true });
    await writeFile(sdk, '// fake cli\n');
    await writeFile(node, '// fake node\n');
    const launcher = join(root, 'pi');
    await writeFile(launcher, [
      '#!/bin/sh',
      `export PATH="${join(runtime, 'node', 'bin')}:$PATH"`,
      `exec "${node}" "${sdk}" "$@"`,
    ].join('\n'));
    await chmod(launcher, 0o755);

    const paths = resolvePiSdkPaths({ binaryPath: launcher });
    expect(paths.sdkPath).toBe(join(runtime, '@earendil-works', 'pi-coding-agent', 'dist', 'index.js'));
    expect(paths.nodePath).toBe(node);
    expect(paths.hostScript.endsWith('bin/pi-host.mjs')).toBe(true);
  });

  it('prefers explicit sdkPath/nodePath over launcher derivation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-sdk-paths-'));
    dirs.push(root);
    const paths = resolvePiSdkPaths({
      binaryPath: join(root, 'does-not-exist'),
      sdkPath: '/opt/pi/dist/index.js',
      nodePath: '/opt/node/bin/node',
    });
    expect(paths).toMatchObject({ sdkPath: '/opt/pi/dist/index.js', nodePath: '/opt/node/bin/node' });
  });

  it('fails with an actionable message when the SDK cannot be located', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-sdk-paths-'));
    dirs.push(root);
    expect(() => resolvePiSdkPaths({ binaryPath: join(root, 'missing-pi') }))
      .toThrow(PiSdkPathError);
  });
});

describe('resolvePiAgentDir', () => {
  it('uses config, then the environment, then ~/.pi/agent', () => {
    process.env.PI_CODING_AGENT_DIR = '/env/pi-agent';
    expect(resolvePiAgentDir({ agentDir: '/config/pi-agent' })).toBe('/config/pi-agent');
    expect(resolvePiAgentDir({})).toBe('/env/pi-agent');
    delete process.env.PI_CODING_AGENT_DIR;
    expect(resolvePiAgentDir({})).toMatch(/\.pi\/agent$/);
  });
});

describe('nodeVersionAtLeast', () => {
  it('compares semantic versions', () => {
    expect(nodeVersionAtLeast('v22.23.3', [22, 19, 0])).toBe(true);
    expect(nodeVersionAtLeast('v22.18.0', [22, 19, 0])).toBe(false);
    expect(nodeVersionAtLeast('v23.0.0', [22, 19, 0])).toBe(true);
    expect(nodeVersionAtLeast(undefined, [22, 19, 0])).toBe(false);
  });
});
