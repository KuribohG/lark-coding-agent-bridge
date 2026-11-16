#!/usr/bin/env node
// Stand-in for a workcell provider, used by tests/process/workcell.test.ts.
// It records every request, answers with plausible handles, and streams one log
// frame so tests can see unsolicited frames too.
import { writeFileSync } from 'node:fs';

const recordPath = process.env.FAKE_WORKCELL_RECORD;
const calls = [];

function save() {
  if (recordPath) writeFileSync(recordPath, JSON.stringify(calls, null, 2));
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let seq = 0;
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline === -1) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    calls.push(request);
    save();
    switch (request.op) {
      case 'create': {
        seq += 1;
        send({ id: request.id, ok: true, data: { workcell: `cell-${seq}` } });
        send({ type: 'log', workcell: `cell-${seq}`, line: 'created' });
        break;
      }
      case 'push':
      case 'pull':
        if (process.env.FAKE_WORKCELL_PUSH_FAILURE === request.remote) {
          send({ id: request.id, ok: false, error: `cannot push ${request.remote}` });
          break;
        }
        send({ id: request.id, ok: true, data: {} });
        break;
      case 'forward':
        send({ id: request.id, ok: true, data: { port: Number(process.env.FAKE_WORKCELL_HOST_PORT ?? 40000 + seq) } });
        break;
      case 'exec':
        send({ id: request.id, ok: true, data: { pid: 1000 + seq } });
        break;
      case 'ttl':
        send({ id: request.id, ok: true, data: {} });
        break;
      case 'stop':
        send({ id: request.id, ok: true, data: {} });
        break;
      default:
        send({ id: request.id, ok: false, error: `unknown op: ${request.op}` });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
