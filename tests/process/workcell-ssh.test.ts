import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSshWorkcell, SshWorkcellProvider } from '../../src/agent/pi-sdk/workcell-ssh';

// An ssh unit is a directory on another machine. The fake ssh runs the "remote"
// commands here and implements `-L`, so the provider's whole contract — copy in,
// run, forward, copy out, tear down — is exercised without a second host.

const fakeSsh = fileURLToPath(new URL('../fixtures/pi-sdk/fake-ssh-forward.mjs', import.meta.url));
const dirs: string[] = [];
const providers: SshWorkcellProvider[] = [];
let sshBin: string;

beforeEach(async () => {
  const bin = await realpath(await mkdtemp(join(tmpdir(), 'fake-ssh-')));
  dirs.push(bin);
  sshBin = join(bin, 'ssh');
  writeFileSync(sshBin, `#!/bin/sh\nexec '${process.execPath}' '${fakeSsh}' "$@"\n`, { mode: 0o700 });
  chmodSync(sshBin, 0o700);
});

afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});

async function harness() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ssh-cell-')));
  dirs.push(base);
  const provider = new SshWorkcellProvider({ destination: 'fake-node', base, ssh: sshBin });
  providers.push(provider);
  return { base, provider };
}

describe('ssh workcell provider', () => {
  it('parses the provider uri', () => {
    expect(parseSshWorkcell('ssh://node01/lark-cells')).toEqual({ destination: 'node01', base: '/lark-cells' });
    expect(parseSshWorkcell('ssh://me@node01:2222/home/me/cells/')).toEqual({
      destination: 'me@node01', port: 2222, base: '/home/me/cells',
    });
    expect(parseSshWorkcell('/opt/provider.py')).toBeUndefined();
    expect(() => parseSshWorkcell('ssh://node01')).toThrow(/directory for its units/);
  });

  it('creates a unit, copies files in, runs commands and tears it down', async () => {
    const h = await harness();
    const local = await realpath(await mkdtemp(join(tmpdir(), 'ssh-src-')));
    dirs.push(local);
    await writeFile(join(local, 'probe.txt'), 'hello\n');
    await mkdir(join(local, 'sub'));
    await writeFile(join(local, 'sub', 'nested.txt'), 'nested\n');

    const cell = await h.provider.request<{ workcell: string; root: string }>('create', {
      spec: { labels: { key: 'member-a' } },
    });
    expect(cell.root.startsWith(`${h.base}/`)).toBe(true);
    expect(existsSync(cell.root)).toBe(true);

    await h.provider.request('push', { workcell: cell.workcell, local, remote: `${cell.root}/work`, exclude: ['sub'] });
    // `sub` was excluded, the rest arrived.
    expect(readFileSync(join(cell.root, 'work', 'probe.txt'), 'utf8')).toBe('hello\n');
    expect(existsSync(join(cell.root, 'work', 'sub'))).toBe(false);

    const ran = await h.provider.request<{ code: number; stdout: string }>('exec', {
      workcell: cell.workcell,
      script: 'cat probe.txt',
      cwd: '/work',
      env: { MARKER: 'from-env' },
    });
    expect(ran.code).toBe(0);
    expect(ran.stdout.trim()).toBe('hello');

    const failed = await h.provider.request<{ code: number }>('exec', {
      workcell: cell.workcell, script: 'exit 3',
    });
    expect(failed.code).toBe(3);

    // Sessions come back after a run.
    await writeFile(join(cell.root, 'agent', 'session.jsonl'), '{"a":1}\n');
    const pulled = await realpath(await mkdtemp(join(tmpdir(), 'ssh-out-')));
    dirs.push(pulled);
    await h.provider.request('pull', { workcell: cell.workcell, remote: `${cell.root}/agent`, local: pulled });
    expect(readFileSync(join(pulled, 'session.jsonl'), 'utf8')).toBe('{"a":1}\n');

    // A missing directory is not an error.
    const empty = await h.provider.request<{ skipped?: boolean }>('pull', {
      workcell: cell.workcell, remote: `${cell.root}/nothing`, local: join(pulled, 'x'),
    });
    expect(empty.skipped).toBe(true);

    await h.provider.request('stop', { workcell: cell.workcell });
    expect(await waitFor(async () => !existsSync(cell.root), 5000)).toBe(true);
  }, 60_000);

  it('reaches a port inside the unit through the forwarded local port', async () => {
    const h = await harness();
    const cell = await h.provider.request<{ workcell: string; root: string }>('create', { spec: {} });

    // A server standing in for the host inside the unit.
    const remotePort = await freePort();
    const server = createServer((socket) => socket.end('pong\n'));
    server.listen(remotePort, '127.0.0.1');
    await once(server, 'listening');
    try {
      const forwarded = await h.provider.request<{ port: number }>('forward', {
        workcell: cell.workcell, remotePort,
      });
      const answer = await new Promise<string>((resolve, reject) => {
        const socket = connect(forwarded.port, '127.0.0.1');
        let data = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => { data += chunk; });
        socket.on('end', () => resolve(data));
        socket.on('error', reject);
      });
      expect(answer.trim()).toBe('pong');
      expect(forwarded.port).not.toBe(remotePort);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await h.provider.request('stop', { workcell: cell.workcell });
    }
  }, 60_000);

  it('ends a detached host when the unit is stopped', async () => {
    const h = await harness();
    const cell = await h.provider.request<{ workcell: string; root: string }>('create', { spec: {} });
    const marker = `larkcell-sleep-${Date.now()}`;
    await h.provider.request('exec', {
      workcell: cell.workcell,
      script: `exec -a ${marker} sleep 30`,
      detach: true,
    });
    const alive = () => spawnSyncProbe(['pgrep', '-f', marker]).trim().length > 0;
    expect(await waitFor(alive, 5000)).toBe(true);
    await h.provider.request('stop', { workcell: cell.workcell });
    // The whole process group must go with the unit.
    expect(await waitFor(async () => !alive(), 8000)).toBe(true);
  }, 60_000);

  it('refuses unknown ops and unknown units', async () => {
    const h = await harness();
    await expect(h.provider.request('exec', { workcell: 'nope', script: 'true' })).rejects.toThrow(/unknown workcell/);
    await expect(h.provider.request('magic' as never, {})).rejects.toThrow(/does not implement/);
  });
});

/** Polls a predicate; the suite runs on a loaded box, so allow a window. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** pgrep exits 1 when nothing matches; that is the "not alive" answer. */
function spawnSyncProbe(argv: string[]): string {
  try {
    return execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
