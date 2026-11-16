import { chmodSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiSdkAdapter } from '../../src/agent/pi-sdk/adapter';
import type { AgentEvent } from '../../src/agent/types';
import type { PiConfig } from '../../src/agent/pi/config';

// A workcell profile keeps one host per workflow member inside a rented unit,
// reached over the port the provider forwards. The fake provider hands out a
// port where this test serves the fake host, so the whole path is exercised:
// provision → push → start host in the unit → TCP host protocol.

vi.mock('../../src/agent/preflight', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/agent/preflight')>(),
  checkAgentAvailability: vi.fn(async () => ({ ok: true as const, version: 'v22.23.3' })),
}));

const providerFixture = fileURLToPath(new URL('../fixtures/pi-sdk/fake-workcell-provider.mjs', import.meta.url));
const tcpHostFixture = fileURLToPath(new URL('../fixtures/pi-sdk/fake-tcp-host.mjs', import.meta.url));
const fakeHost = fileURLToPath(new URL('../fixtures/pi-sdk/fake-host.mjs', import.meta.url));

const adapters: PiSdkAdapter[] = [];
const dirs: string[] = [];
const hosts: Array<import('node:child_process').ChildProcess> = [];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.shutdown();
  for (const host of hosts.splice(0)) {
    if (host.exitCode === null) host.kill('SIGKILL');
    await once(host, 'exit').catch(() => {});
  }
  delete process.env.FAKE_WORKCELL_RECORD;
  delete process.env.FAKE_WORKCELL_HOST_PORT;
  delete process.env.FAKE_TCP_RECORD;
  delete process.env.FAKE_TCP_IPC;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});

