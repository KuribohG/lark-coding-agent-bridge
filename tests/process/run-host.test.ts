import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import { startAppServerRun } from '../../src/agent/codex/app-server';
import { WebSocketServer } from 'ws';
import {
  newRunHostKey,
  probeRunHost,
  readRunHostInput,
  removeRunHost,
  terminateRunHost,
} from '../../src/agent/run-host';
import type { AgentEvent, AgentRun } from '../../src/agent/types';
import { createTmpProfile, type TmpProfile } from '../helpers/tmp-profile';

// A stream-json agent that waits for files the test creates, so a run can be
// detached and reattached while it is provably still the same process.
const FAKE_CLAUDE = `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const dir = process.env.FAKE_DIR;
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
writeFileSync(dir + '/agent.pid', String(process.pid));
out({ type: 'system', subtype: 'init', session_id: 'sess-host' });
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' },
  { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'true' } }] } });
const uuids = [];
let asked = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(dir + '/stdin.log', line + '\\n');
  const message = JSON.parse(line);
  if (message.type === 'user') {
    uuids.push(message.uuid);
    out({ type: 'user', isReplay: true, uuid: message.uuid, message: message.message });
  }
});
process.stdin.on('end', () => { appendFileSync(dir + '/stdin.log', 'EOF\\n'); process.exit(0); });
const timer = setInterval(() => {
  if (existsSync(dir + '/ask') && !asked) {
    asked = true;
    out({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion',
      input: { questions: [{ question: 'Pick?', options: [{ label: 'A' }, { label: 'B' }] }] } } });
  }
  if (existsSync(dir + '/release')) {
    clearInterval(timer);
    out({ type: 'result', subtype: 'success', result: 'finished after restart', session_id: 'sess-host', user_message_uuids: uuids });
  }
}, 20);
`;

// Appended to FAKE_CLAUDE: a long-lived tool process, like an MCP server.
const WITH_TOOL = `
import { spawn } from 'node:child_process';
const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(dir + '/tool.pid', String(tool.pid));
`;

// A minimal per-run Codex app-server speaking JSON-RPC over stdio.
const FAKE_CODEX = `
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const dir = process.env.FAKE_DIR;
if (process.argv.includes('--version')) { console.log('codex-cli 999.0.0'); process.exit(0); }
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let released = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(dir + '/stdin.log', line + '\\n');
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'thread/start') out({ id: m.id, result: { thread: { id: 'thread-1' } } });
  else if (m.method === 'turn/start') {
    out({ id: m.id, result: { turn: { id: 'turn-1' } } });
    out({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
  } else if (m.method === 'turn/steer') out({ id: m.id, result: { turnId: 'turn-1' } });
  else out({ id: m.id, result: {} });
});
process.stdin.on('end', () => process.exit(0));
const timer = setInterval(() => {
  if (released || !existsSync(dir + '/release')) return;
  released = true;
  clearInterval(timer);
  out({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1',
    item: { type: 'agentMessage', id: 'msg-1', text: 'codex finished after restart' } } });
  out({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
}, 20);
`;

