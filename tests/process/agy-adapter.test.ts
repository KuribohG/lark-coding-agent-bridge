import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AgyAdapter } from '../../src/agent/agy/adapter';
import type { AgentEvent } from '../../src/agent/types';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const initial = { event: 'init', conversation_id: 'native-session', init: {} };
const completed = { event: 'result', result: { status: 'SUCCESS', conversation_id: 'native-session', response: 'answer' } };

async function fixture(body: string, version = '1.4.10') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agy-adapter-'))); dirs.push(dir);
  const binary = join(dir, 'agy');
  await writeFile(binary, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(join(dir, 'request.json'))}, JSON.stringify({ argv, input, env: process.env.LARK_CHANNEL_PROFILE }));
  ${body}
});
`);
  await chmod(binary, 0o755);
  return { dir, binary, options: { runId: 'run', cwd: dir, prompt: '/model literal-user-input', sandbox: 'danger-full-access' as const } };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

describe('Antigravity process contract', () => {
  it('uses one stdin turn, resumes the exact session, carries host context and drains trailing stdout', async () => {
    const h = await fixture(`emit(${JSON.stringify(initial)}); emit(${JSON.stringify(completed)});
      setTimeout(() => process.stdout.write('x'.repeat(200000), () => process.exit(0)), 30);`);
    const adapter = new AgyAdapter({ binary: h.binary, systemPrompt: identity => 'Host identity: ' + identity?.openId,
      env: { LARK_CHANNEL_PROFILE: 'isolated-profile' } });
    adapter.setBotIdentity({ openId: 'bot-id' });
    await adapter.prepareRun(h.options);
    const run = adapter.run({ ...h.options, sessionId: 'parent-id', model: 'gemini-future-high', reasoningEffort: 'high', images: ['/private/image.png'] });
    expect(run.capabilities).toEqual({ input: 'unsupported', finalAnswer: 'separate-event' });
    expect(await collect(run.events)).toContainEqual({ type: 'final_text', content: 'answer' });
    expect(await run.waitForExit(1000)).toBe(true);
    const record = JSON.parse(await readFile(join(h.dir, 'request.json'), 'utf8'));
    expect(record.argv).toEqual(expect.arrayContaining(['--conversation', 'parent-id', '--model', 'gemini-future-high', '--effort', 'high', '--disable-slash-commands']));
    expect(record.argv).not.toContain(h.options.prompt);
    const request = JSON.parse(record.input);
    expect(request.event).toBe('user');
    expect(request.message.content).toContain('Host identity: bot-id');
    expect(request.message.content).toContain('/private/image.png');
    expect(request.message.content).toContain(h.options.prompt);
    expect(record.env).toBe('isolated-profile');
  });

  it('stops an active native turn and reports interruption', async () => {
    const h = await fixture(`emit(${JSON.stringify(initial)}); process.on('SIGINT', () => process.exit(0)); setInterval(() => {}, 1000);`);
    const run = new AgyAdapter({ binary: h.binary }).run(h.options);
    const events = run.events[Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({ type: 'system' });
    await run.stop();
    expect(await collect({ [Symbol.asyncIterator]: () => events })).toEqual([
      { type: 'done', sessionId: 'native-session', terminationReason: 'interrupted' },
    ]);
    expect(await run.waitForExit(1000)).toBe(true);
  });

  it('enforces the independent deadline on a silent process', async () => {
    const h = await fixture('setInterval(() => {}, 1000);');
    const run = new AgyAdapter({ binary: h.binary }).run({ ...h.options, deadlineAt: Date.now() + 200 });
    expect(await collect(run.events)).toEqual([{ type: 'done', sessionId: undefined, terminationReason: 'timeout' }]);
    expect(await run.waitForExit(1000)).toBe(true);
  });

  it.each([['process.stdout.write("bad-json\\n");', 'invalid JSON'], ['', 'without a result']])('fails closed for broken native output', async (body, message) => {
    const h = await fixture(body);
    const run = new AgyAdapter({ binary: h.binary }).run(h.options);
    expect(await collect(run.events)).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining(message) })]);
    expect(await run.waitForExit(1000)).toBe(true);
  });

  it('rejects an older CLI before executing a task', async () => {
    const h = await fixture('', '1.3.0');
    await expect(new AgyAdapter({ binary: h.binary }).prepareRun(h.options)).rejects.toMatchObject({ code: 'agent-version-unsupported' });
  });

  it('rejects unsupported security modes, forks and invalid stored conversation identifiers', () => {
    const adapter = new AgyAdapter();
    const options = { runId: 'run', prompt: 'hello', cwd: '/repo' };
    expect(() => adapter.run({ ...options, sandbox: 'read-only' })).toThrow('cannot guarantee');
    expect(() => adapter.run({ ...options, sandbox: 'workspace-write' })).toThrow('cannot guarantee');
    expect(() => adapter.run({ ...options, forkSession: true })).toThrow('forks');
    expect(() => adapter.run({ ...options, sessionId: '--invalid' })).toThrow('conversation ID');
  });
});