async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startTcpHost(): Promise<number> {
  const port = await freePort();
  const host = spawn(process.execPath, [tcpHostFixture], {
    env: { ...process.env, FAKE_TCP_HOST_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hosts.push(host);
  await new Promise<void>((resolve, reject) => {
    host.stderr!.on('data', () => {});
    host.once('exit', (code) => reject(new Error(`fake tcp host exited with ${String(code)}`)));
    host.stdout!.setEncoding('utf8');
    host.stdout!.on('data', (chunk: string) => { if (chunk.includes('listening')) resolve(); });
  });
  return port;
}

async function harness(options: { workflowEndpoint?: string; tcpIpc?: boolean } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-workcell-')));
  dirs.push(dir);
  const record = join(dir, 'provider-record.json');
  const tcpRecord = join(dir, 'tcp-host-record.json');
  // The host fixture reads its mode from the environment at startup.
  Object.assign(process.env, {
    FAKE_WORKCELL_RECORD: record,
    FAKE_TCP_RECORD: tcpRecord,
    ...(options.tcpIpc ? { FAKE_TCP_IPC: '1' } : { FAKE_TCP_IPC: '0' }),
  });
  const hostPort = await startTcpHost();
  const agentDir = join(dir, 'agent');
  await mkdir(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'auth.json'), '{"token":"t"}');
  const provider = join(dir, 'provider.sh');
  writeFileSync(provider, `#!/bin/sh\nexec '${process.execPath}' '${providerFixture}' "$@"\n`, { mode: 0o700 });
  chmodSync(provider, 0o700);
  process.env.FAKE_WORKCELL_HOST_PORT = String(hostPort);

  // A realistic launcher layout: only the basenames are assumed by the layout.
  const runtime = join(dir, 'rt');
  const nodePath = join(runtime, 'node_modules', 'node', 'bin', 'node');
  const packageDir = join(runtime, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const sdkPath = join(packageDir, 'dist', 'index.js');
  const hostScript = join(dir, 'bin', 'pi-host.mjs');
  for (const file of [nodePath, sdkPath, join(packageDir, 'package.json'), hostScript]) {
    await mkdir(dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  const config: PiConfig = {
    binaryPath: join(dir, 'pi'),
    transport: 'sdk',
    sdkPath,
    nodePath,
    hostScript,
    agentDir,
    workcell: { provider, cpu: 4, memoryGb: 8, ttlSeconds: 600 },
  };
  const adapter = new PiSdkAdapter({ config, systemPrompt: 'WORKCELL', profileStateDir: dir, stopGraceMs: 1000 });
  adapters.push(adapter);
  return {
    dir,
    adapter,
    hostPort,
    async tcpRecord(): Promise<{ requests: Array<{ cmd: string; params: any }>; ipcResponse?: Record<string, unknown> }> {
      return JSON.parse(await readFile(tcpRecord, 'utf8'));
    },
    async calls(): Promise<Array<Record<string, unknown>>> {
      try {
        return JSON.parse(await readFile(record, 'utf8'));
      } catch {
        return [];
      }
    },
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

describe('pi SDK host inside a workcell', () => {
  it('provisions one unit per member, starts the host there and reuses it across turns', async () => {
    const h = await harness();
    const host = { key: 'member-aaaaaaaa' };
    const first = await collect((await h.adapter.prepareRun({
      runId: 'run-1', prompt: 'go', cwd: h.dir, host,
    })).start().events);
    expect(first.find((event) => event.type === 'final_text')).toEqual({ type: 'final_text', content: 'OK' });
    // The bridge keeps the conversation's own cwd even though the host works in
    // the cell's copy of it.
    expect(first.find((event) => event.type === 'system')).toMatchObject({ cwd: h.dir });
    expect(first.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });

    const second = await collect((await h.adapter.prepareRun({
      runId: 'run-2', prompt: 'again', cwd: h.dir, host, sessionId: 'tcp-session',
    })).start().events);
    expect(second.at(-1)).toMatchObject({ type: 'done' });

    const calls = await h.calls();
    expect(calls.filter((call) => call.op === 'create')).toHaveLength(1);
    // One exec unpacks the runtime archive, one starts the host.
    expect(calls.filter((call) => call.op === 'exec')).toHaveLength(2);
    const extraction = calls.find((call) => String(call.script ?? '').startsWith('tar -xzf')) as { script: string } | undefined;
    expect(extraction?.script).toContain('/opt/lark-workcell/runtime.tar.gz');
    // The heavy runtime travels as one archive, not as a directory push.
    expect(calls.filter((call) => call.op === 'push').map((call) => call.remote)).toContain('/opt/lark-workcell/runtime.tar.gz');
    expect(calls.filter((call) => call.op === 'push').map((call) => call.remote)).not.toContain('/opt/lark-workcell/node_modules');
    // The host is started inside the unit with the cell-local paths and a TCP listener.
    const exec = calls.find((call) => call.op === 'exec' && String(call.script ?? '').includes('--tcp')) as { script: string; env: Record<string, string> } | undefined;
    expect(exec?.script).toBe(
      "exec '/opt/lark-workcell/node_modules/node/bin/node' '/opt/lark-workcell/bin/pi-host.mjs' " +
      "'--tcp' ':47811' '--ipc-port' '47812' " +
      "'--sdk' '/opt/lark-workcell/node_modules/@earendil-works/pi-coding-agent/dist/index.js' " +
      "'--agent-dir' '/opt/lark-workcell/agent'",
    );
    expect(exec?.env).toMatchObject({ PI_TELEMETRY: '0', PI_CODING_AGENT_DIR: '/opt/lark-workcell/agent' });
    // Credentials are pushed once, sessions stay inside the unit, and the run
    // workspace is copied in so the host has a directory that exists there.
    const pushes = calls.filter((call) => call.op === 'push');
    expect(pushes.map((call) => call.remote)).toEqual(expect.arrayContaining([
      '/opt/lark-workcell/agent/auth.json',
      '/opt/lark-workcell/work',
    ]));
    const workspace = pushes.find((call) => call.remote === '/opt/lark-workcell/work');
    expect(workspace).toMatchObject({ local: h.dir });
    expect(workspace?.exclude).toEqual(expect.arrayContaining(['.git', 'node_modules']));

    await h.adapter.shutdown();
    expect((await h.calls()).filter((call) => call.op === 'stop')).toHaveLength(1);
  }, 60_000);

  it('proxies workflow calls from the unit to the bridge endpoint and keeps sessions out of the unit', async () => {
    // A stand-in for the bridge's own workflow endpoint.
    const engine = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        engineCalls.push({
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ok: true, result: { taskCounts: { running: 1 } } }));
      });
    });
    const engineCalls: Array<{ url?: string; authorization?: string; body: unknown }> = [];
    engine.listen(0, '127.0.0.1');
    await once(engine, 'listening');
    const enginePort = (engine.address() as { port: number }).port;

    const h = await harness({ tcpIpc: true, workflowEndpoint: `http://127.0.0.1:${enginePort}/workflow` });
    const host = { key: 'member-bbbbbbbb' };
    const events = await collect((await h.adapter.prepareRun({
      runId: 'run-1',
      prompt: 'go',
      cwd: h.dir,
      host,
      env: {
        AGENT_WORKFLOW_TOKEN: 'token-abc',
        AGENT_WORKFLOW_ENDPOINT: `http://127.0.0.1:${enginePort}/workflow`,
        AGENT_WORKFLOW_CLI: '/bridge/dist/workflow-cli.js',
        AGENT_WORKFLOW_ENDPOINT_FILE: '/bridge/workflows.sqlite.endpoint.json',
      },
    })).start().events);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    await vi.waitFor(() => expect(engineCalls).toHaveLength(1));

    // The bridge performed the call itself, with the worker's token.
    expect(engineCalls[0]).toMatchObject({
      url: '/workflow',
      authorization: 'Bearer token-abc',
      body: { method: 'status', args: { list: 'all' } },
    });

    // The host answered the HTTP caller with the engine's body.
    const record = await h.tcpRecord();
    expect(record.ipcResponse).toMatchObject({ type: 'ipc.response', requestId: 99, status: 200 });
    expect(JSON.parse(String((record.ipcResponse as { body: string }).body))).toEqual({ ok: true, result: { taskCounts: { running: 1 } } });

    // Inside the unit the run points at the cell-local endpoint and pushed CLI.
    const prompt = record.requests.find((call) => call.cmd === 'run.prompt');
    expect(prompt?.params.runEnv).toMatchObject({
      AGENT_WORKFLOW_ENDPOINT: 'http://127.0.0.1:47812/workflow',
      AGENT_WORKFLOW_CLI: '/opt/lark-workcell/bin/workflow-cli.js',
      AGENT_WORKFLOW_TOKEN: 'token-abc',
    });
    expect(prompt?.params.runEnv.AGENT_WORKFLOW_ENDPOINT_FILE).toBeUndefined();

    // Sessions are archived outside the unit before it is torn down.
    await h.adapter.shutdown();
    const calls = await h.calls();
    expect(calls.find((call) => call.op === 'pull')).toMatchObject({
      remote: '/opt/lark-workcell/agent/sessions',
      local: join(h.dir, 'workcell-sessions', 'member-bbbbbbbb'),
    });
    await new Promise<void>((resolve) => engine.close(() => resolve()));
  }, 60_000);

  it('fails the profile preflight when the provider executable is missing', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-workcell-')));
    dirs.push(dir);
    const adapter = new PiSdkAdapter({
      config: {
        binaryPath: join(dir, 'pi'),
        transport: 'sdk',
        sdkPath: fakeHost,
        nodePath: process.execPath,
        hostScript: fakeHost,
        agentDir: join(dir, 'agent'),
        workcell: { provider: join(dir, 'missing-provider') },
      },
      profileStateDir: dir,
    });
    adapters.push(adapter);
    expect(await adapter.checkAvailability()).toMatchObject({ ok: false });
  });
});
