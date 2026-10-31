import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { terminateChild } from '../../src/platform/terminate';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(rejectUpgrade = false) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-ws-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const http = createServer((_req, res) => { res.writeHead(403); res.end(); });
  const server = rejectUpgrade ? undefined : new WebSocketServer({ server: http });
  server?.on('connection', socket => socket.on('message', data => socket.send(data.toString())));
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address() as { port: number };
  cleanups.push(async () => {
    for (const socket of server?.clients ?? []) socket.terminate();
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  const record = join(dir, 'args.json');
  const script = join(dir, 'native proxy.cjs');
  const binary = join(dir, process.platform === 'win32' ? 'codex fixture.cmd' : 'codex fixture');
  await writeFile(script, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));
if (process.env.CODEX_TEST_PROXY_EXIT) {
  process.stderr.write('fixture native proxy failure\\n');
  process.exit(Number(process.env.CODEX_TEST_PROXY_EXIT));
}
const socket = require('node:net').connect(${address.port}, '127.0.0.1');
process.stdin.pipe(socket).pipe(process.stdout);
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
`);
  await writeFile(binary, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`);
  await chmod(binary, 0o700);
  return { binary, record, server };
}

function start(socket: string, binary: string, env = process.env) {
  const child = spawn(process.execPath, [join(process.cwd(), 'bin/codex-app-server-ws-proxy.mjs'), socket, binary], {
    stdio: ['pipe', 'pipe', 'pipe'], env,
  });
  const exited = new Promise<number | null>(resolve => child.once('close', resolve));
  cleanups.push(async () => { terminateChild(child); await exited; });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, exited, stderr: () => stderr };
}

async function echo(child: ChildProcessWithoutNullStreams, payload: string) {
  const lines = createInterface({ input: child.stdout });
  try {
    const response = once(lines, 'line');
    child.stdin.write(`${payload}\n`);
    return (await response)[0];
  } finally { lines.close(); }
}

describe('Codex native byte proxy WebSocket transport', () => {
  it('carries the upgrade and large Unicode frames, preserves Windows paths, and reconnects to the same daemon', async () => {
    const h = await fixture();
    const socketPath = 'C:\\用户 & workspace\\app-server-control\\app-server-control.sock';
    const payload = JSON.stringify({ id: 1, text: '消息🙂'.repeat(25_000) });
    for (let i = 0; i < 2; i++) {
      const run = start(socketPath, h.binary);
      expect(await echo(run.child, payload)).toBe(payload);
      run.child.stdin.end();
      expect(await run.exited).toBe(0);
      expect(run.stderr()).toBe('');
    }
    expect(JSON.parse(await readFile(h.record, 'utf8'))).toEqual(['app-server', 'proxy', '--sock', socketPath]);
  });

  it('reports a missing native binary and exits without hanging', async () => {
    const h = await fixture();
    const run = start('C:\\missing.sock', `${h.binary}-missing`);
    expect(await run.exited).toBe(1);
    expect(run.stderr()).toContain('app-server WebSocket failed');
    expect(run.stderr()).not.toContain('Unhandled');
  });

  it('reports an HTTP upgrade rejection and closes the native proxy', async () => {
    const h = await fixture(true);
    const run = start('C:\\daemon.sock', h.binary);
    expect(await run.exited).toBe(1);
    expect(run.stderr()).toContain('HTTP 403');
  });

  it('preserves native proxy errors and exits unsuccessfully', async () => {
    const h = await fixture();
    const run = start('C:\\daemon.sock', h.binary, { ...process.env, CODEX_TEST_PROXY_EXIT: '7' });
    expect(await run.exited).toBe(1);
    expect(run.stderr()).toContain('fixture native proxy failure');
  });

  it('stops its connection without stopping the daemon', async () => {
    const h = await fixture();
    const run = start('C:\\daemon.sock', h.binary);
    expect(await echo(run.child, '{}')).toBe('{}');
    terminateChild(run.child);
    await run.exited;
    const next = start('C:\\daemon.sock', h.binary);
    expect(await echo(next.child, '{"next":true}')).toBe('{"next":true}');
    next.child.stdin.end();
    expect(await next.exited).toBe(0);
  });
});
