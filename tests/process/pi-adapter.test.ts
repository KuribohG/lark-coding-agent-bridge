import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter } from '../../src/agent/pi/adapter';
import { buildBridgeSystemPrompt } from '../../src/channels/lark/system-prompt';
import type { AgentEvent } from '../../src/agent/types';
import { ModelProviderRegistry } from '../../src/model-provider/provider';
import { setModelGateTarget } from '../../src/model-gate/location';

const dirs: string[] = [];

afterEach(async () => {
  delete process.env.PI_PROVIDER_TEST_KEY;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
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
    const run = (await adapter.prepareRun({
      runId: 'pi-resume',
      prompt: 'hello <bridge_context>',
      cwd: harness.dir,
      sessionId: 'sess-old',
      model: 'anthropic/claude-sonnet-4-6',
      reasoningEffort: 'high',
      sandbox: 'read-only',
    })).start();

    expect(run.capabilities).toEqual({ finalAnswer: 'separate-event', input: 'unsupported' });
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-resumed', cwd: '/repo' },
      { type: 'text', delta: 'OK' },
      { type: 'usage', inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, costUsd: 0 },
      { type: 'final_text', content: 'OK' },
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

    expect(await collect((await adapter.prepareRun({
      runId: 'pi-fork',
      prompt: 'side question',
      cwd: harness.dir,
      sessionId: 'sess-parent',
      forkSession: true,
    })).start().events)).toContainEqual({
      type: 'done',
      sessionId: 'sess-child',
      terminationReason: 'normal',
    });
    const record = await readRecord(harness.recordPath);
    expect(record.argv).toContain('--fork');
    expect(record.argv[record.argv.indexOf('--fork') + 1]).toBe('sess-parent');
    expect(record.argv).not.toContain('--session');
  });

  it('loads a provider extension and keeps its API key out of argv and disk', async () => {
    process.env.PI_PROVIDER_TEST_KEY = 'private-provider-key';
    const harness = await createFakePi([
      { type: 'session', id: 'sess-provider' },
      { type: 'agent_settled', aborted: false },
    ]);
    dirs.push(harness.dir);
    const provider = await new ModelProviderRegistry({
      deepseek: {
        protocol: 'responses',
        baseUrl: 'https://gateway.example/v1',
        model: 'deepseek-flash',
        apiKey: { source: 'env', id: 'PI_PROVIDER_TEST_KEY' },
      },
    }).resolve('pi', 'deepseek/deepseek-flash');
    const adapter = new PiAdapter({ binary: harness.binary, profileStateDir: harness.dir });
    await collect((await adapter.prepareRun({
      runId: 'pi-provider',
      prompt: 'hello',
      cwd: harness.dir,
      model: provider!.model,
      modelProvider: provider,
    })).start().events);

    const record = await readRecord(harness.recordPath);
    const extensionIndex = record.argv.indexOf('--extension');
    expect(extensionIndex).toBeGreaterThanOrEqual(0);
    const extension = await readFile(record.argv[extensionIndex + 1]!, 'utf8');
    expect(extension).toContain('registerProvider');
    expect(extension).toContain('https://gateway.example/v1');
    expect(extension).not.toContain('private-provider-key');
    expect(record.providerEnv).toContainEqual(['LARK_MODEL_PROVIDER_KEY_73395B78866F', 'private-provider-key']);
  });

  it('sets the configured Pi agent directory on the child environment', async () => {
    const harness = await createFakePi([
      { type: 'session', id: 'sess-agent-dir' },
      { type: 'agent_settled', aborted: false },
    ]);
    dirs.push(harness.dir);
    await collect((await new PiAdapter({
      binary: harness.binary,
      agentDir: '/private/pi-agent',
    }).prepareRun({
      runId: 'pi-agent-dir',
      prompt: 'hello',
      cwd: harness.dir,
    })).start().events);

    expect((await readRecord(harness.recordPath)).env.PI_CODING_AGENT_DIR).toBe('/private/pi-agent');
  });

  it('rejects workspace mode instead of claiming filesystem isolation', async () => {
    const adapter = new PiAdapter({ binary: 'pi' });
    await expect(async () => (await adapter.prepareRun({
      runId: 'pi-workspace',
      prompt: 'edit',
      cwd: '/tmp',
      sandbox: 'workspace-write',
    })).start()).rejects.toThrow(/no portable workspace sandbox/i);
  });

  it('reports non-zero process exits as stream errors', async () => {
    const harness = await createFakePi(
      [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' } }],
      { exitCode: 42, stderr: 'provider down\n' },
    );
    dirs.push(harness.dir);
    const events = await collect((await new PiAdapter({ binary: harness.binary }).prepareRun({
      runId: 'pi-fail',
      prompt: 'fail',
      cwd: harness.dir,
    })).start().events);

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
    const run = (await new PiAdapter({ binary: harness.binary }).prepareRun({
      runId: 'pi-trailing', prompt: 'hello', cwd: harness.dir,
    })).start();
    for await (const event of run.events) {
      if (event.type === 'done') break;
    }
    expect(await run.waitForExit(3000)).toBe(true);
    expect(await readFile(join(harness.dir, 'clean-exit'), 'utf8')).toBe('ok');
  });
});

