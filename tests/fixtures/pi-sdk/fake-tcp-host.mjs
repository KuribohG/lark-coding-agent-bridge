#!/usr/bin/env node
// Stand-in for `pi-host --tcp`, used by tests/process/pi-sdk-tcp.test.ts.
// It speaks the same newline-delimited frames as the real host and echoes a
// single text delta per prompt.
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

const port = Number(process.env.FAKE_TCP_HOST_PORT);
if (!port) {
  console.error('FAKE_TCP_HOST_PORT is required');
  process.exit(2);
}

const send = (socket, message) => socket.write(`${JSON.stringify(message)}\n`);

// Optional record so a test can assert what the host was told and what came
// back for a workflow call it proxied.
const recordPath = process.env.FAKE_TCP_RECORD;
const state = { requests: [], ipcResponse: undefined };
function save() {
  if (recordPath) writeFileSync(recordPath, JSON.stringify(state, null, 2));
}
save();

const server = createServer((socket) => {
  send(socket, {
    type: 'host.ready',
    data: { pid: process.pid, nodeVersion: process.versions.node, piVersion: 'fake', agentDir: '/fake', idleTtlMs: 0, maxSessions: 1, sessionPersistence: 'memory', transport: 'tcp' },
  });
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      if (request.type === 'ipc.response') {
        state.ipcResponse = request;
        save();
        continue;
      }
      if (request.cmd) {
        state.requests.push({ cmd: request.cmd, params: request.params ?? null });
        save();
      }
      switch (request.cmd) {
        case 'health':
          send(socket, { id: request.id, ok: true, data: { sessions: 0, transport: 'tcp' } });
          break;
        case 'session.open':
          send(socket, { id: request.id, ok: true, data: { sessionId: 'tcp-session', sessionFile: null, model: null } });
          break;
        case 'run.prompt':
          send(socket, { id: request.id, ok: true, data: { sessionId: 'tcp-session', runId: request.params.runId } });
          send(socket, { type: 'run.event', sessionId: 'tcp-session', runId: request.params.runId,
            event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'OK' } } });
          send(socket, { type: 'run.event', sessionId: 'tcp-session', runId: request.params.runId,
            event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }], stopReason: 'stop' } } });
          send(socket, { type: 'run.event', sessionId: 'tcp-session', runId: request.params.runId,
            event: { type: 'agent_settled', aborted: false } });
          send(socket, { type: 'run.end', sessionId: 'tcp-session', runId: request.params.runId, outcome: 'settled' });
          if (process.env.FAKE_TCP_IPC === '1') {
            send(socket, { type: 'ipc.request', requestId: 99, token: request.params.runEnv?.AGENT_WORKFLOW_TOKEN ?? '', method: 'status', args: { list: 'all' } });
          }
          break;
        case 'shutdown':
          send(socket, { id: request.id, ok: true, data: {} });
          socket.end();
          server.close();
          setTimeout(() => process.exit(0), 10);
          break;
        default:
          send(socket, { id: request.id, ok: false, error: `unknown command: ${request.cmd}` });
      }
    }
  });
  socket.on('error', () => {});
});

server.listen(port, '127.0.0.1', () => console.log('listening'));
