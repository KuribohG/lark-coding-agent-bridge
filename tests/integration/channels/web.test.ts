import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConversationRuntime, type ConversationRuntime } from '../../../src/runtime/conversation';
import { createWebRunOutput, type WebRunEvent } from '../../../src/channels/web/output';
import { createWebPlugin } from '../../../src/channels/web/server';
import { ChannelHost } from '../../../src/channels/plugin';
import type {
  AgentExecutionProfile,
  AgentKind,
  RunProfileConfig,
} from '../../../src/config/profile-schema';
import type { AgentAdapter, AgentBotIdentity, AgentEvent } from '../../../src/agent/types';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile } from '../../helpers/tmp-profile';
import { capabilityForProfile } from '../../../src/agent/backends';
import {
  profileForAgentKind,
  type ExecutionController,
} from '../../../src/runtime/execution-controller';

// Importing or starting the second channel must never initialize the Lark SDK.
vi.mock('@larksuite/channel', () => { throw new Error('Web imported the Lark SDK'); });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function config(workspace: string): RunProfileConfig {
  return {
    agentKind: 'claude', preferences: { maxConcurrentRuns: 1 },
    workspaces: { default: workspace }, permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
    access: { allowedUsers: [], allowedChats: [], admins: [], requireMentionInGroup: false },
    attachments: { maxCount: 0, maxBytes: 0, maxFileBytes: 0, imageMaxBytes: 0, cacheTtlMs: 0, cacheMaxBytes: 0 },
  };
}
const identity = { actorId: 'alice', conversationId: 'one' };
const events: AgentEvent[] = [
  { type: 'system', sessionId: 'session-one' },
  { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'secret' } },
  { type: 'tool_result', id: 't1', output: 'hidden output', isError: false },
  { type: 'text', delta: 'progress' }, { type: 'final_text', content: 'answer' },
  { type: 'done', terminationReason: 'normal' },
];
async function harness() {
  const tmp = await createTmpProfile('bridge-web-'); cleanups.push(tmp.cleanup);
  const agent = new FakeAgentAdapter({ id: 'claude', events });
  const authorize = vi.fn(async () => true);
  const options = { agent, config: config(tmp.workspace), namespace: 'test', channelId: 'web',
    systemPrompt: 'Browser host instructions', stateDir: tmp.profile, authorize };
  const runtime = await createConversationRuntime(options); cleanups.push(() => runtime.close());
  return { tmp, options, runtime, agent, authorize };
}
async function run(runtime: ConversationRuntime, who = identity) {
  const received: WebRunEvent[] = [];
  const result = await runtime.start({ ...who, prompt: 'hello' }, createWebRunOutput(async event => { received.push(event); }, { show_tools: false, show_reasoning: true }));
  if (!result.ok) throw Error(result.rejectReason.code);
  await result.done; await result.execution.result;
  return { received, result };
}

class SwitchableExecutionController implements ExecutionController {
  readonly defaultAgentKind: AgentKind = 'claude';
  private readonly selected = new Map<string, AgentKind>();

  constructor(
    private readonly config: AgentExecutionProfile,
    private readonly agents: Record<AgentKind, AgentAdapter>,
  ) {}

  defaultAgent(): AgentAdapter { return this.agents.claude; }
  get(scope: string): AgentAdapter { return this.agents[this.kindFor(scope)]; }
  kindFor(scope: string): AgentKind { return this.selected.get(scope) ?? this.defaultAgentKind; }
  profileFor(scope: string): AgentExecutionProfile {
    return profileForAgentKind(this.config, this.kindFor(scope));
  }
  capabilityFor(scope: string) { return capabilityForProfile(this.profileFor(scope)); }
  setBotIdentity(identity: AgentBotIdentity): void {
    for (const agent of Object.values(this.agents)) agent.setBotIdentity?.(identity);
  }
  async setScopeKind(scope: string, kind: AgentKind): Promise<void> {
    this.selected.set(scope, kind);
  }
}

async function switchableHarness() {
  const tmp = await createTmpProfile('bridge-web-switch-'); cleanups.push(tmp.cleanup);
  const claude = new FakeAgentAdapter({ id: 'claude', events });
  const pi = new FakeAgentAdapter({ id: 'pi', events });
  const base = {
    ...config(tmp.workspace),
    permissions: { defaultAccess: 'full' as const, maxAccess: 'full' as const },
  };
  const execution = new SwitchableExecutionController(base, { claude, pi, codex: new FakeAgentAdapter({ id: 'codex' }) });
  const options = {
    execution,
    config: base,
    configForAgent: (kind: AgentKind): RunProfileConfig => ({ ...base, agentKind: kind }),
    namespace: 'switch',
    channelId: 'web',
    systemPrompt: 'Browser host instructions',
    stateDir: tmp.profile,
    authorize: async () => true,
  };
  const runtime = await createConversationRuntime(options); cleanups.push(() => runtime.close());
  return { tmp, claude, pi, options, runtime };
}

