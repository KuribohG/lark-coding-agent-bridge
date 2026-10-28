import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import { buildBridgeSystemPrompt } from '../../../src/channels/lark/system-prompt';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  spawnMock.spawnProcess.mockReset();
});

describe('channel-neutral adapter defaults', () => {
  it('does not add Lark instructions to Claude without a configured channel', () => {
    const child = fakeChild(); spawnMock.spawnProcess.mockReturnValue(child);
    new ClaudeAdapter().run({ runId: 'r', prompt: 'hello', cwd: '/tmp' });
    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    expect(readFileSync(args[args.indexOf('--append-system-prompt-file') + 1]!, 'utf8')).toBe('');
  });

  it('sets the configured Claude directory on the child environment', () => {
    const child = fakeChild(); spawnMock.spawnProcess.mockReturnValue(child);
    new ClaudeAdapter({ configDir: '/private/claude-config' })
      .run({ runId: 'r', prompt: 'hello', cwd: '/tmp' });
    const options = spawnMock.spawnProcess.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe('/private/claude-config');
  });
});

describe('ClaudeAdapter system prompt wiring', () => {
  it('appends the identity-aware bridge system prompt via a temp file after setBotIdentity', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter({ systemPrompt: buildBridgeSystemPrompt });
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    // The prompt goes via stdin, never argv (cmd.exe would mangle it on Windows).
    expect(JSON.parse(child.stdin.read().toString()).message.content).toBe('hi');
    expect(child.stdin.writableEnded).toBe(false);
    expect(systemPromptFileContent()).toBe(
      buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter({ systemPrompt: buildBridgeSystemPrompt });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    expect(JSON.parse(child.stdin.read().toString()).message.content).toBe('hi');
    expect(child.stdin.writableEnded).toBe(false);
    expect(systemPromptFileContent()).toBe(buildBridgeSystemPrompt(undefined));
  });

  it('uses host instructions for a non-Lark run', () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter({ systemPrompt: buildBridgeSystemPrompt });
    adapter.setBotIdentity({ openId: 'ou_bot_self' });
    adapter.run({ runId: 'web', prompt: 'hello', cwd: '/tmp', systemPrompt: 'Web instructions' });
    expect(systemPromptFileContent()).toBe('Web instructions');
  });

  function systemPromptFileContent(): string {
    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    const flagIndex = args.indexOf('--append-system-prompt-file');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args).not.toContain('--append-system-prompt');
    return readFileSync(args[flagIndex + 1] as string, 'utf8');
  }
});
