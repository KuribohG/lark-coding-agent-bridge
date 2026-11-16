#!/usr/bin/env node
// Scriptable stand-in for bin/pi-host.mjs used by tests/process/pi-sdk-adapter.test.ts.
// It speaks the same newline-delimited JSON protocol and records every request.
import { renameSync, writeFileSync } from 'node:fs';

const recordPath = process.env.FAKE_HOST_RECORD;
const record = { calls: [], argv: process.argv.slice(2) };
function save() {
  if (!recordPath) return;
  const next = recordPath + '.tmp';
  writeFileSync(next, JSON.stringify(record, null, 2));
  renameSync(next, recordPath);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const events = JSON.parse(process.env.FAKE_HOST_EVENTS ?? '[]');
const abortEvents = JSON.parse(process.env.FAKE_HOST_ABORT_EVENTS ?? '[]');
const eventDelayMs = Number(process.env.FAKE_HOST_EVENT_DELAY_MS ?? 30);
const holdMs = Number(process.env.FAKE_HOST_HOLD_MS ?? 0);
const openError = process.env.FAKE_HOST_OPEN_ERROR;
const promptError = process.env.FAKE_HOST_PROMPT_ERROR;
const exitAfterPrompt = process.env.FAKE_HOST_EXIT_AFTER_PROMPT === '1';

let sessionSeq = 0;
const timers = new Set();

function later(fn, ms) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, ms);
  timers.add(timer);
  return timer;
}

function emitRunEvents(sessionId, runId, list) {
  for (const event of list) send({ type: 'run.event', sessionId, runId, event });
}

function handle(request) {
  record.calls.push({ cmd: request.cmd, params: request.params ?? null });
  save();
  const params = request.params ?? {};
  switch (request.cmd) {
    case 'ping':
    case 'health':
      send({ id: request.id, ok: true, data: { sessions: 1, activeRuns: 0 } });
      return;
    case 'session.open':
      if (openError) {
        send({ id: request.id, ok: false, error: { message: openError } });
        return;
      }
      sessionSeq += 1;
      send({
        id: request.id,
        ok: true,
        data: {
          sessionId: params.forkFrom ? 'sess-fork' : params.sessionId ?? `sess-${sessionSeq}`,
          sessionFile: null,
          model: null,
        },
      });
      return;
    case 'run.prompt': {
      if (promptError) {
        send({ id: request.id, ok: false, error: { message: promptError } });
        return;
      }
      send({ id: request.id, ok: true, data: { sessionId: params.sessionId, runId: params.runId } });
      if (exitAfterPrompt) {
        later(() => process.exit(7), 10);
        return;
      }
      later(() => {
        emitRunEvents(params.sessionId, params.runId, events);
        later(() => send({
          type: 'run.end',
          sessionId: params.sessionId,
          runId: params.runId,
          outcome: 'settled',
        }), holdMs);
      }, eventDelayMs);
      return;
    }
    case 'run.steer':
      send({ id: request.id, ok: true, data: { disposition: 'queued' } });
      return;
    case 'run.abort':
      send({ id: request.id, ok: true, data: {} });
      emitRunEvents(params.sessionId, params.runId, abortEvents);
      send({
        type: 'run.end',
        sessionId: params.sessionId,
        runId: params.runId,
        outcome: 'aborted',
      });
      return;
    case 'session.dispose':
      send({ id: request.id, ok: true, data: { disposed: true } });
      return;
    case 'shutdown':
      send({ id: request.id, ok: true, data: {} });
      later(() => process.exit(0), 10);
      return;
    default:
      send({ id: request.id, ok: false, error: { message: `unknown command: ${request.cmd}` } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline === -1) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => {
  for (const timer of timers) clearTimeout(timer);
  process.exit(0);
});

// Sandbox probe: the test compares this under a Landlock domain with the same
// probe without one, so "blocked" cannot come from ordinary permissions.
const probeTarget = process.env.FAKE_HOST_PROBE_UNWRITABLE;
if (probeTarget) {
  try {
    writeFileSync(probeTarget, 'probe\n');
    record.probe = { blocked: false };
  } catch (error) {
    record.probe = { blocked: true, code: error.code };
  }
  save();
}

send({
  type: 'host.ready',
  data: {
    pid: process.pid,
    nodeVersion: process.versions.node,
    piVersion: 'fake',
    agentDir: paramsFromArgv('--agent-dir'),
    idleTtlMs: Number(paramsFromArgv('--idle-ttl-ms') ?? 0),
    maxSessions: Number(paramsFromArgv('--max-sessions') ?? 0),
    sessionPersistence: paramsFromArgv('--session-persistence') ?? 'file',
  },
});

function paramsFromArgv(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
