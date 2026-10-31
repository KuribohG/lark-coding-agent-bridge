import { buildLarkChannelEnv } from '../../src/agent/lark-channel-env';
import { buildBridgeSystemPrompt } from '../../src/channels/lark/system-prompt';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';
import { processAnalysis } from '../../src/monitoring/sources/lark/processor.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('ClaudeAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh run with stream-json, verbose, permission mode, and bridge prompt args', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-fresh' }],
    });
    cleanup.push(fake.dir);

    const run = (await new ClaudeAdapter({ binary: fake.path, systemPrompt: buildBridgeSystemPrompt, env: buildLarkChannelEnv() }).prepareRun({
      runId: 'run-fresh',
      prompt: 'hello',
      cwd: fake.dir,
      permissionMode: 'acceptEdits',
    })).start();

    expect(run.runId).toBe('run-fresh');
    expect(run.capabilities).toEqual({ finalAnswer: 'separate-event', input: 'active-session' });
    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-fresh', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(await realpath(fake.dir));
    expect(record.env.LARK_CHANNEL).toBe('1');
    // The prompt goes via stdin, and the bridge system prompt via a temp file,
    // so neither ever touches argv (which cmd.exe would mangle on Windows).
    expect(JSON.parse(record.stdin).message.content).toBe('hello');
    expect(record.argv.slice(0, 10)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--replay-user-messages',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--append-system-prompt-file',
    ]);
    expect(record.argv).not.toContain('hello');
    expect(record.systemPrompt).toContain('lark-channel-bridge 运行约定');
    expect(record.systemPrompt).toContain('__bridge_cb');
    expect(record.systemPrompt).toContain('LARK_CHANNEL_PROFILE');
    expect(record.systemPrompt).toContain('LARKSUITE_CLI_CONFIG_DIR');
    expect(record.systemPrompt).not.toContain('lark-cli config bind --source lark-channel');
    expect(record.systemPrompt).not.toContain('__claude_cb');
    expect(record.argv).not.toContain('--resume');
    expect(record.argv).not.toContain('--model');
  });

  it('injects the active bridge profile env into spawned runs', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-profile' }],
    });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'codex-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(rootDir, 'profiles', 'codex-dev', 'lark-cli-source', 'config.json');

    const run = (await new ClaudeAdapter({
      binary: fake.path,
      env: buildLarkChannelEnv({
        profile: 'codex-dev',
        rootDir,
        configPath,
        larkCliConfigDir,
        larkCliSourceConfigFile,
      }),
    }).prepareRun({
      runId: 'run-profile-env',
      prompt: 'profile',
      cwd: fake.dir,
    })).start();

    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'codex-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
    });
  });

  it('passes resume and model after the base CLI contract', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-resumed' }],
    });
    cleanup.push(fake.dir);

    const run = (await new ClaudeAdapter({ binary: fake.path }).prepareRun({
      runId: 'run-resume',
      prompt: 'continue',
      cwd: fake.dir,
      sessionId: 'sess-old',
      model: 'private/sonnet',
      reasoningEffort: 'high',
    })).start();

    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-resumed', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(record.argv.slice(-6)).toEqual(['--resume', 'sess-old', '--model', 'private/sonnet', '--effort', 'high']);
    expect(record.argv[8]).toBe('bypassPermissions');
  });

  it('maps timed-run ultra to the ultracode settings file and blocks scheduling tools before the deadline', async () => {
    const fake = await createFakeClaude({ lines: [{ type: 'result', session_id: 'sess-ultra' }] });
    cleanup.push(fake.dir);

    const run = (await new ClaudeAdapter({ binary: fake.path }).prepareRun({
      runId: 'run-ultra',
      prompt: 'deep task',
      cwd: fake.dir,
      reasoningEffort: 'ultra',
      deadlineAt: Date.now() + 60_000,
    })).start();
    try {
      expect(await collect(run.events)).toContainEqual({ type: 'done', sessionId: 'sess-ultra', terminationReason: 'normal' });
    } finally { await run.stop(); }
    const record = await readRecord(fake.recordPath);

    expect(record.argv).not.toContain('--effort');
    expect(record.argv).not.toContain('ultra');
    expect(JSON.parse(record.settings!)).toEqual({ ultracode: true, workflowSizeGuideline: 'large' });
    expect(record.argv[record.argv.indexOf('--disallowedTools') + 1]).toBe('CronCreate,CronDelete,CronList,ScheduleWakeup');
    expect(JSON.parse(record.stdin).message.content).toBe('deep task');
  });

  it('forks a parent for a side answer and exposes the final result', async () => {
    const fake = await createFakeClaude({ lines: [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'intermediate' }] } },
      { type: 'result', result: 'final answer', session_id: 'child' },
    ] });
    cleanup.push(fake.dir);
    const adapter = new ClaudeAdapter({ binary: fake.path });
    const run = (await adapter.prepareRun({ runId: 'side', prompt: 'side question', cwd: fake.dir, sessionId: 'parent', forkSession: true })).start();
    expect(await collect(run.events)).toContainEqual({ type: 'final_text', content: 'final answer' });
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toContain('--fork-session');
    expect(record.argv[record.argv.indexOf('--resume') + 1]).toBe('parent');
    expect(JSON.parse(record.stdin).message.content).toBe('side question');
    await expect(async () => (await adapter.prepareRun({ runId: 'invalid', prompt: 'no parent', cwd: fake.dir, forkSession: true })).start()).rejects.toThrow('parent');
  });

  it('skips orphaned task-notification results before the prompt turn', async () => {
    const fake = await createFakeClaude({ lines: [
      { type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'stopped', session_id: 'child' },
      { type: 'system', subtype: 'init', session_id: 'child' },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '', origin: { kind: 'task-notification' }, session_id: 'child' },
      { type: 'system', subtype: 'init', session_id: 'child' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'answer', session_id: 'child' },
    ] });
    cleanup.push(fake.dir);
    const run = (await new ClaudeAdapter({ binary: fake.path }).prepareRun({ runId: 'side', prompt: 'q', cwd: fake.dir, sessionId: 'parent', forkSession: true })).start();
    const events = await collect(run.events);
    expect(events.filter((event) => event.type === 'final_text')).toEqual([{ type: 'final_text', content: 'answer' }]);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(events.findIndex((event) => event.type === 'done')).toBeGreaterThan(events.findIndex((event) => event.type === 'text'));
  });

  it('includes stderr when the process exits non-zero', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'before failure' }] } }],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = (await new ClaudeAdapter({ binary: fake.path }).prepareRun({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: fake.dir,
    })).start();

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      {
        type: 'error',
        message: 'claude exited with code 42: boom',
        terminationReason: 'failed',
        failureKind: 'runtime',
      },
    ]);
  });

  it('ends once at the first covered top-level result, ignoring late duplicate output', async () => {
    const fake = await createFakeClaude({ lines: [
      { type: 'assistant', message: { id: 'final', content: [{ type: 'text', text: 'answer' }] } },
      { type: 'result', result: 'answer', session_id: 'session' },
      { type: 'result', result: 'duplicate', session_id: 'session' },
    ] });
    cleanup.push(fake.dir);
    const run = (await new ClaudeAdapter({ binary: fake.path }).prepareRun({ runId: 'terminal', prompt: 'task', cwd: fake.dir })).start();
    expect(await collect(run.events)).toEqual([
      { type: 'final_text', content: 'answer' }, { type: 'done', sessionId: 'session', terminationReason: 'normal' },
    ]);
    expect(await run.waitForExit(1000)).toBe(true);
  });

  it.each(['success', 'missing', 'failure'])('validates background reports through the shared executor (%s)', async mode => {
    const text = JSON.stringify({ replyDraft: '草稿', analysis: '核对完成', missingInfo: '' });
    const fake = await createFakeClaude({ lines: [
      { type: 'assistant', message: { id: 'progress', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'read', name: 'Read', input: {} }] } },
      { type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text }] } },
      { type: 'result', session_id: 'session', usage: { input_tokens: 10, output_tokens: 20 },
        ...(mode === 'success' ? { result: text } : mode === 'failure' ? { is_error: true, errors: ['provider rejection'] } : {}) },
    ] });
    cleanup.push(fake.dir);
    const events: AgentEvent[] = [];
    const result = processAnalysis(new ClaudeAdapter({ binary: fake.path }),
      { runId: 'background', prompt: 'investigate', cwd: fake.dir }, new AbortController().signal, event => events.push(event));
    if (mode === 'success') {
      expect(await result).toEqual({ text, inputTokens: 10, outputTokens: 20 });
      expect(events.filter(e => e.type === 'text')).toEqual([{ type: 'text', delta: 'checking' }]);
    } else {
      await expect(result).rejects.toMatchObject({ code: mode === 'missing' ? 'incomplete' : 'agent' });
      expect(events.filter(e => e.type === 'final_text')).toEqual([]);
    }
  });

  it('surfaces spawn errors as stream error events', async () => {
    let run: import('../../src/agent/types').AgentRun;
    if (process.platform === 'win32') {
      const fake = await createFakeClaude({
        lines: [],
        stderr: 'missing command\n',
        exitCode: 1,
      });
      cleanup.push(fake.dir);
      run = (await new ClaudeAdapter({ binary: fake.path }).prepareRun({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: fake.dir,
      })).start();
    } else {
      const missing = join(tmpdir(), `missing-claude-${Date.now()}`);
      run = (await new ClaudeAdapter({ binary: missing }).prepareRun({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: tmpdir(),
      })).start();
    }

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn claude|spawn returned no pid|claude exited with code/,
    );
  });

  it('waits for post-done process exit before stop fallback is needed', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-tail' }],
      exitDelayMs: 150,
    });
    cleanup.push(fake.dir);

    const run = (await new ClaudeAdapter({ binary: fake.path }).prepareRun({
      runId: 'run-tail',
      prompt: 'tail',
      cwd: fake.dir,
    })).start();
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', sessionId: 'sess-tail', terminationReason: 'normal' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    expect(await run.waitForExit(1_000)).toBe(true);
    await iterator.return?.();
  });

  it.each(['merged', 'late', 'crash', 'stop'] as const)('handles %s supplemental input through the live stdin pipe', async mode => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-duplex-test-'));
    cleanup.push(dir);
    const binary = join(dir, 'fake-claude.mjs');
    const recordPath = join(dir, 'inputs.json');
    await writeFile(binary, `#!/usr/bin/env node
      import { createInterface } from 'node:readline';
      import { writeFileSync } from 'node:fs';
      const mode = ${JSON.stringify(mode)};
      const inputs = [];
      const emit = event => console.log(JSON.stringify(event));
      const result = ids => emit({ type: 'result', session_id: 'same-session', result: 'supplement processed', user_message_uuids: ids });
      const rl = createInterface({ input: process.stdin });
      rl.on('line', line => {
        const input = JSON.parse(line); inputs.push(input);
        writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(inputs));
        if (inputs.length === 1) {
          emit({ type: 'system', subtype: 'init', session_id: 'same-session' });
          emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'working' } }] } });
        } else if (mode === 'crash') {
          process.stderr.write('429 Too Many Requests'); process.exit(42);
        } else if (mode !== 'stop') {
          emit({ type: 'command_lifecycle', state: 'queued', command_uuid: input.uuid });
          if (mode === 'late') result([inputs[0].uuid]);
          setTimeout(() => {
            emit({ type: 'user', isReplay: true, uuid: input.uuid, message: input.message });
            emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'supplement processed' }] } });
            result(inputs.map(x => x.uuid));
          }, 20);
        }
      });
      process.stdin.on('end', () => process.exit(0));
    `, { mode: 0o700 });
    const run = (await new ClaudeAdapter({ binary }).prepareRun({ runId: 'duplex', prompt: 'original', cwd: dir, stopGraceMs: 100 })).start();
    const events: AgentEvent[] = [];
    let delivery: Promise<string> | undefined;
    try {
      for await (const event of run.events) {
        events.push(event);
        if (event.type === 'tool_use') {
          // Read stdout concurrently with the pending input acknowledgement.
          delivery = run.sendInput!({ text: 'supplement', messageId: 'im-2' }).then(receipt => {
            if (receipt.status === 'accepted') expect(receipt.scope).toBe('active-session');
            return receipt.status === 'unknown' ? receipt.message : receipt.status;
          });
          if (mode === 'stop') {
            const { vi } = await import('vitest');
            await vi.waitFor(async () => expect(JSON.parse(await readFile(recordPath, 'utf8'))).toHaveLength(2));
            await run.stop();
          }
        }
      }
      const inputs = JSON.parse(await readFile(recordPath, 'utf8'));
      expect(inputs).toHaveLength(2);
      expect(inputs[1]).toMatchObject({ session_id: 'same-session', message: { content: 'supplement' } });
      if (mode === 'crash' || mode === 'stop') {
        expect(await delivery).toContain('delivery is unknown');
        if (mode === 'stop') expect(events).toContainEqual({ type: 'done', terminationReason: 'interrupted' });
        if (mode === 'crash') expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('delivery is unknown') }));
      } else {
        expect(await delivery).toBe('accepted');
        expect(events.filter(event => event.type === 'done')).toHaveLength(1);
        expect(events.filter(event => event.type === 'final_text')).toEqual([{ type: 'final_text', content: 'supplement processed' }]);
        expect(events.filter(event => event.type === 'text')).toEqual([]);
        expect(events.findIndex(event => event.type === 'done')).toBeGreaterThan(events.findIndex(event => event.type === 'final_text'));
        expect(await run.steer!('late', 'im-3')).toBe('inactive');
      }
      expect(await run.waitForExit(1000)).toBe(true);
    } finally { await run.stop(); }
  });

  it('requires cwd to be resolved by policy before spawning', async () => {
    await expect(async () =>
      (await new ClaudeAdapter({ binary: 'unused' }).prepareRun({ runId: 'run-no-cwd', prompt: 'hi' })).start(),
    ).rejects.toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeClaude(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-adapter-test-'));
  const path = join(dir, 'fake-claude.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync, readFileSync } from "node:fs";',
      'const argv = process.argv.slice(2);',
      'const spIdx = argv.indexOf("--append-system-prompt-file");',
      'const systemPrompt = spIdx !== -1 ? readFileSync(argv[spIdx + 1], "utf8") : null;',
      'const settingsIdx = argv.indexOf("--settings");',
      'const settings = settingsIdx !== -1 ? readFileSync(argv[settingsIdx + 1], "utf8") : null;',
      'let stdin = "";',
      'process.stdin.on("data", (c) => { stdin += c; });',
      'const rl = (await import("node:readline")).createInterface({ input: process.stdin });',
      'rl.once("line", line => {',
      '  const input = JSON.parse(line);',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv,',
      '    stdin,',
      '    systemPrompt,',
      '    settings,',
      '    cwd: process.cwd(),',
      '    env: {',
      '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '      LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
      '      LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
      '      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
      '    },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  console.log(JSON.stringify({ ...input, isReplay: true }));',
      '  for (const line of lines) console.log(JSON.stringify(line.type === "result" ? { ...line, user_message_uuids: [input.uuid] } : line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  const exit = () => setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
      '  if (lines.some(line => line.type === "result")) process.stdin.on("end", exit); else exit();',
      '});',
    ].filter(Boolean).join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  stdin: string;
  systemPrompt: string | null;
  settings: string | null;
  cwd: string;
  env: {
    LARK_CHANNEL?: string;
    LARK_CHANNEL_PROFILE?: string;
    LARK_CHANNEL_HOME?: string;
    LARK_CHANNEL_CONFIG?: string;
    LARKSUITE_CLI_CONFIG_DIR?: string;
  };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    stdin: string;
    systemPrompt: string | null;
    settings: string | null;
    cwd: string;
    env: {
      LARK_CHANNEL?: string;
      LARK_CHANNEL_PROFILE?: string;
      LARK_CHANNEL_HOME?: string;
      LARK_CHANNEL_CONFIG?: string;
      LARKSUITE_CLI_CONFIG_DIR?: string;
    };
  };
}
