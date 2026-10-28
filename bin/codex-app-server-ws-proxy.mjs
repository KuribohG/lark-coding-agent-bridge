#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import net from 'node:net';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write('usage: codex-app-server-ws-proxy.mjs <unix-socket-path>\n');
  process.exit(2);
}

let physicalSocketPath;
try {
  physicalSocketPath = realpathSync(socketPath);
} catch (error) {
  process.stderr.write(`failed to resolve app-server socket: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

let closing = false;
const pending = [];
const ws = new WebSocket('ws://localhost/', {
  createConnection: () => net.createConnection({ path: physicalSocketPath }),
  maxPayload: 128 * 1024 * 1024,
});

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

ws.on('open', flush);
ws.on('message', (data, isBinary) => {
  if (!isBinary) process.stdout.write(`${data.toString()}\n`);
});
ws.on('unexpected-response', (_request, response) => {
  process.stderr.write(`app-server WebSocket upgrade failed with HTTP ${response.statusCode}\n`);
  process.exit(1);
});
ws.on('error', error => {
  process.stderr.write(`app-server WebSocket failed: ${error.message}\n`);
  process.exitCode = 1;
});
ws.on('close', () => {
  input.close();
  process.exit();
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    closing = true;
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
    else process.exit();
  });
}
