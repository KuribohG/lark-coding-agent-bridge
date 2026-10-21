import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter } from '../../src/agent/pi/adapter';
import { buildBridgeSystemPrompt } from '../../src/channels/lark/system-prompt';
import type { AgentEvent } from '../../src/agent/types';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('PiAdapter process contract', () => {
  it('runs JSON mode, resumes a session and keeps prompt/system text out of argv', async () => {
    const harness = await createFakePi([
      { type: 'session', id: 'sess-resumed', cwd: '/repo' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'OK' } },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'OK' }],
          stopReason: 'stop',
          usage: { input: 2, output: 1, cacheRead: 0, cost: { total: 0 } },
        },
      },
      { type: 'agent_settled', aborted: false },
    ]);
    dirs.push(harness.dir);

    const adapter = new PiAdapter({ binary: harness.binary, systemPrompt: buildBridgeSystemPrompt });
    adapter.setBotIdentity({ openId: 'ou_pi_bot', name: 'Pi Bridge' });
    const run = adapter.run({
      runId: 'pi-resume',
      prompt: 'hello <bridge_context>',
      cwd: harness.dir,
      sessionId: 'sess-old',
      model: 'anthropic/claude-sonnet-4-6',
      reasoningEffort: 'high',
      sandbox: 'read-only',
    });

    expect(run.capabilities).toEqual({ finalAnswer: 'stream', input: 'unsupported' });
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-resumed', cwd: '/repo' },
      { type: 'text', delta: 'OK' },
      { type: 'usage', inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, costUsd: 0 },
      { type: 'done', sessionId: 'sess-resumed', terminationReason: 'normal' },
    ]);
    expect(await run.waitForExit(1000)).toBe(true);

    const record = await readRecord(harness.recordPath);
    expect(record.cwd).toBe(await realpath(harness.dir));
    expect(record.stdin).toBe('hello <bridge_context>');
    expect(record.argv.slice(0, 3)).toEqual(['--mode', 'json', '--append-system-prompt']);
    expect(record.argv).toContain('--session');
    expect(record.argv[record.argv.indexOf('--session') + 1]).toBe('sess-old');
    expect(record.argv).toContain('--model');
    expect(record.argv[record.argv.indexOf('--model') + 1]).toBe('anthropic/claude-sonnet-4-6');
    expect(record.argv[record.argv.indexOf('--thinking') + 1]).toBe('high');
    expect(record.argv[record.argv.indexOf('--tools') + 1]).toBe('read,grep,find,ls');
    expect(record.argv).toContain('--no-extensions');
    expect(record.argv).not.toContain('hello <bridge_context>');
    expect(record.systemPrompt).toContain('lark-channel-bridge 运行约定');
    expect(record.systemPrompt).toContain('ou_pi_bot');
    expect(record.env).toMatchObject({ PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' });
  });

  it('forks a parent session for side questions', async () => {
    const harness = await createFakePi([
      { type: 'session', id: 'sess-child' },
      { type: 'agent_settled', aborted: false },
    ]);
    dirs.push(harness.dir);
    const adapter = new PiAdapter({ binary: harness.binary });

    expect(await collect(adapter.run({
      runId: 'pi-fork',
      prompt: 'side question',
      cwd: harness.dir,
      sessionId: 'sess-parent',
      forkSession: true,
    }).events)).toContainEqual({
      type: 'done',
      sessionId: 'sess-child',
      terminationReason: 'normal',
    });
    const record = await readRecord(harness.recordPath);
    expect(record.argv).toContain('--fork');
    expect(record.argv[record.argv.indexOf('--fork') + 1]).toBe('sess-parent');
    expect(record.argv).not.toContain('--session');
  });

  it('rejects workspace mode instead of claiming filesystem isolation', () => {
    const adapter = new PiAdapter({ binary: 'pi' });
    expect(() => adapter.run({
      runId: 'pi-workspace',
      prompt: 'edit',
      cwd: '/tmp',
      sandbox: 'workspace-write',
    })).toThrow(/no portable workspace sandbox/i);
  });

  it('reports non-zero process exits as stream errors', async () => {
    const harness = await createFakePi(
      [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' } }],
      { exitCode: 42, stderr: 'provider down\n' },
    );
    dirs.push(harness.dir);
    const events = await collect(new PiAdapter({ binary: harness.binary }).run({
      runId: 'pi-fail',
      prompt: 'fail',
      cwd: harness.dir,
    }).events);

    expect(events).toEqual([
      { type: 'text', delta: 'partial' },
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('pi exited with code 42:'),
        terminationReason: 'failed',
        failureKind: 'runtime',
      }),
    ]);
    expect((events[1] as { message: string }).message).toContain('provider down');
  });

  it('lets Pi flush trailing output after the consumer stops at done', async () => {
    const harness = await createFakePi([
      { type: 'session', id: 'sess-trailing' },
      { type: 'agent_settled', aborted: false },
    ], { trailingBytes: 256 * 1024 });
    dirs.push(harness.dir);
    const run = new PiAdapter({ binary: harness.binary }).run({
      runId: 'pi-trailing', prompt: 'hello', cwd: harness.dir,
    });
    for await (const event of run.events) {
      if (event.type === 'done') break;
    }
    expect(await run.waitForExit(3000)).toBe(true);
    expect(await readFile(join(harness.dir, 'clean-exit'), 'utf8')).toBe('ok');
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

async function createFakePi(
  lines: unknown[],
  options: { exitCode?: number; stderr?: string; trailingBytes?: number } = {},
): Promise<{ dir: string; binary: string; recordPath: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-adapter-')));
  const binary = join(dir, 'pi');
  const recordPath = join(dir, 'record.json');
  await writeFile(binary, [
    '#!/usr/bin/env node',
    'import { readFileSync, writeFileSync } from "node:fs";',
    'const argv = process.argv.slice(2);',
    'const promptIndex = argv.indexOf("--append-system-prompt");',
    'let stdin = "";',
    'process.stdin.on("data", chunk => { stdin += chunk; });',
    'process.stdin.on("end", () => {',
    `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
    '    argv, stdin, cwd: process.cwd(),',
    '    systemPrompt: promptIndex >= 0 ? readFileSync(argv[promptIndex + 1], "utf8") : "",',
    '    env: { PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK, PI_TELEMETRY: process.env.PI_TELEMETRY },',
    '  }));',
    `  for (const line of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(line) + "\\n");`,
    options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
    options.trailingBytes ? [
      '  setTimeout(() => {',
      `    process.stdout.write("x".repeat(${options.trailingBytes}) + "\\n", error => {`,
      '      if (error) process.exit(2);',
      `      writeFileSync(${JSON.stringify(join(dir, 'clean-exit'))}, "ok");`,
      '      process.exit(0);',
      '    });',
      '  }, 100);',
    ].join('\n') : `  process.exit(${options.exitCode ?? 0});`,
    '});',
  ].filter(Boolean).join('\n'), 'utf8');
  await chmod(binary, 0o755);
  return { dir, binary, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  stdin: string;
  cwd: string;
  systemPrompt: string;
  env: { PI_SKIP_VERSION_CHECK?: string; PI_TELEMETRY?: string };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    stdin: string;
    cwd: string;
    systemPrompt: string;
    env: { PI_SKIP_VERSION_CHECK?: string; PI_TELEMETRY?: string };
  };
}