describe('PiAdapter model gate wiring', () => {
  afterEach(() => setModelGateTarget(undefined));

  it('loads the gate extension and passes the socket when the bridge runs one', async () => {
    const harness = await createFakePi([{ type: 'system', id: 'sess-gate', cwd: '/repo' }, { type: 'agent_settled', aborted: false }]);
    dirs.push(harness.dir);
    setModelGateTarget({ socketPath: '/tmp/model-gate.sock' });

    const run = (await new PiAdapter({ binary: harness.binary }).prepareRun({
      runId: 'pi-gate', prompt: 'hello', cwd: harness.dir,
    })).start();
    for await (const event of run.events) {
      if (event.type === 'done') break;
    }
    await run.waitForExit(2000);

    const record = await readRecord(harness.recordPath);
    const extensionIndex = record.argv.indexOf('--extension');
    expect(extensionIndex).toBeGreaterThanOrEqual(0);
    expect(record.argv[extensionIndex + 1]).toMatch(/pi-gate-extension/);
    expect(record.env.LARK_MODEL_GATE_SOCKET).toBe('/tmp/model-gate.sock');
    // No deadline: an interactive run, first in the queue.
    expect(record.env.LARK_MODEL_GATE_PRIORITY).toBe('0');
  });

  it('queues a workflow worker behind interactive runs', async () => {
    const harness = await createFakePi([{ type: 'system', id: 'sess-gate', cwd: '/repo' }, { type: 'agent_settled', aborted: false }]);
    dirs.push(harness.dir);
    setModelGateTarget({ socketPath: '/tmp/model-gate.sock' });

    const run = (await new PiAdapter({ binary: harness.binary }).prepareRun({
      runId: 'pi-gate-worker', prompt: 'hello', cwd: harness.dir, deadlineAt: Date.now() + 60_000,
    })).start();
    for await (const event of run.events) {
      if (event.type === 'done') break;
    }
    await run.waitForExit(2000);

    const record = await readRecord(harness.recordPath);
    expect(record.env.LARK_MODEL_GATE_PRIORITY).toBe('1');
  });

  it('leaves argv alone when no gate is running', async () => {
    const harness = await createFakePi([{ type: 'system', id: 'sess-gate', cwd: '/repo' }, { type: 'agent_settled', aborted: false }]);
    dirs.push(harness.dir);
    setModelGateTarget(undefined);

    const run = (await new PiAdapter({ binary: harness.binary }).prepareRun({
      runId: 'pi-no-gate', prompt: 'hello', cwd: harness.dir,
    })).start();
    for await (const event of run.events) {
      if (event.type === 'done') break;
    }
    await run.waitForExit(2000);

    const record = await readRecord(harness.recordPath);
    expect(record.argv.some(arg => /pi-gate-extension/.test(arg))).toBe(false);
    expect(record.env.LARK_MODEL_GATE_SOCKET).toBeUndefined();
  });
});

