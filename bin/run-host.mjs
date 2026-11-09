#!/usr/bin/env node
// Owns one agent process on behalf of the bridge, in its own session, so a
// bridge restart neither closes the agent's stdin nor loses its output. Every
// byte the agent writes is journaled; a reattaching bridge replays it from the
// start, and the stdin journal tells it which requests were already answered.
//
// Frames in both directions: 1 type byte, 4 byte big-endian length, payload.
//   bridge -> host  a: attach {o, e} offsets   i: stdin bytes   c: close stdin   k: signal name
//   host -> bridge  o: stdout   e: stderr   r: replay done {stdinClosed}   x: exit {code, signal, error?}
import { closeSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import crossSpawn from 'cross-spawn';

const dir = process.argv[2];
if (!dir) process.exit(2);
const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
const socketPath = join(dir, 'sock');
const journals = { o: openSync(join(dir, 'stdout'), 'a+'), e: openSync(join(dir, 'stderr'), 'a+') };
const sizes = { o: 0, e: 0 };
const stdinJournal = openSync(join(dir, 'stdin'), 'a');
const orphanMs = Number(spec.orphanMs) > 0 ? Number(spec.orphanMs) : 24 * 60 * 60_000;
let client;
let detachedSince = Date.now();
let stdinClosed = false;
let exit;
let finished = false;

function frame(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload === undefined ? '' : JSON.stringify(payload));
  const header = Buffer.alloc(5);
  header.write(type, 0, 'latin1');
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function send(socket, type, payload) {
  if (socket && !socket.destroyed) socket.write(frame(type, payload));
}

// The agent leads its own process group so its MCP servers and tools are
// signalled with it; the host itself stays out of reach to record the exit.
const child = crossSpawn(spec.command, spec.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
writeFileSync(join(dir, 'host.json'), JSON.stringify({ pid: process.pid, childPid: child.pid ?? null, startedAt: Date.now() }));

function signalAgent(signal) {
  if (process.platform !== 'win32' && child.pid && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, signal); return; } catch { /* group already gone */ }
  }
  try { child.kill(signal); } catch {}
}

function output(type, chunk) {
  if (finished) return;
  writeSync(journals[type], chunk);
  sizes[type] += chunk.length;
  send(client, type, chunk);
}
child.stdout.on('data', chunk => output('o', chunk));
child.stderr.on('data', chunk => output('e', chunk));
child.stdin.on('error', () => {});

function attach(socket, offsets) {
  if (client && client !== socket) client.destroy();
  client = socket;
  for (const type of ['o', 'e']) {
    let position = Math.max(0, Number(offsets?.[type]) || 0);
    const buffer = Buffer.alloc(1 << 20);
    while (position < sizes[type]) {
      const read = readSync(journals[type], buffer, 0, Math.min(buffer.length, sizes[type] - position), position);
      if (read <= 0) break;
      send(socket, type, Buffer.from(buffer.subarray(0, read)));
      position += read;
    }
  }
  send(socket, 'r', { stdinClosed });
}

function receive(socket, type, payload) {
  if (type === 'a') attach(socket, JSON.parse(payload.toString('utf8') || '{}'));
  else if (socket !== client) return;
  else if (type === 'i') {
    if (stdinClosed || exit) return;
    writeSync(stdinJournal, payload);
    child.stdin.write(payload);
  } else if (type === 'c') {
    stdinClosed = true;
    child.stdin.end();
  } else if (type === 'k') {
    signalAgent(payload.toString('utf8') || 'SIGTERM');
  }
}

rmSync(socketPath, { force: true });
const server = createServer(socket => {
  let pending = Buffer.alloc(0);
  socket.on('data', chunk => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 5) {
      const length = pending.readUInt32BE(1);
      if (pending.length < 5 + length) break;
      receive(socket, pending.toString('latin1', 0, 1), pending.subarray(5, 5 + length));
      pending = pending.subarray(5 + length);
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    if (client !== socket) return;
    client = undefined;
    detachedSince = Date.now();
  });
});
server.listen(socketPath);

function finish() {
  if (finished || !exit) return;
  finished = true;
  // Written before the socket closes: a bridge that finds no host reads the result from here.
  try {
    writeFileSync(join(dir, 'exit.json.tmp'), JSON.stringify(exit));
    renameSync(join(dir, 'exit.json.tmp'), join(dir, 'exit.json'));
  } catch { /* the bridge already removed this run */ }
  for (const fd of [journals.o, journals.e, stdinJournal]) closeSync(fd);
  server.close();
  rmSync(socketPath, { force: true });
  const done = () => process.exit(0);
  if (client && !client.destroyed) {
    send(client, 'x', exit);
    client.end(done);
    setTimeout(done, 2000);
  } else done();
}

child.on('error', error => {
  exit ??= { code: null, signal: null, error: error.message };
  finish();
});
child.on('exit', (code, signal) => {
  exit ??= { code, signal };
  // A descendant that inherited stdout can keep the pipes open indefinitely.
  setTimeout(finish, 2000);
});
child.on('close', () => finish());

// Forward termination to the agent and exit with it; SIGHUP must not end the run.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => signalAgent('SIGTERM'));
}
process.on('SIGHUP', () => {});

// A run nobody reattaches to (bridge removed or down for a day) must not live forever.
setInterval(() => {
  if (client || exit || Date.now() - detachedSince < orphanMs) return;
  signalAgent('SIGTERM');
  setTimeout(() => signalAgent('SIGKILL'), 10_000);
}, 60_000);
