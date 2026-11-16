#!/usr/bin/env node
/**
 * cell-host: runs one agent CLI inside a rented execution cell and serves it
 * over a single TCP connection, so the bridge can drive a process it cannot
 * spawn. It knows nothing about which agent it runs.
 *
 * The framed channel (one JSON object per line) carries both the process and the
 * workflow calls a tool makes inside the cell:
 *
 *   bridge -> host  {id, op:'spawn', argv, cwd?, env?, files?}   {id, ok, data:{pid}}
 *                   {id, op:'stdin'|'close'|'signal'|'kill', ...}
 *                   {type:'ipc.response', requestId, status, body}
 *   host -> bridge  {type:'out'|'err', data}   {type:'exit', code, signal}
 *                   {type:'ipc.request', requestId, token, method, args}
 *
 * `files` lets the bridge hand over the small per-run files an agent expects
 * (a system prompt, an MCP config) without a separate transfer.
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const options = parseArguments(process.argv.slice(2));
if (!options.port) {
  console.error('cell-host: --port is required');
  process.exit(2);
}

/** Logs go to stderr; stdout stays free for whoever starts this process. */
function log(message, fields) {
  process.stderr.write(`[cell-host] ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}\n`);
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) throw new Error(`invalid cell-host argument: ${flag ?? '(empty)'}`);
    parsed[flag.slice(2)] = value;
  }
  return parsed;
}

let socket;
let child;
let childPid;
let pendingIpc = new Map();
let ipcSeq = 1;

function send(frame) {
  if (socket && !socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
}

function reply(id, ok, payload) {
  if (!ok) {
    send({ id, ok: false, error: typeof payload === 'string' ? payload : String(payload) });
    return;
  }
  send({ id, ok: true, ...(payload === undefined ? {} : { data: payload }) });
}

function writeFiles(files) {
  for (const file of files ?? []) {
    const path = resolve(String(file.path));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(file.content ?? ''), { mode: 0o600 });
  }
}

function handleSpawn(id, request) {
  if (child) {
    reply(id, false, 'a process is already running in this cell');
    return;
  }
  const argv = Array.isArray(request.argv) ? request.argv.map(String) : [];
  if (argv.length === 0) {
    reply(id, false, 'spawn requires argv');
    return;
  }
  try {
    writeFiles(request.files);
  } catch (error) {
    reply(id, false, `cannot write run files: ${error.message}`);
    return;
  }
  const proc = spawn(argv[0], argv.slice(1), {
    cwd: request.cwd ? resolve(String(request.cwd)) : undefined,
    env: { ...process.env, ...(request.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child = proc;
  childPid = proc.pid;
  proc.stdout.on('data', chunk => send({ type: 'out', data: chunk.toString('utf8') }));
  proc.stderr.on('data', chunk => send({ type: 'err', data: chunk.toString('utf8') }));
  proc.stdin.on('error', () => {});
  // Acknowledge on `spawn`, not immediately: an exec failure must be reported
  // as the failure it is, and the bridge still needs an exit for its child.
  let acknowledged = false;
  proc.once('spawn', () => {
    acknowledged = true;
    reply(id, true, { pid: proc.pid ?? null });
  });
  proc.on('error', (error) => {
    child = undefined;
    childPid = undefined;
    if (!acknowledged) {
      // The rejected spawn is the whole report: the bridge turns it into its own
      // exit, so sending an exit frame here would race that path.
      reply(id, false, `cannot start the agent: ${error.message}`);
      return;
    }
    send({ type: 'err', data: `${error.message}\n` });
    send({ type: 'exit', code: 1, signal: null });
  });
  proc.on('exit', (code, signal) => {
    send({ type: 'exit', code, signal });
    child = undefined;
    childPid = undefined;
  });
}

function handle(id, request) {
  switch (request.op) {
    case 'ping':
      reply(id, true, { pid: childPid ?? null });
      return;
    case 'spawn':
      handleSpawn(id, request);
      return;
    case 'stdin':
      if (!child) { reply(id, false, 'no process is running'); return; }
      child.stdin.write(String(request.data ?? ''));
      reply(id, true, {});
      return;
    case 'close':
      child?.stdin.end();
      reply(id, true, {});
      return;
    case 'signal':
      if (!child) { reply(id, false, 'no process is running'); return; }
      child.kill(String(request.signal ?? 'SIGTERM'));
      reply(id, true, {});
      return;
    case 'kill':
      if (!child) { reply(id, false, 'no process is running'); return; }
      child.kill('SIGKILL');
      reply(id, true, {});
      return;
    default:
      reply(id, false, `unknown op: ${String(request.op)}`);
  }
}

function settleIpc(frame) {
  const resolveAnswer = pendingIpc.get(frame.requestId);
  pendingIpc.delete(frame.requestId);
  resolveAnswer?.(frame);
}

function askBridge(payload, timeoutMs = 30_000) {
  return new Promise((resolveAnswer, rejectAnswer) => {
    const requestId = ipcSeq++;
    const timer = setTimeout(() => {
      pendingIpc.delete(requestId);
      rejectAnswer(new Error('the bridge did not answer the workflow call in time'));
    }, timeoutMs);
    pendingIpc.set(requestId, (frame) => {
      clearTimeout(timer);
      resolveAnswer(frame);
    });
    send({ type: 'ipc.request', requestId, ...payload });
  });
}

/** Same POST shape and bearer token as the bridge's endpoint, forwarded as frames. */
function serveIpc(port) {
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/workflow') {
      response.statusCode = 404;
      response.end('{}');
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      response.statusCode = 400;
      response.end(JSON.stringify({ ok: false, error: 'expected a JSON body' }));
      return;
    }
    try {
      const answer = await askBridge({
        token: (request.headers.authorization ?? '').replace(/^Bearer /, ''),
        method: body.method,
        args: body.args,
      });
      response.statusCode = Number.isInteger(answer.status) ? answer.status : 200;
      response.setHeader('Content-Type', 'application/json');
      response.end(typeof answer.body === 'string' && answer.body ? answer.body : JSON.stringify({ ok: false, error: 'empty answer from the bridge' }));
    } catch (error) {
      response.statusCode = 502;
      response.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    }
  });
  server.listen(Number(port), () => log('ipc proxy listening', { port }));
}

const server = createNetServer((connection) => {
  if (socket && !socket.destroyed) {
    // One bridge at a time; a reconnect replaces the previous channel.
    log('replacing the previous channel');
    socket.destroy();
  }
  socket = connection;
  connection.setEncoding('utf8');
  log('bridge connected', { remote: `${connection.remoteAddress}:${connection.remotePort}` });
  let buffer = '';
  connection.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        log('ignoring malformed frame', { line: line.slice(0, 200) });
        continue;
      }
      if (frame && frame.type === 'ipc.response') { settleIpc(frame); continue; }
      if (frame && typeof frame.id === 'number') { handle(frame.id, frame); continue; }
      log('ignoring unexpected frame', { frame: JSON.stringify(frame).slice(0, 200) });
    }
  });
  connection.on('close', () => {
    log('bridge disconnected; stopping the agent');
    if (child) child.kill('SIGTERM');
    socket = undefined;
  });
  connection.on('error', () => {});
});

// Listen on every interface: the forwarded connection arrives on the cell's own
// address, which may be IPv6 only.
server.listen(Number(options.port), () => log('listening', { port: options.port }));
if (options['ipc-port']) serveIpc(options['ipc-port']);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    child?.kill('SIGTERM');
    process.exit(0);
  });
}
