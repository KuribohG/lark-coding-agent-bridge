import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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
  const binary = join(dir, 'codex');
  const daemonState = join(dir, 'daemon-running');
  const lifecycle = join(dir, 'lifecycle.jsonl');
  const socketPath = join(dir, 'app.sock');
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

  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const args = process.argv.slice(2);
const record = value => fs.appendFileSync(${JSON.stringify(lifecycle)}, JSON.stringify(value) + '\\n');
record({ args, codexHome: process.env.CODEX_HOME });
if (args[0] === '--version') {
  process.stdout.write('codex 0.162.1\\n');
  process.exit(0);
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
  await chmod(binary, 0o700);

  return {
    dir,
    adapter: new CodexAdapter({
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
        modelProvider: {
          id: 'probe',
          displayName: 'Probe',
          model: 'probe-model',
          env: { PROBE_API_KEY: 'must-not-be-serialized' },
          codex: {
            providerId: 'probe-provider',
            name: 'Probe Provider',
            baseUrl: 'https://probe.example/v1',
            wireApi: 'responses',
            apiKeyEnv: 'PROBE_API_KEY',
          },
        },
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

    expect(records.some(record => record.args[1] === 'proxy')).toBe(false);
    const threadStart = h.requests.find(request => request.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      model: 'probe-model',
      modelProvider: 'probe-provider',
      config: {
        shell_environment_policy: { inherit: 'all' },
        model_providers: {
          'probe-provider': {
            name: 'Probe Provider',
            base_url: 'https://probe.example/v1',
            wire_api: 'responses',
            env_key: 'PROBE_API_KEY',
          },
        },
      },
      approvalPolicy: 'never',
    });
    expect(JSON.stringify(threadStart?.params.config)).not.toContain('must-not-be-serialized');
    expect(JSON.stringify(threadStart?.params.config)).not.toContain('generate_memories');
    expect(records.every(record => record.codexHome)).toBe(true);
  });
});
