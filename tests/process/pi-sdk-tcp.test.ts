import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PiHostClient } from '../../src/agent/pi-sdk/host-client';
import type { AgentEvent } from '../../src/agent/types';

// A host the bridge cannot spawn (it belongs to a rented execution cell) is
// reached over a forwarded TCP port; the frames are the same as on stdio.

const fixture = fileURLToPath(new URL('../fixtures/pi-sdk/fake-tcp-host.mjs', import.meta.url));
const clients: PiHostClient[] = [];
const hosts: Array<import('node:child_process').ChildProcess> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.dispose();
  for (const host of hosts.splice(0)) {
    if (host.exitCode === null) {
      host.kill('SIGKILL');
      await once(host, 'exit').catch(() => {});
    }
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startHost(): Promise<number> {
  const port = await freePort();
  const host = spawn(process.execPath, [fixture], { env: { ...process.env, FAKE_TCP_HOST_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  hosts.push(host);
  await new Promise<void>((resolve, reject) => {
    host.stderr!.on('data', () => {});
    host.once('exit', (code) => reject(new Error(`fake tcp host exited with ${String(code)}`)));
    host.stdout!.setEncoding('utf8');
    host.stdout!.on('data', (chunk: string) => { if (chunk.includes('listening')) resolve(); });
  });
  return port;
}

// Opt-in: the real host needs the SDK entry and a Node >= 22.19 runtime.
const liveSdk = process.env.PI_SDK_LIVE_SDK;
const liveNode = process.env.PI_SDK_LIVE_NODE;
const hostScript = fileURLToPath(new URL('../../bin/pi-host.mjs', import.meta.url));

describe.skipIf(!liveSdk || !liveNode)('pi-host in TCP mode', () => {
  it('serves the protocol on a socket and shuts down on request', async () => {
    const port = await freePort();
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-host-tcp-'));
    const host = spawn(liveNode!, [hostScript, '--tcp', `127.0.0.1:${port}`, '--sdk', liveSdk!, '--agent-dir', agentDir],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    hosts.push(host);
    await new Promise<void>((resolve, reject) => {
      host.stderr!.setEncoding('utf8');
      host.stderr!.on('data', (chunk: string) => { if (chunk.includes('listening')) resolve(); });
      host.once('exit', (code) => reject(new Error(`pi-host exited with ${String(code)}`)));
    });

    const client = new PiHostClient({
      nodePath: liveNode!,
      hostScript,
      sdkPath: liveSdk!,
      agentDir,
      connection: { kind: 'tcp', host: '127.0.0.1', port },
    });
    clients.push(client);
    expect(await client.start()).toMatchObject({ transport: 'tcp' });
    expect(await client.request('health')).toMatchObject({ sessions: 0, activeRuns: 0, transport: 'tcp' });
    await client.dispose();
    // A disposed TCP client closes its socket; the host keeps serving until its
    // own idle reaper or a shutdown request — here we stop it ourselves.
    host.kill('SIGTERM');
    await once(host, 'exit').catch(() => {});
    await rm(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 60_000);
});

describe('PiHostClient over a TCP channel', () => {
  it('connects to a running host, requests, streams a run and disposes', async () => {
    const port = await startHost();
    const client = new PiHostClient({
      nodePath: process.execPath,
      hostScript: fixture,
      sdkPath: fixture,
      agentDir: '/fake',
      connection: { kind: 'tcp', host: '127.0.0.1', port },
    });
    clients.push(client);

    const ready = await client.start();
    expect(ready).toMatchObject({ transport: 'tcp', piVersion: 'fake' });
    expect(await client.request('health')).toMatchObject({ transport: 'tcp' });

    const opened = await client.request<{ sessionId: string }>('session.open', { cwd: '/tmp' });
    expect(opened.sessionId).toBe('tcp-session');

    const events: AgentEvent[] = [];
    const waitForEnd = new Promise<void>((resolve) => {
      client.onFrame((frame) => {
        if (frame.type === 'run.end') resolve();
        const event = frame.type === 'run.event' ? (frame.event as AgentEvent) : undefined;
        if (event) events.push(event);
      });
    });
    await client.request('run.prompt', { sessionId: 'tcp-session', runId: 'run-tcp', text: 'go' });
    await waitForEnd;

    expect(events).toEqual([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'OK' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }], stopReason: 'stop' } },
      { type: 'agent_settled', aborted: false },
    ]);
    await client.dispose();
    expect(client.isClosed).toBe(true);
  }, 30_000);

  it('reports an unreachable host instead of hanging', async () => {
    const port = await freePort();
    const client = new PiHostClient({
      nodePath: process.execPath,
      hostScript: fixture,
      sdkPath: fixture,
      agentDir: '/fake',
      readyTimeoutMs: 2_000,
      connection: { kind: 'tcp', host: '127.0.0.1', port },
    });
    clients.push(client);
    await expect(client.start()).rejects.toThrow(/ECONNREFUSED|accept a connection|not become ready/);
  }, 15_000);
});
