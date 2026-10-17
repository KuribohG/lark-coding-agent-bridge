import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import type { AgentEvent } from '../../src/agent/types';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function harness(mode = 'normal') {
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
 if(['thread/start','thread/resume','thread/fork'].includes(m.method)) reply(m.id,{thread:{id:'thread-1'}});
 if(m.method==='turn/start') {
  reply(m.id,{turn:{id:'turn-1'}});
  notify('turn/started',{threadId:'thread-1',turn:{id:'turn-1'}});
  notify('item/started',{threadId:'thread-1',turnId:'turn-1',item:{id:'cmd',type:'commandExecution',command:'long-running-command'}});
 }
 if(m.method==='turn/steer') {
  if(mode==='inactive') {send({id:m.id,error:{code:-32600,message:'no active turn'}});return;}
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
  const adapter = new CodexAdapter({ binary, profileStateDir: dir, transport: 'app-server', ignoreRules: false });
  const requests = async () => (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { adapter, dir, requests };
}
async function collect(events: AsyncIterable<AgentEvent>) { const all: AgentEvent[] = []; for await (const e of events) all.push(e); return all; }

describe('Codex native in-flight input', () => {
  it('appends to the same turn without stopping, restarting, or starting a second turn', async () => {
    const h = await harness();
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
  it.each(['reject', 'disconnect'])('does not retry delivery on %s', async mode => {
    const h = await harness(mode);
    const run = h.adapter.run({ runId: 'r', cwd: h.dir, prompt: 'task' });
    const output = collect(run.events);
    expect(await run.sendInput!({ text: 'more', messageId: 'm' })).toMatchObject({ status: 'unknown', messageId: 'm' });
    await run.stop(); await output;
    expect((await h.requests()).filter(x => x.method === 'turn/steer')).toHaveLength(1);
  });
  it('does not silently discard unsupported exec-only configuration', () => {
    expect(() => new CodexAdapter({ binary: 'codex', profileStateDir: '.', transport: 'app-server', ignoreUserConfig: true, ignoreRules: false })).toThrow('ignoreUserConfig');
    expect(() => new CodexAdapter({ binary: 'codex', profileStateDir: '.', transport: 'app-server', ignoreRules: true })).toThrow('ignoreRules');
  });
});