describe('PiAdapter shell time limits', () => {
  async function record(adapter: (binary: string) => PiAdapter, options: Partial<Parameters<PiAdapter['prepareRun']>[0]> = {}) {
    const harness = await createFakePi([{ type: 'system', id: 'sess-limits', cwd: '/repo' }, { type: 'agent_settled', aborted: false }]);
    dirs.push(harness.dir);
    const run = (await adapter(harness.binary).prepareRun({ runId: 'pi-limits', prompt: 'hello', cwd: harness.dir, ...options })).start();
    for await (const event of run.events) {
      if (event.type === 'done') break;
    }
    await run.waitForExit(2000);
    return readRecord(harness.recordPath);
  }

  it('bounds the shell tool by default, for a workflow worker too, and tells the model', async () => {
    const run = await record(binary => new PiAdapter({ binary }), { deadlineAt: Date.now() + 60_000, systemPrompt: 'base prompt' });
    // `--no-extensions` keeps discovered extensions out of a worker; the explicit path still loads.
    expect(run.argv).toContain('--no-extensions');
    expect(run.argv[run.argv.indexOf('--extension') + 1]).toMatch(/bash-timeout/);
    expect(run.env.LARK_PI_BASH_DEFAULT_TIMEOUT).toBe('600');
    expect(run.env.LARK_PI_BASH_MAX_TIMEOUT).toBe('14400');
    expect(run.systemPrompt.startsWith('base prompt\n\n')).toBe(true);
    expect(run.systemPrompt).toContain('stopped after 600 seconds');
  });

  it('uses the limits of the profile', async () => {
    const run = await record(binary => new PiAdapter({ binary, bashTimeouts: { defaultSeconds: 120 } }));
    expect(run.env.LARK_PI_BASH_DEFAULT_TIMEOUT).toBe('120');
    expect(run.env.LARK_PI_BASH_MAX_TIMEOUT).toBeUndefined();
    expect(run.systemPrompt).toContain('stopped after 120 seconds');
  });

  it('leaves Pi as it is when both limits are off or the run has no shell', async () => {
    const off = await record(binary => new PiAdapter({ binary, bashTimeouts: {} }), { systemPrompt: 'base prompt' });
    expect(off.argv).not.toContain('--extension');
    expect(off.env.LARK_PI_BASH_DEFAULT_TIMEOUT).toBeUndefined();
    expect(off.systemPrompt).toBe('base prompt');
    const readOnly = await record(binary => new PiAdapter({ binary }), { sandbox: 'read-only', systemPrompt: 'base prompt' });
    expect(readOnly.argv).not.toContain('--extension');
    expect(readOnly.systemPrompt).toBe('base prompt');
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
    'if (argv.includes("--version")) { console.log("pi 999.0.0"); process.exit(0); }',
    'const promptIndex = argv.indexOf("--append-system-prompt");',
    'let stdin = "";',
    'process.stdin.on("data", chunk => { stdin += chunk; });',
    'process.stdin.on("end", () => {',
    `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
    '    argv, stdin, cwd: process.cwd(),',
    '    systemPrompt: promptIndex >= 0 ? readFileSync(argv[promptIndex + 1], "utf8") : "",',
    '    env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK, PI_TELEMETRY: process.env.PI_TELEMETRY, LARK_MODEL_GATE_SOCKET: process.env.LARK_MODEL_GATE_SOCKET, LARK_MODEL_GATE_PRIORITY: process.env.LARK_MODEL_GATE_PRIORITY, LARK_PI_BASH_DEFAULT_TIMEOUT: process.env.LARK_PI_BASH_DEFAULT_TIMEOUT, LARK_PI_BASH_MAX_TIMEOUT: process.env.LARK_PI_BASH_MAX_TIMEOUT },',
    '    providerEnv: Object.entries(process.env).filter(([key]) => key.startsWith("LARK_MODEL_PROVIDER_")),',
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
  env: { PI_CODING_AGENT_DIR?: string; PI_SKIP_VERSION_CHECK?: string; PI_TELEMETRY?: string;
    LARK_MODEL_GATE_SOCKET?: string; LARK_MODEL_GATE_PRIORITY?: string;
    LARK_PI_BASH_DEFAULT_TIMEOUT?: string; LARK_PI_BASH_MAX_TIMEOUT?: string };
  providerEnv: Array<[string, string]>;
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    stdin: string;
    cwd: string;
    systemPrompt: string;
    env: { PI_CODING_AGENT_DIR?: string; PI_SKIP_VERSION_CHECK?: string; PI_TELEMETRY?: string;
    LARK_MODEL_GATE_SOCKET?: string; LARK_MODEL_GATE_PRIORITY?: string;
    LARK_PI_BASH_DEFAULT_TIMEOUT?: string; LARK_PI_BASH_MAX_TIMEOUT?: string };
    providerEnv: Array<[string, string]>;
  };
}