describe('channel-independent conversations', () => {
  it('streams filtered JSON, final text exactly once, and resumes after reopening without Lark credentials', async () => {
    const h = await harness();
    const first = await run(h.runtime);
    expect(h.options.config).not.toHaveProperty('accounts');
    expect(h.agent.runOptions[0]?.systemPrompt).toBe('Browser host instructions');
    expect(first.received[0]?.type).toBe('run.started');
    expect(first.received.map(e => e.sequence)).toEqual(first.received.map((_, i) => i));
    const states = first.received.filter(e => e.type === 'run.state');
    expect(states.filter(e => e.state.terminal !== 'running')).toHaveLength(1);
    expect(states.at(-1)?.state.finalText).toBe('answer');
    expect(JSON.stringify(states)).not.toContain('hidden output');
    await h.runtime.close();
    h.agent.setEvents(events);
    const reopened = await createConversationRuntime(h.options); cleanups.push(() => reopened.close());
    await run(reopened);
    expect(h.agent.runOptions[1]?.sessionId).toBe('session-one');
  });

  it('isolates actors, conversations and channels; policy changes cannot resume a legacy session', async () => {
    const h = await harness();
    await run(h.runtime);
    for (const who of [{ actorId: 'bob', conversationId: 'one' }, { actorId: 'alice', conversationId: 'two' }]) {
      h.agent.setEvents(events); await run(h.runtime, who);
      expect(h.agent.runOptions.at(-1)?.sessionId).toBeUndefined();
    }
    h.agent.setEvents(events);
    h.options.config.permissions.defaultAccess = 'read-only';
    await run(h.runtime);
    expect(h.agent.runOptions.at(-1)?.sessionId).toBeUndefined();
    h.agent.setEvents(events);
    h.options.systemPrompt = 'Changed host instructions';
    await run(h.runtime);
    expect(h.agent.runOptions.at(-1)?.sessionId).toBeUndefined();
    await h.runtime.close();
    h.agent.setEvents(events);
    const other = await createConversationRuntime({ ...h.options, channelId: 'another-im' });
    cleanups.push(() => other.close());
    await run(other);
    expect(h.agent.runOptions.at(-1)?.sessionId).toBeUndefined();
  });

  it('authorizes each operation and refuses an empty message before spawning', async () => {
    const h = await harness(); h.authorize.mockResolvedValue(false);
    await expect(run(h.runtime)).rejects.toThrow('access denied');
    await expect(h.runtime.stop(identity, 'r1')).rejects.toThrow('access denied');
    await expect(h.runtime.sendInput(identity, 'r1', { messageId: 'm1', text: 'x' })).rejects.toThrow('access denied');
    expect(h.authorize).toHaveBeenCalledWith(identity);
    expect(h.agent.runs).toHaveLength(0);
    h.authorize.mockResolvedValue(true);
    await expect(h.runtime.start({ ...identity, prompt: ' ' }, createWebRunOutput(async () => {}))).rejects.toThrow('prompt');
    expect(h.agent.runs).toHaveLength(0);
  });

  it('keeps stop and supplemental input bound to the actor, conversation and run', async () => {
    const h = await harness(); await h.runtime.close();
    let end!: () => void;
    const stopped = new Promise<void>(resolve => { end = resolve; });
    const sendInput = vi.fn(async (input: { messageId: string }) => ({ status: 'accepted' as const, messageId: input.messageId, scope: 'active-turn' as const }));
    const agent: AgentAdapter = { id: 'claude', displayName: 'controlled', isAvailable: async () => true,
      run: options => ({ runId: options.runId, capabilities: { input: 'active-turn', finalAnswer: 'stream' }, sendInput,
        events: (async function* () { yield { type: 'text', delta: 'waiting' } as const; await stopped; })(),
        stop: async () => end(), waitForExit: async () => true }) };
    const runtime = await createConversationRuntime({ ...h.options, agent }); cleanups.push(() => runtime.close());
    const received: WebRunEvent[] = [];
    const result = await runtime.start({ ...identity, prompt: 'wait' }, createWebRunOutput(async e => { received.push(e); }));
    if (!result.ok) throw Error('expected active run');
    const id = result.execution.runId;
    const duplicate = await runtime.start({ ...identity, prompt: 'duplicate' }, createWebRunOutput(async () => {}));
    expect(duplicate).toMatchObject({ ok: false, rejectReason: { code: 'run-already-active' } });
    await expect(runtime.setAgentKind(identity, 'pi')).rejects.toThrow(/run is active/);
    expect(await runtime.stop({ ...identity, actorId: 'bob' }, id)).toBe(false);
    expect(await runtime.stop(identity, 'old-run')).toBe(false);
    expect(await runtime.sendInput(identity, id, { text: 'continue', messageId: 'm1' })).toMatchObject({ status: 'accepted' });
    expect(await runtime.stop(identity, id)).toBe(true);
    await result.done;
    expect(received.at(-1)).toMatchObject({ type: 'run.state', state: { terminal: 'interrupted' } });
  });

  it('stops execution when a transport fails instead of detaching it', async () => {
    const h = await harness();
    const result = await h.runtime.start({ ...identity, prompt: 'hello' }, createWebRunOutput(async () => { throw Error('socket closed'); }));
    if (!result.ok) throw Error('expected started');
    await expect(result.done).rejects.toThrow('socket closed');
    expect(h.agent.runs[0]?.stopped).toBe(true);
  });

  it('routes each conversation to its selected engine without sharing native sessions', async () => {
    const h = await switchableHarness();
    await run(h.runtime);
    await h.runtime.setAgentKind(identity, 'pi');
    h.pi.setEvents(events);
    await run(h.runtime);
    expect(h.pi.runOptions[0]?.sessionId).toBeUndefined();

    await h.runtime.setAgentKind(identity, 'claude');
    h.claude.setEvents(events);
    await run(h.runtime);
    expect(h.claude.runOptions.at(-1)?.sessionId).toBe('session-one');
  });
});

