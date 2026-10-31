import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import type { AgentEvent, AgentRunOptions } from '../../src/agent/types';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-daemon-'));
  dirs.push(dir);
  const binary = join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const script = process.platform === 'win32' ? join(dir, 'codex.cjs') : binary;
  const daemonState = join(dir, 'daemon-running');
  const lifecycle = join(dir, 'lifecycle.jsonl');
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\codex-daemon-${randomUUID()}` : join(dir, 'app.sock');
  const requests: Array<{ method: string; params: any }> = [];

  const httpServer = createServer();
  const wsServer = new WebSocketServer({ server: httpServer });
  wsServer.on('connection', ws => {
    ws.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.method) requests.push({ method: message.method, params: message.params });
      const send = (value: unknown) => ws.send(JSON.stringify(value));
      const notify = (method: string, params: unknown) => send({ method, params });
      if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
        send({ id: message.id, result: { thread: { id: 'thread-1' } } });
      }
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
        notify('item/completed', {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { id: 'answer', type: 'agentMessage', text: 'daemon result' },
        });
        notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
      }
    });
  });
  await new Promise<void>(resolve => httpServer.listen(socketPath, resolve));
  closers.push(async () => {
    for (const client of wsServer.clients) client.terminate();
    await new Promise<void>(resolve => wsServer.close(() => resolve()));
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
  });

  await writeFile(script, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const record = value => fs.appendFileSync(${JSON.stringify(lifecycle)}, JSON.stringify(value) + '\\n');
record({ args, codexHome: process.env.CODEX_HOME });
if (args[0] === '--version') {
  process.stdout.write('codex 0.162.1\\n');
  process.exit(0);
}
if (args[0] === 'app-server' && args[1] === 'proxy') {
  const socket = require('node:net').connect(args[3]);
  process.stdin.pipe(socket).pipe(process.stdout);
  socket.on('error', () => process.exit(1));
  socket.on('close', () => process.exit(0));
  return;
}
if (args[0] === 'app-server' && args[1] === 'daemon') {
  if (args[2] === 'version') {
    if (!fs.existsSync(${JSON.stringify(daemonState)})) {
      process.stderr.write('failed to connect: daemon not running\\n');
      process.exit(1);
    }
    process.stdout.write('warning before json\\n');
    process.stdout.write(JSON.stringify({ status: 'running', apiVersion: 1, socketPath: ${JSON.stringify(socketPath)} }) + '\\n');
    process.exit(0);
  }
  if (args[2] === 'stop') {
    fs.rmSync(${JSON.stringify(daemonState)}, { force: true });
    process.exit(0);
  }
  if (args[2] === 'start') {
    fs.writeFileSync(${JSON.stringify(daemonState)}, String(process.pid));
    process.stdout.write('{"status":"started","pid":4242,"cliVersion":"0.162.1","appServerVersion":"0.162.1"}\\n');
    process.exit(0);
  }
  process.stderr.write('unexpected daemon command\\n');
  process.exit(2);
}
process.stderr.write('unexpected command\\n');
process.exit(2);
`);
  if (process.platform === 'win32') {
    await writeFile(binary, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  }
  await chmod(binary, 0o700);

  const provider = { id: 'probe', displayName: 'Probe', model: 'probe-model', env: { PROBE_API_KEY: 'must-not-be-serialized' }, codex: { providerId: 'probe', name: 'Probe', baseUrl: 'https://probe.example/v1', wireApi: 'responses' as const, apiKeyEnv: 'PROBE_API_KEY' } };
  return {
    dir,
    restartAdapter: (key: string) => new CodexAdapter({ binary, profileStateDir: dir, codexHome: dir, appServerMode: 'daemon', startupProvider: async () => ({ ...provider, env: { PROBE_API_KEY: key } }) }),
    adapter: new CodexAdapter({
      startupProvider: async () => provider,
      binary,
      profileStateDir: dir,
      codexHome: dir,
      appServerMode: 'daemon',
    }),
    runOptions(): AgentRunOptions {
      return {
        runId: 'daemon-run',
        cwd: dir,
        prompt: 'use daemon',
        model: 'probe-model',
        modelProvider: provider,
      };
    },
    async records(): Promise<Array<{ args: string[]; codexHome?: string }>> {
      return (await readFile(lifecycle, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    },
    requests,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const output: AgentEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

describe('Codex persistent app-server mode', () => {
  it('binds workflow credentials per thread and replaces them on resume without placing them in daemon arguments', async () => {
    const h = await harness();
    const first = { ...h.runOptions(), env: { LARK_WORKFLOW_TOKEN: 'turn-one-token', LARK_WORKFLOW_ENDPOINT: 'http://127.0.0.1:1234/workflow' } };
    await h.adapter.prepareRun(first);
    await collect(h.adapter.run(first).events);
    const second = { ...h.runOptions(), runId: 'resume', threadId: 'thread-1', env: { LARK_WORKFLOW_TOKEN: 'turn-two-token' } };
    await h.adapter.prepareRun(second);
    await collect(h.adapter.run(second).events);
    expect(h.requests.find(request => request.method === 'thread/start')?.params.config.shell_environment_policy.set).toEqual(first.env);
    expect(h.requests.find(request => request.method === 'thread/resume')?.params.config.shell_environment_policy.set).toEqual(second.env);
    expect(JSON.stringify(await h.records())).not.toContain('turn-one-token');
    expect(JSON.stringify(await h.records())).not.toContain('turn-two-token');
  });
  it('keeps the startup provider for a rejected switch and still completes the request', async () => {
    const h = await harness();
    const options = h.runOptions();
    options.modelProvider = { ...options.modelProvider!, id: 'other', displayName: 'Other', model: 'other-only-model', env: { OTHER_SECRET: 'do-not-load' } };
    options.model = 'other-only-model';
    await h.adapter.prepareRun(options);
    const events = await collect(h.adapter.run(options).events);
    expect(events).toContainEqual({ type: 'final_text', content: 'daemon result' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'status', code: 'provider-restart-required' }));
    expect(h.requests.find(r => r.method === 'thread/start')?.params).toMatchObject({ modelProvider: 'probe', model: 'probe-model' });
    expect(JSON.stringify(h.requests)).not.toContain('do-not-load');
    expect(await h.adapter.modelProviderState()).toMatchObject({ id: 'probe', displayName: 'Probe', fixedUntilRestart: true });
  });
  it('restarts its private daemon only when startup credentials change', async () => {
    const h = await harness();
    await h.adapter.prepareRun(h.runOptions());
    await h.restartAdapter('must-not-be-serialized').prepareRun(h.runOptions());
    await h.restartAdapter('rotated-private-key').prepareRun(h.runOptions());
    const records = await h.records();
    const commands = records.filter(record => record.args[1] === 'daemon');
    expect(commands.filter(record => record.args[2] === 'start')).toHaveLength(2);
    expect(commands.filter(record => record.args[2] === 'stop')).toHaveLength(1);
    expect(commands.every(record => record.codexHome === h.dir)).toBe(true);
    expect(JSON.stringify(records)).not.toContain('rotated-private-key');
  });
  it('starts the daemon once for concurrent preparation, then uses a per-run WebSocket connection', async () => {
    const h = await harness();
    const options = h.runOptions();

    await Promise.all([h.adapter.prepareRun(options), h.adapter.prepareRun(options)]);
    await h.adapter.prepareRun(options);
    const run = h.adapter.run(options);
    const events = await collect(run.events);

    expect(events).toContainEqual({ type: 'final_text', content: 'daemon result' });
    expect(events).toContainEqual({ type: 'done', threadId: 'thread-1', terminationReason: 'normal' });
    expect(await run.waitForExit(1000)).toBe(true);

    const records = await h.records();
    const daemonCommands = records
      .map(record => record.args)
      .filter(args => args[0] === 'app-server' && args[1] === 'daemon');
    expect(daemonCommands.filter(args => args[2] === 'start')).toHaveLength(1);
    expect(daemonCommands.some(args => args[2] === 'stop')).toBe(false);

    expect(records.some(record => record.args[1] === 'proxy')).toBe(process.platform === 'win32');
    const threadStart = h.requests.find(request => request.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      model: 'probe-model',
      modelProvider: 'probe',
      config: { shell_environment_policy: { inherit: 'all' } },
      approvalPolicy: 'never',
    });
    expect(JSON.stringify(threadStart?.params.config)).not.toContain('must-not-be-serialized');
    expect(JSON.stringify(threadStart?.params.config)).not.toContain('generate_memories');
    expect(records.filter(record => record.args[0] !== '--version').every(record => record.codexHome)).toBe(true);
    const config = await readFile(join(h.dir, 'config.toml'), 'utf8');
    expect(config).toContain('model_provider = \"probe\"');
    expect(config).not.toContain('must-not-be-serialized');
  });
});
