import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PiAdapter } from '../../src/agent/pi/adapter';
import { PiSdkAdapter } from '../../src/agent/pi-sdk/adapter';
import { newRunHostKey, probeRunHost, readRunHostInput } from '../../src/agent/run-host';
import { isolateRunHosts } from '../helpers/run-hosts';
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
  it('runs RPC mode, steers the active turn, and keeps prompt/system text out of argv', async () => {
    const harness = await createFakePi([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'OK' } },
    ], {
      sessionId: 'sess-resumed',
      // The turn only finishes after the steer, so input arrives while it runs.
      steerLines: [
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
      ],
    });
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

    expect(run.capabilities).toEqual({ finalAnswer: 'separate-event', input: 'active-turn' });
    const events: AgentEvent[] = [];
    let steered: ReturnType<NonNullable<typeof run.sendInput>> | undefined;
    for await (const event of run.events) {
      events.push(event);
      // The turn is running: a message written now steers it instead of waiting.
      if (!steered) steered = run.sendInput!({ text: 'also cover CRLF', messageId: 'om-steer' });
    }
    expect(await steered).toEqual({ status: 'accepted', messageId: 'om-steer', scope: 'active-turn' });
    expect(events.filter(event => event.type !== 'system')).toEqual([
      { type: 'text', delta: 'OK' },
      { type: 'usage', inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, costUsd: 0 },
      { type: 'final_text', content: 'OK' },
      { type: 'done', sessionId: 'sess-resumed', terminationReason: 'normal' },
    ]);
    // The session arrives from the RPC state answer, whenever that lands.
    expect(events.find(event => event.type === 'system')).toEqual({
      type: 'system', sessionId: 'sess-resumed', cwd: await realpath(harness.dir),
    });
    expect(await run.waitForExit(1000)).toBe(true);

    const record = await readRecord(harness.recordPath);
    expect(record.cwd).toBe(await realpath(harness.dir));
    const commands = record.commands;
    // The session is asked for first, so a fast turn settles with its id known.
    expect(commands[0]).toMatchObject({ type: 'get_state' });
    expect(commands.find(command => command.type === 'prompt')).toMatchObject({ message: 'hello <bridge_context>' });
    expect(commands.find(command => command.type === 'steer')).toMatchObject({ message: 'also cover CRLF' });
    expect(record.argv.slice(0, 3)).toEqual(['--mode', 'rpc', '--append-system-prompt']);
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
    // Once the turn has settled the process is gone and further input is not for it.
    expect((await run.sendInput!({ text: 'too late', messageId: 'om-late' })).status).toBe('inactive');
  });

  it('forks a parent session for side questions', async () => {
    const harness = await createFakePi([
      { type: 'agent_settled', aborted: false },
    ], { sessionId: 'sess-child' });
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

    const output = events.filter(event => event.type !== 'system');
    expect(output).toEqual([
      { type: 'text', delta: 'partial' },
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('pi exited with code 42:'),
        terminationReason: 'failed',
        failureKind: 'runtime',
      }),
    ]);
    expect((output[1] as { message: string }).message).toContain('provider down');
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

  it('asks the gate under the service name for every model of a service the bridge registers', async () => {
    process.env.PI_PROVIDER_TEST_KEY = 'private-provider-key';
    const registry = new ModelProviderRegistry({
      'high-five-ai': { protocol: 'responses', baseUrl: 'https://gateway.example/v1', model: 'deepseek-flash',
        apiKey: { source: 'env', id: 'PI_PROVIDER_TEST_KEY' } },
    });
    const names = async (selection: string, gate: boolean): Promise<string | undefined> => {
      const harness = await createFakePi([{ type: 'system', id: 'sess-gate', cwd: '/repo' }, { type: 'agent_settled', aborted: false }]);
      dirs.push(harness.dir);
      setModelGateTarget(gate ? { socketPath: '/tmp/model-gate.sock' } : undefined);
      const provider = await registry.resolve('pi', selection);
      const run = (await new PiAdapter({ binary: harness.binary, profileStateDir: harness.dir }).prepareRun({
        runId: 'pi-gate-names', prompt: 'hello', cwd: harness.dir, model: provider!.model, modelProvider: provider,
      })).start();
      for await (const event of run.events) {
        if (event.type === 'done') break;
      }
      await run.waitForExit(2000);
      return (await readRecord(harness.recordPath)).env.LARK_MODEL_GATE_PROVIDER_NAMES;
    };

    // Pi knows each model under an id of its own; the quota is the service's.
    expect(JSON.parse((await names('high-five-ai/deepseek-flash', true))!)).toEqual({ lark_high_five_ai_01b55021b1f8: 'high-five-ai' });
    const other = JSON.parse((await names('high-five-ai/deepseek-flash-cyber', true))!) as Record<string, string>;
    expect(Object.keys(other)).toHaveLength(1);
    expect(Object.keys(other)[0]).toMatch(/^lark_high_five_ai_[0-9a-f]{12}$/);
    expect(Object.keys(other)[0]).not.toBe('lark_high_five_ai_01b55021b1f8');
    expect(Object.values(other)).toEqual(['high-five-ai']);
    expect(await names('high-five-ai/deepseek-flash', false)).toBeUndefined();
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

describe.skipIf(process.platform === 'win32')('PiAdapter under a run host', () => {
  let dir: string;
  let restoreHosts: () => Promise<void>;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-hosted-')));
    dirs.push(dir);
    restoreHosts = isolateRunHosts(join(dir, 'hosts'));
  });
  afterEach(() => restoreHosts());

  /** A Pi that reports its session, says it is working, and answers only once the test lets it. */
  async function hostedPi(): Promise<{
    adapter: PiAdapter;
    binary: string;
    record(): Promise<{ stdin: string; commands: Array<Record<string, unknown>>; promptPath: string; systemPrompt: string }>;
    pids(): Promise<number[]>;
  }> {
    const binary = join(dir, 'pi');
    await writeFile(binary, [
      '#!/usr/bin/env node',
      'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
      'const argv = process.argv.slice(2);',
      'if (argv.includes("--version")) { console.log("pi 999.0.0"); process.exit(0); }',
      `const dir = ${JSON.stringify(dir)};`,
      'const out = (value, done) => process.stdout.write(JSON.stringify(value) + "\\n", done);',
      'const promptPath = argv[argv.indexOf("--append-system-prompt") + 1];',
      'appendFileSync(dir + "/pids.log", process.pid + "\\n");',
      'let stdin = "";',
      'let pending = "";',
      'const commands = [];',
      'const record = () => writeFileSync(dir + "/record.json", JSON.stringify({ stdin, commands, promptPath, systemPrompt: readFileSync(promptPath, "utf8") }));',
      'function watchRelease() {',
      '  const timer = setInterval(() => {',
      '    if (!existsSync(dir + "/release")) return;',
      '    clearInterval(timer);',
      '    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "finished after restart" }], stopReason: "stop",',
      '      usage: { input: 2, output: 1, cacheRead: 0, cost: { total: 0 } } } });',
      '    out({ type: "agent_settled", aborted: false }, () => process.exit(0));',
      '  }, 20);',
      '}',
      'function handle(command) {',
      '  commands.push(command);',
      '  if (command.type === "get_state") {',
      '    out({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionId: "sess-hosted", isStreaming: true } });',
      '  } else if (command.type === "prompt") {',
      '    record();',
      '    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working" } });',
      '    watchRelease();',
      '  } else if (command.type === "steer") {',
      '    out({ id: command.id, type: "response", command: "steer", success: true, data: { disposition: "queued" } });',
      '  } else if (command.type === "abort") {',
      '    out({ id: command.id, type: "response", command: "abort", success: true });',
      '    out({ type: "agent_settled", aborted: true });',
      '  } else if (command.type === "clear_queue") {',
      '    out({ id: command.id, type: "response", command: "clear_queue", success: true, data: { steering: [], followUp: [] } });',
      '  }',
      '}',
      'process.stdin.on("data", chunk => {',
      '  stdin += chunk;',
      '  pending += chunk;',
      '  for (let newline = pending.indexOf("\\n"); newline >= 0; newline = pending.indexOf("\\n")) {',
      '    const line = pending.slice(0, newline);',
      '    pending = pending.slice(newline + 1);',
      '    if (line.trim()) handle(JSON.parse(line));',
      '  }',
      '});',
      'process.stdin.on("end", () => { record(); process.exit(0); });',
    ].join('\n'), 'utf8');
    await chmod(binary, 0o755);
    return {
      adapter: new PiAdapter({ binary, systemPrompt: 'HOSTED SYSTEM PROMPT', stopGraceMs: 1000 }), binary,
      record: async () => JSON.parse(await readFile(join(dir, 'record.json'), 'utf8')) as {
        stdin: string;
        commands: Array<Record<string, unknown>>;
        promptPath: string;
        systemPrompt: string;
      },
      pids: async () => (await readFile(join(dir, 'pids.log'), 'utf8')).trim().split('\n').map(Number),
    };
  }

  async function next(iterator: AsyncIterator<AgentEvent>, type: AgentEvent['type']): Promise<AgentEvent> {
    for (;;) {
      const result = await iterator.next();
      if (result.done) throw new Error(`stream ended before ${type}`);
      if (result.value.type === type) return result.value;
    }
  }

  async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error('condition not reached');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  function alive(pid: number): boolean {
    try { process.kill(pid, 0); } catch { return false; }
    // An orphan the container's init has not reaped yet is already dead.
    try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'; } catch { return true; }
  }

  it('keeps a run alive across a shutdown and replays it to the next bridge process', async () => {
    const pi = await hostedPi();
    const key = newRunHostKey();
    const options = { runId: 'pi-hosted', prompt: 'hosted prompt', cwd: dir };
    const first = (await pi.adapter.prepareRun({ ...options, host: { key } })).start();
    expect(first.detachOnShutdown).toBe(true);
    const stream = first.events[Symbol.asyncIterator]();
    // The session is reported at once; what the agent says is held back until its message is complete.
    expect(await next(stream, 'system')).toMatchObject({ sessionId: 'sess-hosted' });
    await until(() => existsSync(join(dir, 'record.json')));
    const record = await pi.record();
    expect(record.commands.find(command => command.type === 'prompt')).toMatchObject({ message: 'hosted prompt' });
    expect(record.systemPrompt).toContain('HOSTED SYSTEM PROMPT');

    await first.stop('shutdown');
    while (!(await stream.next()).done) { /* the stream of this bridge process ends */ }
    // The agent runs on, with the file it was started with.
    const [pid] = await pi.pids();
    expect(alive(pid!)).toBe(true);
    expect(await probeRunHost(key)).toBe('running');
    expect(existsSync(record.promptPath)).toBe(true);

    const second = (await pi.adapter.prepareRun({ ...options, host: { key, attach: true } })).start();
    const replayed = collect(second.events);
    // The reattached run steers too: it asks the process's state first.
    expect(await second.sendInput!({ text: 'after restart', messageId: 'om-after' }))
      .toEqual({ status: 'accepted', messageId: 'om-after', scope: 'active-turn' });
    await writeFile(join(dir, 'release'), '');
    expect(await replayed).toEqual([
      { type: 'system', sessionId: 'sess-hosted', cwd: dir },
      { type: 'text', delta: 'working' },
      { type: 'usage', inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, costUsd: 0 },
      { type: 'final_text', content: 'finished after restart' },
      { type: 'done', sessionId: 'sess-hosted', terminationReason: 'normal' },
    ]);
    expect(await second.waitForExit(3000)).toBe(true);
    // One process did all of it, and was given its prompt once.
    expect(await pi.pids()).toEqual([pid]);
    expect(readRunHostInput(key).filter(line => line.includes('"prompt"'))).toHaveLength(1);
    expect(existsSync(record.promptPath)).toBe(false);
  }, 20_000);

  it('delivers a run that finished while no bridge was attached', async () => {
    const pi = await hostedPi();
    const key = newRunHostKey();
    const options = { runId: 'pi-hosted', prompt: 'hosted prompt', cwd: dir };
    const first = (await pi.adapter.prepareRun({ ...options, host: { key } })).start();
    const stream = first.events[Symbol.asyncIterator]();
    await next(stream, 'system');
    await first.stop('shutdown');
    while (!(await stream.next()).done) { /* drained */ }
    await writeFile(join(dir, 'release'), '');
    await until(async () => await probeRunHost(key) === 'exited');

    const second = (await pi.adapter.prepareRun({ ...options, host: { key, attach: true } })).start();
    const events = await collect(second.events);
    expect(events.at(-2)).toEqual({ type: 'final_text', content: 'finished after restart' });
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
  }, 20_000);

  it('ends the agent and removes its file when the run is stopped for any other reason', async () => {
    const pi = await hostedPi();
    const key = newRunHostKey();
    const run = (await pi.adapter.prepareRun({ runId: 'pi-hosted', prompt: 'hosted prompt', cwd: dir, host: { key } })).start();
    const stream = run.events[Symbol.asyncIterator]();
    await next(stream, 'system');
    await until(() => existsSync(join(dir, 'record.json')));
    const record = await pi.record();
    const [pid] = await pi.pids();
    await run.stop('cancelled');
    while (!(await stream.next()).done) { /* drained */ }
    expect(await run.waitForExit(3000)).toBe(true);
    await until(() => !alive(pid!));
    expect(existsSync(record.promptPath)).toBe(false);
  }, 20_000);

  it('is not continued by the SDK transport, which ends it instead of running beside it', async () => {
    const pi = await hostedPi();
    const key = newRunHostKey();
    const options = { runId: 'pi-hosted', prompt: 'hosted prompt', cwd: dir };
    const first = (await pi.adapter.prepareRun({ ...options, host: { key } })).start();
    const stream = first.events[Symbol.asyncIterator]();
    await next(stream, 'system');
    await first.stop('shutdown');
    while (!(await stream.next()).done) { /* drained */ }
    const [pid] = await pi.pids();
    expect(alive(pid!)).toBe(true);
    await until(() => existsSync(join(dir, 'record.json')));
    const { promptPath } = await pi.record();
    expect(existsSync(promptPath)).toBe(true);

    const sdk = new PiSdkAdapter({ config: { binaryPath: pi.binary, transport: 'sdk', sdkPath: pi.binary, nodePath: process.execPath,
      hostScript: pi.binary, agentDir: join(dir, 'agent') } });
    await expect(sdk.prepareRun({ ...options, host: { key, attach: true } })).rejects.toThrow('cannot continue a pi cli run');
    await until(() => !alive(pid!));
    expect(await probeRunHost(key)).toBe('missing');
    expect(existsSync(join(dir, 'hosts', key))).toBe(false);
    // Whoever ends the host removes the file the agent was started with.
    expect(existsSync(promptPath)).toBe(false);
    await sdk.shutdown(0);
  }, 20_000);
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

async function createFakePi(
  lines: unknown[],
  options: {
    exitCode?: number;
    stderr?: string;
    trailingBytes?: number;
    sessionId?: string;
    steerLines?: unknown[];
  } = {},
): Promise<{ dir: string; binary: string; recordPath: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-adapter-')));
  const binary = join(dir, 'pi');
  const recordPath = join(dir, 'record.json');
  const sessionId = options.sessionId ?? 'sess-fake';
  await writeFile(binary, [
    '#!/usr/bin/env node',
    'import { readFileSync, writeFileSync } from "node:fs";',
    'const argv = process.argv.slice(2);',
    'if (argv.includes("--version")) { console.log("pi 999.0.0"); process.exit(0); }',
    'const promptIndex = argv.indexOf("--append-system-prompt");',
    'let stdin = "";',
    'let pending = "";',
    'const commands = [];',
    'const out = (value, done) => process.stdout.write(JSON.stringify(value) + "\\n", done);',
    `const record = () => writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
    '  argv, stdin, commands, cwd: process.cwd(),',
    '  systemPrompt: promptIndex >= 0 ? readFileSync(argv[promptIndex + 1], "utf8") : "",',
    '  env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK, PI_TELEMETRY: process.env.PI_TELEMETRY, LARK_MODEL_GATE_SOCKET: process.env.LARK_MODEL_GATE_SOCKET, LARK_MODEL_GATE_PRIORITY: process.env.LARK_MODEL_GATE_PRIORITY, LARK_MODEL_GATE_PROVIDER_NAMES: process.env.LARK_MODEL_GATE_PROVIDER_NAMES, LARK_PI_BASH_DEFAULT_TIMEOUT: process.env.LARK_PI_BASH_DEFAULT_TIMEOUT, LARK_PI_BASH_MAX_TIMEOUT: process.env.LARK_PI_BASH_MAX_TIMEOUT },',
    '  providerEnv: Object.entries(process.env).filter(([key]) => key.startsWith("LARK_MODEL_PROVIDER_")),',
    '}));',
    'const emit = (values, done) => {',
    '  if (values.length === 0) { if (done) done(); return; }',
    '  values.forEach((value, index) => out(value, index === values.length - 1 ? done : undefined));',
    '};',
    'function handle(command) {',
    '  commands.push(command);',
    '  if (command.type === "get_state") {',
    `    out({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionId: ${JSON.stringify(sessionId)}, isStreaming: true } });`,
    '  } else if (command.type === "prompt") {',
    '    record();',
    `    emit(${JSON.stringify(lines)}, () => {`,
    options.exitCode !== undefined
      ? `      process.stderr.write(${JSON.stringify(options.stderr ?? '')}); process.exit(${options.exitCode});`
      : '',
    '    });',
    '  } else if (command.type === "steer") {',
    '    out({ id: command.id, type: "response", command: "steer", success: true, data: { disposition: "queued" } });',
    `    emit(${JSON.stringify(options.steerLines ?? [])});`,
    '  } else if (command.type === "abort") {',
    '    out({ id: command.id, type: "response", command: "abort", success: true });',
    '    out({ type: "agent_settled", aborted: true });',
    '  } else if (command.type === "clear_queue") {',
    '    out({ id: command.id, type: "response", command: "clear_queue", success: true, data: { steering: [], followUp: [] } });',
    '  }',
    '}',
    'process.stdin.on("data", chunk => {',
    '  stdin += chunk;',
    '  pending += chunk;',
    '  for (let newline = pending.indexOf("\\n"); newline >= 0; newline = pending.indexOf("\\n")) {',
    '    const line = pending.slice(0, newline);',
    '    pending = pending.slice(newline + 1);',
    '    if (line.trim()) handle(JSON.parse(line));',
    '  }',
    '});',
    'process.stdin.on("end", () => {',
    '  record();',
    options.trailingBytes ? [
      '  setTimeout(() => {',
      `    process.stdout.write("x".repeat(${options.trailingBytes}) + "\\n", error => {`,
      '      if (error) process.exit(2);',
      `      writeFileSync(${JSON.stringify(join(dir, 'clean-exit'))}, "ok");`,
      '      process.exit(0);',
      '    });',
      '  }, 100);',
    ].join('\n') : '  if (!commands.some(command => command.type === "prompt")) process.exit(0);',
    '});',
  ].filter(Boolean).join('\n'), 'utf8');
  await chmod(binary, 0o755);
  return { dir, binary, recordPath };
}

interface FakeRecord {
  argv: string[];
  stdin: string;
  commands: Array<Record<string, unknown>>;
  cwd: string;
  systemPrompt: string;
  env: { PI_CODING_AGENT_DIR?: string; PI_SKIP_VERSION_CHECK?: string; PI_TELEMETRY?: string;
    LARK_MODEL_GATE_SOCKET?: string; LARK_MODEL_GATE_PRIORITY?: string; LARK_MODEL_GATE_PROVIDER_NAMES?: string;
    LARK_PI_BASH_DEFAULT_TIMEOUT?: string; LARK_PI_BASH_MAX_TIMEOUT?: string };
  providerEnv: Array<[string, string]>;
}

async function readRecord(path: string): Promise<FakeRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as FakeRecord;
}
