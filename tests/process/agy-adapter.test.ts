import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AgyAdapter } from '../../src/agent/agy/adapter';
import type { AgentEvent } from '../../src/agent/types';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }))); });
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
    const run = (await adapter.prepareRun({ ...h.options, sessionId: 'parent-id', model: 'gemini-future-high', reasoningEffort: 'high', images: ['/private/image.png'] })).start();
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
    const run = (await new AgyAdapter({ binary: h.binary }).prepareRun(h.options)).start();
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
    const run = (await new AgyAdapter({ binary: h.binary }).prepareRun({ ...h.options, deadlineAt: Date.now() + 200 })).start();
    expect(await collect(run.events)).toEqual([{ type: 'done', sessionId: undefined, terminationReason: 'timeout' }]);
    expect(await run.waitForExit(1000)).toBe(true);
  });

  it.each([['process.stdout.write("bad-json\\n");', 'invalid JSON'], ['', 'without a result']])('fails closed for broken native output', async (body, message) => {
    const h = await fixture(body);
    const run = (await new AgyAdapter({ binary: h.binary }).prepareRun(h.options)).start();
    expect(await collect(run.events)).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining(message) })]);
    expect(await run.waitForExit(1000)).toBe(true);
  });

  it('rejects an older CLI before executing a task', async () => {
    const h = await fixture('', '1.3.0');
    await expect(new AgyAdapter({ binary: h.binary }).prepareRun(h.options)).rejects.toMatchObject({ code: 'agent-version-unsupported' });
  });

  it('maps read-only, workspace-write, and danger-full-access sandboxes cleanly and rejects unsafe modes', async () => {
    const readOnlyH = await fixture(`emit(${JSON.stringify(initial)}); emit(${JSON.stringify(completed)});`);
    const readOnlyRun = (await new AgyAdapter({ binary: readOnlyH.binary }).prepareRun({
      ...readOnlyH.options, sandbox: 'read-only',
    })).start();
    await collect(readOnlyRun.events);
    await readOnlyRun.waitForExit(1000);
    const readOnlyRecord = JSON.parse(await readFile(join(readOnlyH.dir, 'request.json'), 'utf8'));
    expect(readOnlyRecord.argv).toContain('--mode');
    expect(readOnlyRecord.argv[readOnlyRecord.argv.indexOf('--mode') + 1]).toBe('plan');
    expect(readOnlyRecord.argv).not.toContain('--dangerously-skip-permissions');
    expect(readOnlyRecord.argv).not.toContain('--sandbox');
    const readOnlySettings = JSON.parse(readOnlyRecord.argv[readOnlyRecord.argv.indexOf('--settings') + 1]);
    expect(readOnlySettings.allowNonWorkspaceAccess).toBe(false);

    const wsH = await fixture(`emit(${JSON.stringify(initial)}); emit(${JSON.stringify(completed)});`);
    const extraDir = join(wsH.dir, 'extra-dir');
    const wsRun = (await new AgyAdapter({ binary: wsH.binary }).prepareRun({
      ...wsH.options, sandbox: 'workspace-write', additionalDirs: [extraDir],
    })).start();
    await collect(wsRun.events);
    await wsRun.waitForExit(1000);
    const wsRecord = JSON.parse(await readFile(join(wsH.dir, 'request.json'), 'utf8'));
    expect(wsRecord.argv).toContain('--sandbox');
    expect(wsRecord.argv).toContain('--dangerously-skip-permissions');
    expect(wsRecord.argv).toContain('--add-dir');
    expect(wsRecord.argv[wsRecord.argv.indexOf('--add-dir') + 1]).toBe(extraDir);
    const wsSettings = JSON.parse(wsRecord.argv[wsRecord.argv.indexOf('--settings') + 1]);
    expect(wsSettings.allowNonWorkspaceAccess).toBe(false);

    const fullH = await fixture(`emit(${JSON.stringify(initial)}); emit(${JSON.stringify(completed)});`);
    const fullRun = (await new AgyAdapter({ binary: fullH.binary }).prepareRun({
      ...fullH.options, sandbox: 'danger-full-access',
    })).start();
    await collect(fullRun.events);
    await fullRun.waitForExit(1000);
    const fullRecord = JSON.parse(await readFile(join(fullH.dir, 'request.json'), 'utf8'));
    expect(fullRecord.argv).toContain('--dangerously-skip-permissions');
    expect(fullRecord.argv).not.toContain('--sandbox');
    const fullSettings = JSON.parse(fullRecord.argv[fullRecord.argv.indexOf('--settings') + 1]);
    expect(fullSettings.allowNonWorkspaceAccess).toBe(true);

    const adapter = new AgyAdapter();
    const options = { runId: 'run', prompt: 'hello', cwd: '/repo' };
    await expect(async () => (await adapter.prepareRun({ ...options, sandbox: 'invalid' as never })).start()).rejects.toThrow('unsafe sandbox mode');
    await expect(async () => (await adapter.prepareRun({ ...options, additionalDirs: ['relative/dir'] })).start()).rejects.toThrow('additionalDirs');
    await expect(async () => (await adapter.prepareRun({ ...options, forkSession: true })).start()).rejects.toThrow('forks');
    await expect(async () => (await adapter.prepareRun({ ...options, sessionId: '--invalid' })).start()).rejects.toThrow('conversation ID');
  });

  it('handles 1M context differently between OAuth native 1M and api_key gateway [1m]', async () => {
    const oauthH = await fixture(`emit(${JSON.stringify(initial)}); emit(${JSON.stringify(completed)});`);
    const oauthRun = (await new AgyAdapter({ binary: oauthH.binary, authMode: 'oauth' }).prepareRun({
      ...oauthH.options, model: 'gemini-pro-orchestrator-neon', context1m: true,
    })).start();
    await collect(oauthRun.events);
    await oauthRun.waitForExit(1000);
    const oauthRecord = JSON.parse(await readFile(join(oauthH.dir, 'request.json'), 'utf8'));
    expect(oauthRecord.argv[oauthRecord.argv.indexOf('--model') + 1]).toBe('gemini-pro-orchestrator-neon');

    const apiH = await fixture(`emit(${JSON.stringify(initial)}); emit(${JSON.stringify(completed)});`);
    const apiRun = (await new AgyAdapter({
      binary: apiH.binary,
      authMode: 'api_key',
      apiKey: 'gk-test',
      baseUrl: 'https://gw.example/v1',
    }).prepareRun({
      ...apiH.options, model: 'gemini-4-pro', context1m: true,
    })).start();
    await collect(apiRun.events);
    await apiRun.waitForExit(1000);
    const apiRecord = JSON.parse(await readFile(join(apiH.dir, 'request.json'), 'utf8'));
    expect(apiRecord.argv[apiRecord.argv.indexOf('--model') + 1]).toBe('gemini-4-pro[1m]');
    const apiSettings = JSON.parse(apiRecord.argv[apiRecord.argv.indexOf('--settings') + 1]);
    expect(apiSettings.customModelsConfig.customModels['gemini-4-pro[1m]'].maxTokens).toBe(1_048_576);

    const offH = await fixture(`emit(${JSON.stringify(initial)}); emit(${JSON.stringify(completed)});`);
    const offRun = (await new AgyAdapter({
      binary: offH.binary,
      authMode: 'api_key',
      apiKey: 'gk-test',
    }).prepareRun({
      ...offH.options, model: 'gemini-4-pro[1m]', context1m: false,
    })).start();
    await collect(offRun.events);
    await offRun.waitForExit(1000);
    const offRecord = JSON.parse(await readFile(join(offH.dir, 'request.json'), 'utf8'));
    expect(offRecord.argv[offRecord.argv.indexOf('--model') + 1]).toBe('gemini-4-pro');
  });
});
