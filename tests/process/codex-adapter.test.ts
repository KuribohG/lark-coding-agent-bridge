import { buildLarkChannelEnv } from '../../src/agent/lark-channel-env';
import { buildBridgeSystemPrompt } from '../../src/channels/lark/system-prompt';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter, type CodexAdapterOptions } from '../../src/agent/codex/adapter';
import type { AgentEvent, AgentRun } from '../../src/agent/types';
import { ModelProviderRegistry } from '../../src/model-provider/provider';

const dirs: string[] = [];
afterEach(async () => {
  delete process.env.CODEX_PROVIDER_TEST_KEY;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function harness(mode = 'normal', options: Partial<CodexAdapterOptions> = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'codex-adapter-')));
  dirs.push(dir);
  const binary = join(dir, 'codex');
  const record = join(dir, 'process.json');
  const requestsFile = join(dir, 'requests.jsonl');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),env:Object.fromEntries(
 ['CODEX_HOME','LARK_CHANNEL','LARK_CHANNEL_PROFILE','LARK_CHANNEL_HOME','LARK_CHANNEL_CONFIG','LARKSUITE_CLI_CONFIG_DIR'].map(k=>[k,process.env[k]])),
 providerEnv:Object.entries(process.env).filter(([key])=>key.startsWith('LARK_MODEL_PROVIDER_'))}));
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const notify = (method,params) => send({method,params});
rl.on('line', line => {
 const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(requestsFile)}, line+'\\n');
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(['thread/start','thread/resume','thread/fork'].includes(m.method)) send({id:m.id,result:{thread:{id:'thread-1'}}});
 if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'turn-1'}}});
  notify('turn/started',{threadId:'thread-1',turn:{id:'turn-1'}});
  if(${JSON.stringify(mode)}==='hold') return;
  notify('item/completed',{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',id:'answer',text:'hello user'}});
  if(${JSON.stringify(mode)}==='fail') {console.error('boom'); process.exit(42);}
  notify('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}});
 }
 if(m.method==='turn/interrupt') {
  send({id:m.id,result:{}});
  notify('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'interrupted'}});
 }
});
rl.on('close',()=>process.exit(0));
`);
  await chmod(binary, 0o700);
  return {
    dir,
    adapter: new CodexAdapter({ binary, profileStateDir: dir, ...options }),
    record: async () => JSON.parse(await readFile(record, 'utf8')),
    requests: async (): Promise<Array<{ method: string; params: any }>> => (await readFile(requestsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
  };
}
async function collect(run: AgentRun) {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  expect(await run.waitForExit(2000)).toBe(true);
  return events;
}

describe('CodexAdapter app-server process contract', () => {
  it('starts a duplex run and sends the identity-aware prompt through RPC', async () => {
    const h = await harness('normal', { systemPrompt: buildBridgeSystemPrompt, env: buildLarkChannelEnv() });
    h.adapter.setBotIdentity({ openId: 'ou_test_bot', name: 'Test Bridge' });
    const run = h.adapter.run({ runId: 'fresh', cwd: h.dir, prompt: 'hello from lark', sandbox: 'read-only' });
    expect(run.capabilities).toEqual({ finalAnswer: 'separate-event', input: 'active-turn' });
    expect(await collect(run)).toEqual([
      { type: 'system', threadId: 'thread-1' },
      { type: 'final_text', content: 'hello user' },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ]);
    expect(await run.waitForExit(1000)).toBe(true);
    const record = await h.record();
    expect(record.cwd).toBe(h.dir);
    expect(record.argv).toEqual(['app-server', '--listen', 'stdio://', '-c', 'approval_policy="never"', '-c', 'shell_environment_policy.inherit="all"']);
    expect(record.env.LARK_CHANNEL).toBe('1');
    const requests = await h.requests();
    expect(requests.find(r => r.method === 'thread/start')?.params).toMatchObject({ cwd: h.dir, sandbox: 'read-only', approvalPolicy: 'never' });
    const prompt = requests.find(r => r.method === 'turn/start')?.params.input[0].text;
    expect(prompt).toContain('ou_test_bot');
    expect(prompt).toContain('lark-channel-bridge 运行约定');
    expect(prompt).toContain('hello from lark');
  });

  it.each([undefined, 'parent'])('forwards model, effort and images with thread=%s', async threadId => {
    const h = await harness();
    await collect(h.adapter.run({ runId: 'image', cwd: h.dir, prompt: 'image', threadId,
      images: [join(h.dir, 'image.png')], model: 'private/model-v9', reasoningEffort: 'max' }));
    const requests = await h.requests();
    expect(requests.find(r => r.method === (threadId ? 'thread/resume' : 'thread/start'))?.params).toMatchObject({
      model: 'private/model-v9', sandbox: 'danger-full-access', ...(threadId ? { threadId, excludeTurns: true } : {}),
    });
    expect(requests.find(r => r.method === 'turn/start')?.params).toMatchObject({
      effort: 'max', input: [{ type: 'text', text: 'image', text_elements: [] }, { type: 'localImage', path: join(h.dir, 'image.png') }],
    });
  });

  it('forks side questions ephemerally with inherited goals disabled', async () => {
    const h = await harness();
    await collect(h.adapter.run({ runId: 'side', cwd: h.dir, prompt: 'side question', threadId: 'parent', forkSession: true }));
    expect((await h.record()).argv).toContain('features.goals=false');
    const requests = await h.requests();
    expect(requests.find(r => r.method === 'thread/fork')?.params).toMatchObject({ threadId: 'parent', ephemeral: true });
    expect(requests.some(r => r.method === 'thread/resume')).toBe(false);
  });

  it('applies a Responses provider through app-server config and environment auth', async () => {
    process.env.CODEX_PROVIDER_TEST_KEY = 'private-provider-key';
    const h = await harness();
    const provider = await new ModelProviderRegistry({
      deepseek: {
        protocol: 'responses',
        baseUrl: 'https://gateway.example/v1',
        model: 'deepseek-flash',
        apiKey: { source: 'env', id: 'CODEX_PROVIDER_TEST_KEY' },
      },
    }).resolve('codex', 'deepseek/deepseek-v4-pro');
    await collect(h.adapter.run({
      runId: 'provider',
      cwd: h.dir,
      prompt: 'provider',
      model: provider!.model,
      modelProvider: provider,
    }));

    const record = await h.record();
    const argv = record.argv.join(' ');
    expect(argv).toContain('model_provider="lark_deepseek_');
    expect(argv).toContain('https://gateway.example/v1');
    expect(argv).toContain('wire_api="responses"');
    expect(argv).not.toContain('private-provider-key');
    if (provider?.codex?.auth !== 'api-key') throw new Error('expected api-key provider');
    expect(record.providerEnv).toContainEqual([
      provider.codex.apiKeyEnv,
      'private-provider-key',
    ]);
    expect((await h.requests()).find(r => r.method === 'thread/start')?.params.model).toBe('deepseek-v4-pro');
  });

  it('switches Codex back to its native provider for an official OpenAI model', async () => {
    const h = await harness();
    const provider = await new ModelProviderRegistry().resolve('codex', 'openai-codex/gpt-6.1-sol');
    await collect(h.adapter.run({
      runId: 'openai-native',
      cwd: h.dir,
      prompt: 'official',
      model: provider!.model,
      modelProvider: provider,
    }));

    const record = await h.record();
    expect(record.argv).toContain('model_provider="openai"');
    expect(record.argv).toContain('forced_login_method="chatgpt"');
    expect(record.argv.join(' ')).not.toContain('model_providers.openai');
    expect((await h.requests()).find(r => r.method === 'thread/start')?.params.model).toBe('gpt-6.1-sol');
  });

  it.each(['inherited', 'isolated', 'explicit'] as const)('preserves %s Codex home selection and profile environment', async home => {
    const h = await harness('normal', {
      env: { ...buildLarkChannelEnv({ profile: 'codex-test', rootDir: '/bridge-root', configPath: '/bridge-root/config.toml',
        larkCliConfigDir: '/bridge-root/lark-cli', larkCliSourceConfigFile: '/bridge-root/source/config.json' }), CODEX_HOME: '/outer/codex-home' },
      ...(home === 'isolated' ? { inheritCodexHome: false } : {}),
      ...(home === 'explicit' ? { codexHome: '/selected/codex-home' } : {}),
    });
    await collect(h.adapter.run({ runId: 'env', cwd: h.dir, prompt: 'home' }));
    expect((await h.record()).env).toMatchObject({
      CODEX_HOME: home === 'inherited' ? '/outer/codex-home' : home === 'isolated' ? join(h.dir, 'codex-home') : '/selected/codex-home',
      LARK_CHANNEL: '1', LARK_CHANNEL_PROFILE: 'codex-test', LARK_CHANNEL_HOME: '/bridge-root',
      LARK_CHANNEL_CONFIG: '/bridge-root/source/config.json', LARKSUITE_CLI_CONFIG_DIR: '/bridge-root/lark-cli',
    });
  });

  it('leaves CODEX_HOME unset when it is absent from the environment', async () => {
    const h = await harness('normal', { env: { CODEX_HOME: undefined } });
    await collect(h.adapter.run({ runId: 'home', cwd: h.dir, prompt: 'home' }));
    expect((await h.record()).env.CODEX_HOME).toBeUndefined();
  });

  it('uses per-run host instructions without adding Lark instructions', async () => {
    const h = await harness('normal', { systemPrompt: buildBridgeSystemPrompt });
    await collect(h.adapter.run({ runId: 'web', cwd: h.dir, prompt: 'hello', systemPrompt: 'Web instructions' }));
    expect((await h.requests()).find(r => r.method === 'turn/start')?.params.input[0].text).toBe('Web instructions\n\n## user_message\n\nhello');
  });

  it('reports stderr and never promotes an incomplete answer on process failure', async () => {
    const h = await harness('fail');
    const events = await collect(h.adapter.run({ runId: 'fail', cwd: h.dir, prompt: 'fail' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', failureKind: 'runtime', message: expect.stringContaining('boom') }));
    expect(events.some(e => e.type === 'final_text' || e.type === 'done')).toBe(false);
  });

  it('interrupts a running turn and waits for process exit', async () => {
    const h = await harness('hold');
    const run = h.adapter.run({ runId: 'stop', cwd: h.dir, prompt: 'hold', stopGraceMs: 100 });
    const events = collect(run);
    for (let i = 0; i < 100; i++) {
      if ((await h.requests().catch(() => [])).some(r => r.method === 'turn/start')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await run.stop();
    expect(await events).toContainEqual(expect.objectContaining({ type: 'done', terminationReason: 'interrupted' }));
    expect(await run.waitForExit(1000)).toBe(true);
  });
});