describe.skipIf(process.platform === 'win32')('run host', () => {
  let tmp: TmpProfile;
  let previousRoot: string | undefined;
  const keys: string[] = [];

  beforeEach(async () => {
    tmp = await createTmpProfile('run-host-');
    previousRoot = process.env.LARK_RUN_HOST_DIR;
    process.env.LARK_RUN_HOST_DIR = join(tmp.root, 'hosts');
  });

  afterEach(async () => {
    for (const key of keys.splice(0)) await terminateRunHost(key, 500);
    if (previousRoot === undefined) delete process.env.LARK_RUN_HOST_DIR;
    else process.env.LARK_RUN_HOST_DIR = previousRoot;
    await tmp.cleanup();
  });

  async function fakeAgent(source: string): Promise<string> {
    const path = join(tmp.root, 'fake-agent.mjs');
    await writeFile(path, `#!${process.execPath}\n${source}`, { mode: 0o700 });
    return path;
  }

  function claude(binary: string) {
    return new ClaudeAdapter({ binary, env: { FAKE_DIR: tmp.root } });
  }

  async function start(adapter: ClaudeAdapter | CodexAdapter, key: string, attach = false, extra: object = {}) {
    keys.push(key);
    return (await adapter.prepareRun({ runId: 'hosted', prompt: 'hosted prompt', cwd: tmp.workspace,
      host: { key, ...(attach ? { attach: true } : {}) }, ...extra })).start();
  }

  async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error('condition not reached');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  async function next(iterator: AsyncIterator<AgentEvent>, type: AgentEvent['type']): Promise<AgentEvent> {
    for (;;) {
      const result = await iterator.next();
      if (result.done) throw new Error(`stream ended before ${type}`);
      if (result.value.type === type) return result.value;
    }
  }

  async function drain(run: AgentRun): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);
    return events;
  }

  function alive(pid: number): boolean {
    try { process.kill(pid, 0); } catch { return false; }
    // An orphan the container's init has not reaped yet is already dead.
    try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'; } catch { return true; }
  }

  it('keeps a Claude run alive across a shutdown and replays it to the next bridge process', async () => {
    const adapter = claude(await fakeAgent(FAKE_CLAUDE));
    const key = newRunHostKey();
    const first = await start(adapter, key);
    expect(first.detachOnShutdown).toBe(true);
    const iterator = first.events[Symbol.asyncIterator]();
    await next(iterator, 'tool_use');
    await first.stop('shutdown');
    const tail: AgentEvent[] = [];
    for (let result = await iterator.next(); !result.done; result = await iterator.next()) tail.push(result.value);
    expect(tail.at(-1)).toEqual({ type: 'done', terminationReason: 'interrupted' });

    const pid = Number(await readFile(join(tmp.root, 'agent.pid'), 'utf8'));
    expect(alive(pid)).toBe(true);
    expect(await probeRunHost(key)).toBe('running');

    const second = await start(adapter, key, true);
    const replay = second.events[Symbol.asyncIterator]();
    expect(await next(replay, 'system')).toMatchObject({ sessionId: 'sess-host' });
    expect(await next(replay, 'text')).toEqual({ type: 'text', delta: 'working' });
    // Input acknowledgements arrive on the event stream, so keep consuming it.
    const rest: AgentEvent[] = [];
    const consumed = (async () => {
      for (let result = await replay.next(); !result.done; result = await replay.next()) rest.push(result.value);
    })();
    expect(await second.sendInput!({ text: 'added after restart', messageId: 'om-2' }))
      .toMatchObject({ status: 'accepted' });
    await writeFile(join(tmp.root, 'release'), '');
    await consumed;
    expect(rest).toContainEqual({ type: 'final_text', content: 'finished after restart' });
    expect(rest.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    expect(await second.waitForExit(5000)).toBe(true);

    const stdin = (await readFile(join(tmp.root, 'stdin.log'), 'utf8')).trim().split('\n');
    // The prompt reached the agent once; only the follow-up came from the second process.
    expect(stdin.filter(line => line.includes('hosted prompt'))).toHaveLength(1);
    expect(stdin.filter(line => line.includes('added after restart'))).toHaveLength(1);
    expect(stdin.at(-1)).toBe('EOF');
    expect(await probeRunHost(key)).toBe('exited');
  }, 20_000);

  it('delivers a turn that completed while no bridge was attached', async () => {
    const adapter = claude(await fakeAgent(FAKE_CLAUDE));
    const key = newRunHostKey();
    const first = await start(adapter, key);
    await next(first.events[Symbol.asyncIterator](), 'tool_use');
    await first.stop('shutdown');
    await writeFile(join(tmp.root, 'release'), '');
    // Like claude -p, the agent then waits for stdin to close, which only a bridge does.
    await until(async () => (await readFile(join(process.env.LARK_RUN_HOST_DIR!, key, 'stdout'), 'utf8'))
      .includes('finished after restart'));

    const second = await start(adapter, key, true);
    const events = await drain(second);
    expect(events).toContainEqual({ type: 'final_text', content: 'finished after restart' });
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    await until(async () => await probeRunHost(key) === 'exited');

    // Once the agent has exited, a later attach replays the journals alone.
    const third = await start(adapter, key, true);
    expect(await drain(third)).toContainEqual({ type: 'final_text', content: 'finished after restart' });
  }, 20_000);

  it('asks an unanswered question again after reattaching, but never an answered one', async () => {
    const adapter = claude(await fakeAgent(FAKE_CLAUDE));
    const key = newRunHostKey();
    await writeFile(join(tmp.root, 'ask'), '');
    const first = await start(adapter, key, false, { userQuestions: true });
    const iterator = first.events[Symbol.asyncIterator]();
    expect(await next(iterator, 'user_input')).toMatchObject({ id: 'q1' });
    await first.stop('shutdown');

    const second = await start(adapter, key, true, { userQuestions: true });
    const replay = second.events[Symbol.asyncIterator]();
    expect(await next(replay, 'user_input')).toMatchObject({ id: 'q1' });
    expect(await second.answerUserInput!('q1', { answers: [['A']] })).toBe('accepted');
    await second.stop('shutdown');
    // The host journals socket input asynchronously; the answer may land after the bridge detaches.
    await until(async () => readRunHostInput(key).some(line => line.includes('control_response')));
    expect(readRunHostInput(key).filter(line => line.includes('control_response'))).toHaveLength(1);

    const third = await start(adapter, key, true, { userQuestions: true });
    await writeFile(join(tmp.root, 'release'), '');
    const events = await drain(third);
    expect(events.filter(event => event.type === 'user_input')).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    expect(readRunHostInput(key).filter(line => line.includes('control_response'))).toHaveLength(1);
  }, 20_000);

  it('stops the hosted agent for every reason other than shutdown', async () => {
    const adapter = claude(await fakeAgent(FAKE_CLAUDE));
    const key = newRunHostKey();
    const run = await start(adapter, key);
    await next(run.events[Symbol.asyncIterator](), 'tool_use');
    const pid = Number(await readFile(join(tmp.root, 'agent.pid'), 'utf8'));
    await run.stop('cancelled');
    await until(() => !alive(pid));
    await until(async () => await probeRunHost(key) === 'exited');
  }, 20_000);

  it('stops the processes a hosted agent started along with it', async () => {
    const adapter = claude(await fakeAgent(FAKE_CLAUDE + WITH_TOOL));
    const key = newRunHostKey();
    const run = await start(adapter, key);
    await next(run.events[Symbol.asyncIterator](), 'tool_use');
    await until(() => existsSync(join(tmp.root, 'tool.pid')));
    const tool = Number(await readFile(join(tmp.root, 'tool.pid'), 'utf8'));
    try {
      expect(alive(tool)).toBe(true);
      await run.stop('cancelled');
      await until(() => !alive(tool));
    } finally {
      try { process.kill(tool, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 20_000);

  it('reattaches a Codex app-server turn without repeating its requests', async () => {
    const binary = await fakeAgent(FAKE_CODEX);
    const adapter = new CodexAdapter({ binary, profileStateDir: tmp.profile, appServerMode: 'per-run', env: { FAKE_DIR: tmp.root } });
    const key = newRunHostKey();
    const first = await start(adapter, key);
    expect(first.detachOnShutdown).toBe(true);
    const iterator = first.events[Symbol.asyncIterator]();
    await next(iterator, 'system');
    await until(async () => (await readFile(join(tmp.root, 'stdin.log'), 'utf8').catch(() => '')).includes('turn/start'));
    await first.stop('shutdown');
    expect((await readFile(join(tmp.root, 'stdin.log'), 'utf8'))).not.toContain('turn/interrupt');

    const second = await start(adapter, key, true);
    const replay = second.events[Symbol.asyncIterator]();
    expect(await next(replay, 'system')).toMatchObject({ threadId: 'thread-1' });
    const rest: AgentEvent[] = [];
    const consumed = (async () => {
      for (let result = await replay.next(); !result.done; result = await replay.next()) rest.push(result.value);
    })();
    await until(async () => (await second.sendInput!({ text: 'steer after restart', messageId: 'om-3' })).status === 'accepted');
    await writeFile(join(tmp.root, 'release'), '');
    await consumed;
    expect(rest).toContainEqual({ type: 'final_text', content: 'codex finished after restart' });
    expect(rest.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });

    const requests = (await readFile(join(tmp.root, 'stdin.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.filter(request => request.method === 'initialize')).toHaveLength(1);
    expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
    const ids = requests.filter(request => typeof request.id === 'number').map(request => request.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 20_000);

  it('enforces a timed run deadline inside the host, also while detached', async () => {
    const adapter = claude(await fakeAgent(FAKE_CLAUDE));
    const key = newRunHostKey();
    const deadlineAt = Date.now() + 1500;
    const first = await start(adapter, key, false, { deadlineAt });
    await next(first.events[Symbol.asyncIterator](), 'tool_use');
    await first.stop('shutdown');
    const pid = Number(await readFile(join(tmp.root, 'agent.pid'), 'utf8'));
    await until(() => !alive(pid));
    await until(async () => await probeRunHost(key) === 'exited');
    const events = await drain(await start(adapter, key, true, { deadlineAt }));
    expect(events.at(-1)).toEqual({ type: 'done', terminationReason: 'timeout' });
  }, 20_000);

  it('keeps a Codex daemon connection open inside the host across a detach', async () => {
    // A stand-in for the daemon's Unix WebSocket; it counts connections to prove the turn never reconnects.
    const socketPath = join(tmp.root, 'daemon.sock');
    const http = createServer();
    const daemon = new WebSocketServer({ server: http });
    let connections = 0;
    let client: import('ws').WebSocket | undefined;
    const received: Array<{ id?: number; method?: string }> = [];
    daemon.on('connection', (socket) => {
      connections++;
      client = socket;
      socket.on('message', (data) => {
        const m = JSON.parse(data.toString()) as { id?: number; method?: string };
        received.push(m);
        const reply = (value: object) => socket.send(JSON.stringify(value));
        if (m.id === undefined) return;
        if (m.method === 'thread/start') reply({ id: m.id, result: { thread: { id: 'thread-d' } } });
        else if (m.method === 'turn/start') {
          reply({ id: m.id, result: { turn: { id: 'turn-d' } } });
          reply({ method: 'turn/started', params: { threadId: 'thread-d', turn: { id: 'turn-d' } } });
        } else reply({ id: m.id, result: {} });
      });
    });
    http.listen(socketPath);
    await once(http, 'listening');
    try {
      const key = newRunHostKey();
      keys.push(key);
      const runInput = (attach: boolean) => ({ binary: 'codex', env: process.env, sandbox: 'danger-full-access',
        appServerMode: 'daemon' as const, ...(attach ? {} : { daemonSocketPath: socketPath }), prompt: 'daemon prompt', stopGraceMs: 1000,
        opts: { runId: 'daemon', prompt: 'daemon prompt', cwd: tmp.workspace, host: { key, ...(attach ? { attach: true } : {}) } } });
      const first = startAppServerRun(runInput(false));
      await next(first.events[Symbol.asyncIterator](), 'system');
      await until(() => received.some(m => m.method === 'turn/start'));
      await first.stop('shutdown');
      expect(received.some(m => m.method === 'turn/interrupt')).toBe(false);

      const second = startAppServerRun(runInput(true));
      const replay = second.events[Symbol.asyncIterator]();
      expect(await next(replay, 'system')).toMatchObject({ threadId: 'thread-d' });
      client!.send(JSON.stringify({ method: 'item/completed', params: { threadId: 'thread-d', turnId: 'turn-d',
        item: { type: 'agentMessage', id: 'msg-d', text: 'daemon turn finished' } } }));
      client!.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-d', turn: { id: 'turn-d', status: 'completed' } } }));
      const rest: AgentEvent[] = [];
      for (let result = await replay.next(); !result.done; result = await replay.next()) rest.push(result.value);
      expect(rest).toContainEqual({ type: 'final_text', content: 'daemon turn finished' });
      expect(connections).toBe(1);
      expect(received.filter(m => m.method === 'initialize')).toHaveLength(1);
    } finally {
      for (const socket of daemon.clients) socket.terminate();
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  }, 20_000);

  it('terminates and removes a host nobody will reattach to', async () => {
    const adapter = claude(await fakeAgent(FAKE_CLAUDE));
    const key = newRunHostKey();
    const run = await start(adapter, key);
    await next(run.events[Symbol.asyncIterator](), 'tool_use');
    await run.stop('shutdown');
    const pid = Number(await readFile(join(tmp.root, 'agent.pid'), 'utf8'));
    await terminateRunHost(key, 2000);
    await until(() => !alive(pid));
    expect(await probeRunHost(key)).toBe('missing');
    expect(existsSync(join(process.env.LARK_RUN_HOST_DIR!, key))).toBe(false);
    removeRunHost(key);
  }, 20_000);
});
