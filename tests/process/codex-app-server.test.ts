import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import type { AgentEvent } from '../../src/agent/types';
import { log } from '../../src/core/logger';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function harness(mode = 'normal', transport?: 'app-server') {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-app-server-'));
  dirs.push(dir);
  const binary = join(dir, 'codex');
  const record = join(dir, 'requests.jsonl');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({input:process.stdin});
const mode = ${JSON.stringify(mode)};
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
const notify = (method, params) => send({method,params});
const reply = (id,result) => send({id,result});
rl.on('line', line => {
 const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(record)},line+'\\n');
 if(m.method==='initialize') reply(m.id,{});
 if(m.method==='thread/resume' && ['provider-mismatch','provider-missing'].includes(mode)) {
  send({id:m.id,error:{code:-32600,message:'old provider',data:{type:mode==='provider-mismatch'?'modelProviderMismatch':'modelProviderNotConfigured',modelProvider:'legacy'}}});return;
 }
 if(['thread/start','thread/resume','thread/fork'].includes(m.method)) reply(m.id,{thread:{id:'thread-1'}});
 if(m.method==='turn/start') {
  reply(m.id,{turn:{id:'turn-1'}});
  notify('turn/started',{threadId:'thread-1',turn:{id:'turn-1'}});
  if(mode==='rate-failure' || mode==='quota-failure') {
   notify('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'failed',error:{
    message: mode==='quota-failure' ? 'session budget exceeded' : 'upstream throttled',
    codexErrorInfo: mode==='quota-failure'
      ? 'sessionBudgetExceeded'
      : {httpConnectionFailed:{httpStatusCode:429}}
   }}});
   return;
  }
  if(mode==='protocol-notifications') {
   notify('configWarning',{summary:'recoverable config issue',details:'details',path:'/config.toml'});
   notify('warning',{threadId:'thread-1',message:'runtime warning'});
   notify('mcpServer/startupStatus/updated',{threadId:'thread-1',name:'grafana',status:'failed',failureReason:'reauthenticationRequired',error:null});
   notify('account/rateLimits/updated',{rateLimits:{limitId:'codex',primary:{usedPercent:91},secondary:null,rateLimitReachedType:null}});
   notify('error',{threadId:'thread-1',turnId:'turn-1',willRetry:true,error:{message:'retrying request',codexErrorInfo:'rateLimitExceeded'}});
   notify('item/completed',{threadId:'thread-1',turnId:'turn-1',item:{id:'answer',type:'agentMessage',text:'completed after retry'}});
   notify('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}});
   return;
  }
  if(mode==='compact') {
   notify('thread/tokenUsage/updated',{threadId:'thread-1',turnId:'turn-1',tokenUsage:{
    last:{inputTokens:900000,outputTokens:120,cachedInputTokens:800000,reasoningOutputTokens:20,totalTokens:900120},
    total:{inputTokens:1200000,outputTokens:220,cachedInputTokens:1000000,reasoningOutputTokens:40,totalTokens:1200220},
    modelContextWindow:1000000
   }});
   notify('item/completed',{threadId:'thread-1',turnId:'turn-1',item:{id:'compact-1',type:'contextCompaction'}});
   notify('item/agentMessage/delta',{threadId:'thread-1',turnId:'turn-1',itemId:'answer',delta:'continued'});
   notify('item/completed',{threadId:'thread-1',turnId:'turn-1',item:{id:'answer',type:'agentMessage',text:'continued'}});
   notify('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}});
  }
  if(mode==='questions') {
   const item={id:'question-1',type:'agentMessage',text:'请选择范围',questions:[{title:'处理范围？',options:['全部','仅本次']},{title:'补充说明',options:null}]};
   notify('item/completed',{threadId:'other-thread',turnId:'turn-1',item:{...item,id:'wrong-thread'}});
   notify('item/completed',{threadId:'thread-1',turnId:'turn-1',item});
   notify('item/completed',{threadId:'thread-1',turnId:'turn-1',item});
  }
  notify('item/started',{threadId:'thread-1',turnId:'turn-1',item:{id:'cmd',type:'commandExecution',command:'long-running-command'}});
 }
 if(m.method==='turn/steer') {
  if(mode==='inactive') {send({id:m.id,error:{code:-32600,message:'no active turn'}});return;}
  if(mode==='not-steerable') {
   const data={codexErrorInfo:{activeTurnNotSteerable:{turnKind:'review'}}};
   send({id:m.id,error:{code:-32600,message:'cannot steer active turn',data}});
   return;
  }
  if(mode==='disconnect') {process.exit(1);return;}
  if(mode==='reject') {send({id:m.id,error:{code:-32600,message:'unexpected failure'}});return;}
  reply(m.id,{turnId:'turn-1'});
  if(mode==='keep-running') return;
  notify('item/agentMessage/delta',{threadId:'other-thread',turnId:'other',itemId:'bad',delta:'must not leak'});
  notify('item/agentMessage/delta',{threadId:'thread-1',turnId:'turn-1',itemId:'answer',delta:'used additional input'});
  notify('item/completed',{threadId:'other-thread',turnId:'other',item:{id:'bad',type:'agentMessage',text:'must not leak'}});
  notify('item/completed',{threadId:'thread-1',turnId:'turn-1',item:{id:'cmd',type:'commandExecution',aggregatedOutput:'finished without interruption',exitCode:0}});
  notify('item/completed',{threadId:'thread-1',turnId:'turn-1',item:{id:'answer',type:'agentMessage',text:'used additional input'}});
  notify('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}});
 }
 if(m.method==='turn/interrupt') {
  reply(m.id,{});notify('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'interrupted'}});
 }
});
rl.on('close',()=>process.exit(0));
`);
  await chmod(binary, 0o700);
  const adapter = new CodexAdapter({ binary, profileStateDir: dir, transport });
  const requests = async () => (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { adapter, dir, requests };
}
async function collect(events: AsyncIterable<AgentEvent>) { const all: AgentEvent[] = []; for await (const e of events) all.push(e); return all; }

describe('Codex native in-flight input', () => {
  it.each(['provider-mismatch', 'provider-missing'])('preserves legacy history on %s and continues the request', async mode => {
    const h = await harness(mode);
    const run = h.adapter.run({ runId: 'migration', cwd: h.dir, prompt: 'continue', threadId: 'old-thread' });
    const events: AgentEvent[] = [];
    const output = (async () => { for await (const event of run.events) events.push(event); })();
    await vi.waitFor(() => expect(events.some(event => event.type === 'tool_use')).toBe(true));
    await run.steer!('finish', 'next-input');
    await output;
    await run.waitForExit(1000);
    expect(events).toContainEqual({ type: 'done', threadId: 'thread-1', terminationReason: 'normal' });
    const requests = await h.requests();
    const forks = requests.filter(request => request.method === 'thread/fork');
    expect(forks).toHaveLength(1);
    expect(forks[0].params).toMatchObject({ threadId: 'old-thread', threadSource: 'appServer' });
    expect(forks[0].params.ephemeral).not.toBe(true);
    expect(requests.some(request => request.method === 'thread/start')).toBe(false);
  });

  it('delivers native async questions once and keeps working until an answer is steered', async () => {
    const h = await harness('questions');
    const run = h.adapter.run({ runId: 'r', cwd: h.dir, prompt: 'task' });
    const events: AgentEvent[] = [];
    const output = (async () => { for await (const event of run.events) events.push(event); })();
    await vi.waitFor(() => expect(events.some(e => e.type === 'tool_use')).toBe(true));
    expect(events.filter(e => e.type === 'user_input')).toEqual([{
      type: 'user_input', id: 'question-1', threadId: 'thread-1',
      questions: [{ title: '处理范围？', options: ['全部', '仅本次'] }, { title: '补充说明' }],
    }]);
    expect(events.some(e => e.type === 'done')).toBe(false);
    await run.steer!('仅本次', 'answer');
    await output;
    await run.waitForExit(1000);
    expect(events.filter(e => e.type === 'final_text')).toEqual([{ type: 'final_text', content: 'used additional input' }]);
    expect(events.some(e => e.type === 'text' && e.delta.includes('请选择范围'))).toBe(false);
  });
  it.each([undefined, 'app-server'] as const)('appends to the same turn with transport=%s without stopping, restarting, or starting a second turn', async transport => {
    const h = await harness('normal', transport);
    const preview = vi.fn();
    const run = h.adapter.run({ runId: 'r', cwd: h.dir, onMessageDelta: preview, prompt: 'original task', sandbox: 'read-only', reasoningEffort: 'high' });
    const output = collect(run.events);
    expect(run.capabilities).toEqual({ finalAnswer: 'separate-event', input: 'active-turn' });
    expect(h.adapter.capabilities).toEqual(run.capabilities);
    expect(await run.sendInput!({ text: 'supplement', messageId: 'message-2' }))
      .toEqual({ status: 'accepted', messageId: 'message-2', scope: 'active-turn' });
    const events = await output;
    expect(events.filter(e => e.type === 'final_text')).toEqual([{ type: 'final_text', content: 'used additional input' }]);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith('answer', 'used additional input');
    expect(await run.waitForExit(1000)).toBe(true);
    const requests = await h.requests();
    expect(requests.filter(x => x.method === 'turn/start')).toHaveLength(1);
    expect(requests.some(x => x.method === 'turn/interrupt')).toBe(false);
    expect(requests.find(x => x.method === 'turn/steer').params).toMatchObject({ threadId: 'thread-1', expectedTurnId: 'turn-1', clientUserMessageId: 'message-2' });
    expect(requests.find(x => x.method === 'thread/start').params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', cwd: h.dir });
    expect(requests.find(x => x.method === 'turn/start').params.effort).toBe('high');
  });
  it('passes stable instructions through developerInstructions without duplicating them in user input', async () => {
    const h = await harness();
    const adapter = new CodexAdapter({
      binary: join(h.dir, 'codex'),
      profileStateDir: h.dir,
      systemPrompt: identity => `trusted instructions for ${identity?.openId ?? 'unknown'}`,
    });
    adapter.setBotIdentity({ openId: 'ou_bot' });
    const run = adapter.run({ runId: 'r', cwd: h.dir, prompt: 'task' });
    const output = collect(run.events);
    await run.steer!('finish', 'finish-message');
    await output;
    await run.waitForExit(1000);
    const requests = await h.requests();
    expect(requests.find(x => x.method === 'thread/start').params.developerInstructions)
      .toBe('trusted instructions for ou_bot');
    expect(requests.find(x => x.method === 'turn/start').params.input).toEqual([
      { type: 'text', text: 'task', text_elements: [] },
    ]);
  });
  it.each([
    ['rate-failure', 'rate_limit'],
    ['quota-failure', 'quota'],
  ] as const)('maps structured %s failures without relying on message text', async (mode, failureKind) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const h = await harness(mode);
    const events = await collect(h.adapter.run({ runId: 'r', cwd: h.dir, prompt: 'task' }).events);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      failureKind,
      terminationReason: 'failed',
    }));
    expect(warn).toHaveBeenCalledWith('codex', 'turn-failed', expect.objectContaining({
      codexErrorInfo: expect.anything(),
    }));
  });
  it('processes global warnings, rate limits, MCP failures, and retry errors before thread filtering', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const h = await harness('protocol-notifications');
    const events = await collect(h.adapter.run({ runId: 'r', cwd: h.dir, prompt: 'task' }).events);

    expect(events).toContainEqual({
      type: 'status',
      code: 'codex_warning:runtime warning',
      content: '⚠️ runtime warning',
    });
    expect(events).toContainEqual({
      type: 'status',
      code: 'mcp_startup_failed:grafana:reauthenticationRequired',
      content: '⚠️ MCP 服务 grafana 需要重新授权，相关工具暂时不可用。',
    });
    expect(events).toContainEqual({
      type: 'status',
      code: 'codex_retry',
      content: '⚠️ Codex 请求失败，正在自动重试。',
    });
    expect(warn).toHaveBeenCalledWith('codex', 'config-warning', expect.objectContaining({
      summary: 'recoverable config issue',
    }));
    expect(warn).toHaveBeenCalledWith('codex', 'mcp-startup-failed', expect.objectContaining({
      serverName: 'grafana',
      failureReason: 'reauthenticationRequired',
    }));
    expect(warn).toHaveBeenCalledWith('codex', 'error-notification', expect.objectContaining({
      willRetry: true,
      variant: 'rateLimitExceeded',
      failureKind: 'rate_limit',
    }));
    expect(info).toHaveBeenCalledWith('codex', 'rate-limits-updated', expect.objectContaining({
      limitId: 'codex',
      primaryUsedPercent: 91,
    }));
  });
  it('reports context compaction and model context occupancy', async () => {
    const h = await harness('compact');
    const run = h.adapter.run({ runId: 'r', cwd: h.dir, prompt: 'task' });
    const events = await collect(run.events);
    expect(events).toContainEqual({
      type: 'status',
      code: 'context_compaction',
      content: '上下文已自动压缩，任务继续执行。',
    });
    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 900000,
      outputTokens: 120,
      cachedInputTokens: 800000,
      reasoningOutputTokens: 20,
      contextWindowTokens: 1000000,
    });
  });
  it.each([false, true])('preserves resume/fork routing (fork=%s)', async forkSession => {
    const h = await harness();
    const run = h.adapter.run({ runId: 'r', cwd: h.dir, prompt: 'continue', threadId: 'old-thread', forkSession, images: ['/private/image.png'] });
    const output = collect(run.events);
    await run.steer!('more', 'm'); await output; await run.waitForExit(1000);
    const requests = await h.requests();
    expect(requests.find(x => x.method === (forkSession ? 'thread/fork' : 'thread/resume')).params).toMatchObject({ threadId: 'old-thread', ...(forkSession ? { ephemeral: true } : {}) });
    expect(requests.find(x => x.method === 'turn/start').params.input).toContainEqual({ type: 'localImage', path: '/private/image.png' });
  });
  it('interrupts through the protocol and finishes the existing process', async () => {
    const h = await harness('keep-running');
    const run = h.adapter.run({ runId: 'r', cwd: h.dir, prompt: 'task' });
    const output = collect(run.events);
    await run.steer!('supplement', 'm');
    await run.stop();
    expect(await output).toContainEqual({ type: 'done', threadId: 'thread-1', terminationReason: 'interrupted' });
    expect(await run.steer!('late', 'late')).toBe('inactive');
    expect((await h.requests()).filter(x => x.method === 'turn/interrupt')).toHaveLength(1);
  });
  it('only allows a new-turn fallback after explicit inactive rejection', async () => {
    const h = await harness('inactive');
    const run = h.adapter.run({ runId: 'r', cwd: h.dir, prompt: 'task' });
    const output = collect(run.events);
    expect(await run.sendInput!({ text: 'late', messageId: 'm' })).toEqual({ status: 'inactive', messageId: 'm' });
    await run.stop(); await output;
  });
  it('treats structured activeTurnNotSteerable rejection as inactive', async () => {
    const h = await harness('not-steerable');
    const run = h.adapter.run({ runId: 'r', cwd: h.dir, prompt: 'task' });
    const output = collect(run.events);
    expect(await run.sendInput!({ text: 'late', messageId: 'm' })).toEqual({ status: 'inactive', messageId: 'm' });
    await run.stop(); await output;
  });
  it.each(['reject', 'disconnect'])('does not retry delivery on %s', async mode => {
    const h = await harness(mode);
    const run = h.adapter.run({ runId: 'r', cwd: h.dir, prompt: 'task' });
    const output = collect(run.events);
    expect(await run.sendInput!({ text: 'more', messageId: 'm' })).toMatchObject({ status: 'unknown', messageId: 'm' });
    await run.stop(); await output;
    expect((await h.requests()).filter(x => x.method === 'turn/steer')).toHaveLength(1);
  });
  it('does not silently discard unsupported exec-only configuration', () => {
    expect(() => new CodexAdapter({ binary: 'codex', profileStateDir: '.', transport: 'exec' as never })).toThrow('removed');
    expect(() => new CodexAdapter({ binary: 'codex', profileStateDir: '.', ignoreUserConfig: true })).toThrow('ignoreUserConfig');
    expect(() => new CodexAdapter({ binary: 'codex', profileStateDir: '.', ignoreRules: true })).toThrow('ignoreRules');
    expect(() => new CodexAdapter({ binary: 'codex', profileStateDir: '.', transport: 'app-server', ignoreUserConfig: true, ignoreRules: false })).toThrow('ignoreUserConfig');
    expect(() => new CodexAdapter({ binary: 'codex', profileStateDir: '.', transport: 'app-server', ignoreRules: true })).toThrow('ignoreRules');
  });
});