describe('standalone Web plugin', () => {
  it('serves the bundled page and authenticated streaming chat through the channel host', async () => {
    const h = await harness(); await h.runtime.close();
    const host = new ChannelHost(); cleanups.push(() => host.close());
    const web = await host.connect(createWebPlugin({ ...h.options, stateDir: join(h.tmp.root, 'server') }));
    await expect(createWebPlugin({ ...h.options, stateDir: join(h.tmp.root, 'server') }).connect()).rejects.toThrow('already in use');
    const url = new URL(web.url);
    const token = new URLSearchParams(url.hash.slice(1)).get('token')!;
    url.hash = '';
    const base = url.origin;
    expect(await (await fetch(base)).text()).toContain('Bridge Chat');
    expect((await fetch(`${base}/api/chat`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'x-ui-token': token, origin: 'https://evil.example' } })).status).toBe(403);
    const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'x-ui-token': token },
      body: JSON.stringify({ conversationId: 'browser', text: 'hello', actorId: 'untrusted' }) });
    expect(response.status).toBe(200);
    const messages = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(messages[0].scope).toContain('local');
    expect(messages[0].scope).not.toContain('untrusted');
    expect(messages.at(-1)).toMatchObject({ type: 'run.finished', result: 'completed' });
    expect(h.agent.runOptions[0]?.systemPrompt).toBe(h.options.systemPrompt);
  });

  it('rejects duplicate channels and closes all plugins even if one close fails', async () => {
    const host = new ChannelHost();
    const close = vi.fn(async () => {});
    await host.connect({ id: 'a', connect: async () => ({ close }) });
    await expect(host.connect({ id: 'a', connect: async () => ({ close }) })).rejects.toThrow('duplicate');
    await host.connect({ id: 'b', connect: async () => ({ close: async () => { throw Error('b'); } }) });
    await expect(host.close()).rejects.toThrow('channel shutdown failed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports and switches the engine for an existing browser conversation', async () => {
    const h = await switchableHarness(); await h.runtime.close();
    const host = new ChannelHost(); cleanups.push(() => host.close());
    const web = await host.connect(createWebPlugin({ ...h.options, stateDir: join(h.tmp.root, 'switch-server') }));
    const url = new URL(web.url);
    const token = new URLSearchParams(url.hash.slice(1)).get('token')!;
    const base = url.origin;
    const headers = { 'x-ui-token': token };

    const initial = await (await fetch(`${base}/api/engine?conversationId=browser`, { headers })).json() as {
      agent: string;
      defaultAgent: string;
      options: Array<{ value: string }>;
    };
    expect(initial).toMatchObject({ agent: 'claude', defaultAgent: 'claude' });
    expect(initial.options.map((option: { value: string }) => option.value)).toEqual(['claude', 'codex', 'pi']);

    const switched = await (await fetch(`${base}/api/engine`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'browser', agent: 'pi' }),
    })).json();
    expect(switched).toMatchObject({ agent: 'pi', defaultAgent: 'claude' });

    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'browser', text: 'hello' }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(h.pi.runs).toHaveLength(1);
    expect(h.claude.runs).toHaveLength(0);
  });
});
