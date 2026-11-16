import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CellChild, CellConnection } from '../../src/agent/cell/client';
import { readJsonLines } from '../../src/agent/jsonl';

// `cell-host` is the generic in-cell entry: it spawns the agent the bridge
// cannot spawn and relays its stdio plus the workflow calls a tool makes. These
// cases run it locally, which exercises the same frames a rented cell carries.

const cellHost = fileURLToPath(new URL('../../bin/cell-host.mjs', import.meta.url));
const hosts: Array<import('node:child_process').ChildProcess> = [];
const children: CellChild[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const host of hosts.splice(0)) {
    if (host.exitCode === null) host.kill('SIGKILL');
    await once(host, 'exit').catch(() => {});
  }
});

async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startCell(options: { ipc?: boolean } = {}): Promise<{ port: number; ipcPort?: number }> {
  const port = await freePort();
  const ipcPort = options.ipc ? await freePort() : undefined;
  const host = spawn(process.execPath, [
    cellHost, '--port', String(port), ...(ipcPort ? ['--ipc-port', String(ipcPort)] : []),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  hosts.push(host);
  await new Promise<void>((resolve, reject) => {
    host.stderr!.setEncoding('utf8');
    host.stderr!.on('data', (chunk: string) => { if (chunk.includes('listening')) resolve(); });
    host.once('exit', (code) => reject(new Error(`cell-host exited with ${String(code)}`)));
  });
  return { port, ...(ipcPort ? { ipcPort } : {}) };
}

/** An agent-shaped program: JSON lines in, JSON lines out. */
const echoAgent = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\\n');
    if (newline === -1) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    if (line === 'quit') { console.log(JSON.stringify({ bye: true })); process.exit(0); }
    console.log(JSON.stringify({ echo: line }));
  }
});
process.stdin.on('end', () => process.exit(0));
`;

describe('cell-host process channel', () => {
  it('runs the agent, relays its stdout/stderr and reports the exit', async () => {
    const cell = await startCell();
    const child = new CellChild({ host: '127.0.0.1', port: cell.port }, {
      argv: [process.execPath, '-e', echoAgent],
    });
    children.push(child);
    expect(child.pid).toBeUndefined();

    const lines: string[] = [];
    const reading = (async () => {
      for await (const line of readJsonLines(child.stdout)) lines.push(line);
    })();
    child.stdin.write('hello\n');
    child.stdin.write('quit\n');

    const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    await reading;
    expect(code).toBe(0);
    expect(child.exitCode).toBe(0);
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ echo: 'hello' }, { bye: true }]);
  }, 30_000);

  it('writes the run files before the agent starts and honours cwd', async () => {
    const cell = await startCell();
    const { mkdtemp, readFile, realpath } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'cell-run-')));
    const promptPath = join(dir, 'prompt.md');
    const agentFile = join(dir, 'agent.mjs');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(agentFile, `import { readFileSync } from 'node:fs';
console.log(JSON.stringify({ prompt: readFileSync(${JSON.stringify(promptPath)}, 'utf8'), cwd: process.cwd(), env: process.env.CELL_MARKER ?? null }));
`);

    const child = new CellChild({ host: '127.0.0.1', port: cell.port, files: [{ path: promptPath, content: '系统提示' }] }, {
      argv: [process.execPath, agentFile],
      cwd: dir,
      env: { CELL_MARKER: 'marker' },
    });
    children.push(child);
    const lines: string[] = [];
    const reading = (async () => {
      for await (const line of readJsonLines(child.stdout)) lines.push(line);
    })();
    await once(child, 'exit');
    await reading;

    expect(JSON.parse(lines[0]!)).toEqual({ prompt: '系统提示', cwd: dir, env: 'marker' });
    expect(await readFile(promptPath, 'utf8')).toBe('系统提示');
  }, 30_000);

  it('kills the agent on request', async () => {
    const cell = await startCell();
    const child = new CellChild({ host: '127.0.0.1', port: cell.port }, {
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    });
    children.push(child);
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill('SIGKILL');
    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    expect(code === null || code !== 0 || signal === 'SIGKILL').toBe(true);
  }, 30_000);

  it('reports an agent that cannot start', async () => {
    const cell = await startCell();
    const child = new CellChild({ host: '127.0.0.1', port: cell.port }, {
      argv: ['/definitely/missing/agent-binary'],
    });
    children.push(child);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    // Wait for the stream to end too: the reason is written before the exit is
    // emitted, but a PassThrough delivers it on a later tick.
    const ended = once(child.stderr, 'end');
    const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    await ended;
    expect(code).toBe(1);
    expect(stderr).toMatch(/cannot start the agent/);
  }, 30_000);
});

describe('cell-host workflow proxy', () => {
  it('carries a tool’s workflow call to the bridge and back', async () => {
    const cell = await startCell({ ipc: true });

    // One channel, like the bridge has: spawn the agent through the same
    // connection that answers its workflow calls.
    const connection = await CellConnection.connect({ host: '127.0.0.1', port: cell.port });
    const calls: Array<{ token?: string; method?: unknown; args?: unknown }> = [];
    const out: string[] = [];
    connection.onFrame((frame) => {
      if (frame.type === 'out') out.push(String(frame.data ?? ''));
      if (frame.type !== 'ipc.request') return;
      calls.push(frame);
      connection.send({
        type: 'ipc.response',
        requestId: frame.requestId,
        status: 200,
        body: JSON.stringify({ ok: true, result: { taskCounts: { running: 1 } } }),
      });
    });

    const script = `fetch('http://127.0.0.1:${cell.ipcPort}/workflow', {
      method: 'POST',
      headers: { authorization: 'Bearer token-xyz', 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'status', args: { list: 'all' } }),
    }).then(async (response) => {
      console.log(JSON.stringify({ status: response.status, body: await response.json() }));
    });`;
    await connection.request('spawn', { argv: [process.execPath, '-e', script] });
    await new Promise<void>((resolve) => {
      const stop = connection.onFrame((frame) => {
        if (frame.type === 'exit') { stop(); resolve(); }
      });
    });

    expect(calls).toEqual([expect.objectContaining({ token: 'token-xyz', method: 'status', args: { list: 'all' } })]);
    expect(JSON.parse(out.join('').trim())).toEqual({ status: 200, body: { ok: true, result: { taskCounts: { running: 1 } } } });
    await connection.close();
  }, 30_000);
});
