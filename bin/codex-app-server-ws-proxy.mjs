#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { Duplex } from 'node:stream';
import crossSpawn from 'cross-spawn';
import WebSocket from 'ws';

const socketPath = process.argv[2];
const nativeBinary = process.argv[3];
if (!socketPath) {
  process.stderr.write('usage: codex-app-server-ws-proxy.mjs <unix-socket-path> [codex-binary]\n');
  process.exit(2);
}

let physicalSocketPath = socketPath;
try {
  // Let Codex resolve Windows paths itself, including junctions and device paths.
  if (!nativeBinary) physicalSocketPath = realpathSync(socketPath);
} catch (error) {
  process.stderr.write(`failed to resolve app-server socket: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

let closing = false;
let nativeProxy;
let nativeProxyStopped = false;
const pending = [];
function stopNativeProxy() {
  if (nativeProxyStopped || !nativeProxy?.pid) return;
  nativeProxyStopped = true;
  if (nativeProxy.exitCode !== null || nativeProxy.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Kill the tree while the .cmd launcher still owns its native child.
    crossSpawn.sync('taskkill.exe', ['/PID', String(nativeProxy.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: 5000,
    });
  } else nativeProxy.kill();
}

function connectNativeProxy() {
  // Node/libuv treats Windows pipe paths as named pipes, not AF_UNIX sockets.
  // Codex's proxy carries raw bytes, including the HTTP upgrade and WS frames.
  nativeProxy = crossSpawn(nativeBinary, ['app-server', 'proxy', '--sock', socketPath], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const socket = Duplex.from({ readable: nativeProxy.stdout, writable: nativeProxy.stdin });
  nativeProxy.stderr.pipe(process.stderr, { end: false });
  nativeProxy.on('error', error => socket.destroy(error));
  nativeProxy.on('exit', (code, signal) => {
    if (code !== 0) socket.destroy(new Error(`Codex socket proxy exited (${signal ?? code})`));
  });
  socket.on('close', stopNativeProxy);
  return socket;
}
const ws = new WebSocket('ws://localhost/', {
  createConnection: nativeBinary ? connectNativeProxy : () => net.createConnection({ path: physicalSocketPath }),
  maxPayload: 128 * 1024 * 1024,
});
const connectTimer = setTimeout(() => {
  process.stderr.write('app-server WebSocket connection timed out\n');
  process.exitCode = 1;
  ws.terminate();
}, 15_000);

const flush = () => {
  if (ws.readyState !== WebSocket.OPEN) return;
  for (const line of pending.splice(0)) ws.send(line);
  if (closing) ws.close();
};

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (ws.readyState === WebSocket.OPEN) ws.send(line);
  else if (ws.readyState === WebSocket.CONNECTING) pending.push(line);
  else process.exitCode = 1;
});
input.on('close', () => {
  closing = true;
  flush();
});

ws.on('open', () => {
  clearTimeout(connectTimer);
  flush();
});
ws.on('message', (data, isBinary) => {
  if (!isBinary) process.stdout.write(`${data.toString()}\n`);
});
ws.on('unexpected-response', (_request, response) => {
  process.stderr.write(`app-server WebSocket upgrade failed with HTTP ${response.statusCode}\n`);
  process.exitCode = 1;
  ws.terminate();
});
ws.on('error', error => {
  process.stderr.write(`app-server WebSocket failed: ${error.message}\n`);
  process.exitCode = 1;
});
ws.on('close', () => {
  clearTimeout(connectTimer);
  input.close();
  stopNativeProxy();
  nativeProxy?.stdin.destroy();
  nativeProxy?.stdout.destroy();
  process.exit();
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    closing = true;
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
    else process.exit();
  });
}
