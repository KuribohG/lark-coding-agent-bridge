import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureLogger,
  closeLogger,
  flushLogger,
  log,
} from '../../../src/core/logger.js';

// Payload shapes that reach the logger through real failures: SDK errors over
// `responseType: 'stream'` endpoints carry the response stream (and through it
// the socket ↔ request cycle), while agent stderr can carry any object graph
// at all. Logging one of these must never throw — the previous unbounded
// traversal raised RangeError out of the logging call and killed the run.

let logsDir = '';

describe('logger payload safety', () => {
  beforeEach(async () => {
    logsDir = await mkdtemp(join(tmpdir(), 'logger-payload-'));
    configureLogger({
      logsDir,
      now: () => new Date('2026-05-25T12:00:00.000Z'),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeLogger();
    await rm(logsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });

  it('logs an axios-shaped error without throwing on its cyclic agent graph', async () => {
    const socket: Record<string, unknown> = { readyState: 'open' };
    const request: Record<string, unknown> = { socket };
    socket._httpMessage = request;
    const err = Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { socket, request } },
    });

    expect(() => log.fail('media', err, { fileKey: 'img_v3_example' })).not.toThrow();
    await flushLogger();

    const text = await readTodayLog();
    expect(text).toContain('"event":"fail"');
    expect(text).toContain('"apiStatus":400');
    expect(text).toContain('[CIRCULAR]');
  });

  it('caps traversal depth instead of recursing without bound', async () => {
    let deep: Record<string, unknown> = { leaf: 'bottom' };
    for (let i = 0; i < 200; i += 1) deep = { next: deep };

    expect(() => log.warn('agent', 'stderr', { deep })).not.toThrow();
    await flushLogger();

    const text = await readTodayLog();
    expect(text).toContain('[TRUNCATED_DEPTH]');
    expect(text).not.toContain('bottom');
  });

  it('describes streams and binary bodies instead of walking them', async () => {
    const stream = { on: () => undefined, pipe: () => undefined, socket: {} };
    expect(() =>
      log.warn('sdk', 'error', { stream, body: Buffer.from('binary-body') }),
    ).not.toThrow();
    await flushLogger();

    const text = await readTodayLog();
    expect(text).toContain('[STREAM]');
    expect(text).toContain('<binary 11b>');
  });

  it('caps arrays and object key counts', async () => {
    const wide = Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [`k${i}`, i]),
    );
    expect(() =>
      log.info('sdk', 'info', { items: Array.from({ length: 150 }, (_, i) => i), wide }),
    ).not.toThrow();
    await flushLogger();

    const text = await readTodayLog();
    expect(text).toContain('[...100 more]');
    expect(text).toContain('[50 more]');
  });

  it('does not throw when a payload getter throws', async () => {
    const hostile = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });

    expect(() => log.warn('agent', 'stderr', { hostile })).not.toThrow();
    await flushLogger();

    const text = await readTodayLog();
    expect(text).toContain('[UNREADABLE]');
  });

  it('redacts credentials embedded in url userinfo', async () => {
    log.warn('sdk', 'error', {
      args: ['proxy http://user-name:raw-password@proxy.example.com:3128 refused'],
    });
    await flushLogger();

    const text = await readTodayLog();
    expect(text).not.toContain('raw-password');
    expect(text).toContain('http://user-name:[REDACTED]@proxy.example.com:3128');
  });
});

async function readTodayLog(): Promise<string> {
  return readFile(join(logsDir, 'bridge-20260525.jsonl'), 'utf8');
}
