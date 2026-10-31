import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../../src/agent/codex/adapter.js';
import { writeVersionExecutable } from '../../helpers/fake-executable.js';

const cleanups: Array<() => Promise<void>> = [];

describe('CodexAdapter prepareRun', () => {
  it.each([
    { options: { cwd: '' }, error: 'cwd' },
    { options: { forkSession: true }, error: 'parent' },
    { options: { sandbox: 'invalid' as never }, error: 'sandbox' },
    { options: { model: '--invalid' }, error: '模型' },
    { options: { reasoningEffort: 'invalid' as never }, error: '思考强度' },
  ])('rejects invalid run options before launching: $error', async ({ options, error }) => {
    const adapter = new CodexAdapter({ binary: 'missing-codex', profileStateDir: '.' });
    await expect(async () => (await adapter.prepareRun({ runId: 'invalid', cwd: '.', prompt: 'test', ...options })).start()).rejects.toThrow(new RegExp(error, 'i'));
  });

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('allows a run when the configured Codex binary returns a version without stored metadata', async () => {
    const binary = await writeCodexBinary('codex 1.2.3');
    const adapter = new CodexAdapter({
      binary,
      profileStateDir: join(tmpdir(), 'codex-profile'),
    });

    await expect(adapter.prepareRun({ runId: 'prepared', cwd: '.', prompt: 'test' })).resolves.toMatchObject({ start: expect.any(Function) });
  });

  it('reuses a successful availability check instead of spawning codex every run', async () => {
    const binary = await writeCodexBinary('codex 1.2.3');
    const adapter = new CodexAdapter({
      binary,
      profileStateDir: join(tmpdir(), 'codex-profile'),
    });

    await adapter.prepareRun({ runId: 'prepared', cwd: '.', prompt: 'test' });
    await rm(binary, { force: true });
    await expect(adapter.prepareRun({ runId: 'prepared', cwd: '.', prompt: 'test' })).resolves.toMatchObject({ start: expect.any(Function) });
  });

  it('does not cache a failed availability check', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-prepare-retry-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const binary = join(dir, 'codex');
    const adapter = new CodexAdapter({
      binary,
      profileStateDir: join(tmpdir(), 'codex-profile'),
    });

    await expect(adapter.prepareRun({ runId: 'prepared', cwd: '.', prompt: 'test' })).rejects.toMatchObject({ code: 'agent-binary-not-found' });
    await writeVersionExecutable(dir, 'codex', 'codex 1.2.3');
    await expect(adapter.prepareRun({ runId: 'prepared', cwd: '.', prompt: 'test' })).resolves.toMatchObject({ start: expect.any(Function) });
  });

  it('reports a preflight diagnostic when the configured Codex binary is missing', async () => {
    const adapter = new CodexAdapter({
      binary: join(tmpdir(), 'missing-codex'),
      profileStateDir: join(tmpdir(), 'codex-profile'),
    });

    await expect(adapter.prepareRun({ runId: 'prepared', cwd: '.', prompt: 'test' })).rejects.toMatchObject({
      code: 'agent-binary-not-found',
      diagnostic: {
        code: 'agent-binary-not-found',
        agentId: 'codex',
        agentName: 'Codex CLI',
      },
    });
  });
});

async function writeCodexBinary(version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-prepare-run-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return writeVersionExecutable(dir, 'codex', version);
}
