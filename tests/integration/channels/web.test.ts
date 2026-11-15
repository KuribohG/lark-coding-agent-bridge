import { preparedRun } from '../../../src/agent/prepared-run';
import { AGENT_KINDS } from '../../../src/agent/backend-spec';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConversationRuntime, type ConversationRuntime } from '../../../src/runtime/conversation';
import type { ConversationStreamEvent } from '../../../src/runtime/conversation-events';
import { createWebRunOutput, type WebRunEvent } from '../../../src/channels/web/output';
import { createWebPlugin } from '../../../src/channels/web/server';
import { ChannelHost } from '../../../src/channels/plugin';
import type {
  AgentExecutionProfile,
  AgentKind,
  RunProfileConfig,
} from '../../../src/config/profile-schema';
import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentQuestionAnswer } from '../../../src/agent/types';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile } from '../../helpers/tmp-profile';
import { capabilityForProfile } from '../../../src/agent/backends';
import {
  profileForAgentKind,
  type ExecutionController,
} from '../../../src/runtime/execution-controller';
import { FixedExecutionController } from '../../helpers/fixed-execution';

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
  const options = { execution: new FixedExecutionController(agent, config(tmp.workspace)), config: config(tmp.workspace), namespace: 'test', channelId: 'web',
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
  async resolveModelProvider() { return undefined; }
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
  const execution = new SwitchableExecutionController(base, { claude, pi, codex: new FakeAgentAdapter({ id: 'codex' }), agy: new FakeAgentAdapter({ id: 'agy' }) });
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

/** Asks one blocking question after reporting its session, and finishes once it is answered. */
function askingAgent() {
  let answered!: (answer: AgentQuestionAnswer) => void;
  const answer = new Promise<AgentQuestionAnswer>(resolve => { answered = resolve; });
  const answerUserInput = vi.fn(async (_id: string, value: AgentQuestionAnswer) => { answered(value); return 'accepted' as const; });
  const runOptions: { userQuestions?: boolean }[] = [];
  const capabilities = { input: 'active-turn', finalAnswer: 'stream' } as const;
  const agent: AgentAdapter = { id: 'claude', displayName: 'asking', capabilities, isAvailable: async () => true,
    prepareRun: async options => {
      runOptions.push(options);
      return preparedRun({}, () => ({ runId: options.runId, capabilities, answerUserInput,
        events: (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'system', sessionId: 'session-ask' };
          yield { type: 'user_input', id: 'native-1', mode: 'blocking', sessionId: 'session-ask',
            questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] };
          await answer;
          yield { type: 'final_text', content: 'done' };
          yield { type: 'done', terminationReason: 'normal' };
        })(),
        stop: async () => answered({ declined: 'stopped' }), waitForExit: async () => true }));
    } };
  return { agent, answerUserInput, runOptions };
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
    const agent: AgentAdapter = { id: 'claude', displayName: 'controlled', capabilities: { input: 'active-turn', finalAnswer: 'stream' }, isAvailable: async () => true,
      prepareRun: async options => preparedRun({}, () => ({ runId: options.runId, capabilities: { input: 'active-turn', finalAnswer: 'stream' }, sendInput,
        events: (async function* () { yield { type: 'text', delta: 'waiting' } as const; await stopped; })(),
        stop: async () => end(), waitForExit: async () => true })) };
    const runtime = await createConversationRuntime({ ...h.options, execution: new FixedExecutionController(agent, h.options.config) }); cleanups.push(() => runtime.close());
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

  it('shows a run\'s question through its sink and takes the answer only from the person asked', async () => {
    const h = await harness(); await h.runtime.close();
    const asking = askingAgent();
    const runtime = await createConversationRuntime({ ...h.options, execution: new FixedExecutionController(asking.agent, h.options.config) }); cleanups.push(() => runtime.close());
    const ask = vi.fn(async (_question: { id: string }) => {});
    const settled = vi.fn(async (_question: { id: string; runId: string; status: string }) => {});
    const result = await runtime.start({ ...identity, prompt: 'choose', questions: { ask, settled } }, createWebRunOutput(async () => {}));
    if (!result.ok) throw Error('expected active run');
    await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
    expect(asking.runOptions[0]?.userQuestions).toBe(true);
    expect(ask.mock.calls[0]![0]).toMatchObject({ mode: 'blocking', questions: [{ question: 'Which?' }] });
    const id = ask.mock.calls[0]![0].id;

    expect(await runtime.answerQuestion({ ...identity, actorId: 'bob' }, id, [['A']])).toMatchObject({ settled: false });
    expect(await runtime.answerQuestion(identity, id, [])).toMatchObject({ settled: false });
    expect(asking.answerUserInput).not.toHaveBeenCalled();

    expect(await runtime.answerQuestion(identity, id, [['A']])).toMatchObject({ settled: true, message: expect.stringContaining('A') });
    expect(asking.answerUserInput).toHaveBeenCalledWith('native-1', { answers: [['A']] });
    expect(settled).toHaveBeenCalledWith({ id, runId: result.execution.runId, status: expect.stringContaining('A') });
    await result.done;
    expect(await result.execution.result).toBe('completed');
    expect(await runtime.answerQuestion(identity, id, [['B']])).toMatchObject({ settled: false });
  });

  it('publishes a submitted run to the conversation stream, with or without a subscriber', async () => {
    const h = await harness();
    const live: ConversationStreamEvent[] = [];
    const stop = await h.runtime.subscribe(identity, {}, event => { live.push(event); });
    const run = await h.runtime.submit({ ...identity, prompt: 'hello' });
    if (!run.ok) throw Error('expected started');
    await vi.waitFor(() => expect(live.at(-1)).toMatchObject({ type: 'run.finished', runId: run.runId, result: 'completed' }));
    expect(live[0]).toMatchObject({ type: 'stream.opened', sequence: 0 });
    expect(live.map(event => event.type)).toEqual(expect.arrayContaining(['run.started', 'run.state']));
    expect(live.filter(event => event.type === 'run.state').at(-1)).toMatchObject({ state: { finalText: 'answer', terminal: 'done' } });
    stop();

    h.agent.setEvents(events);
    const unseen = await h.runtime.submit({ ...identity, prompt: 'again' });
    if (!unseen.ok) throw Error('expected started');
    const opened = live[0] as { stream: string };
    const cursor = { stream: opened.stream, after: (live.at(-1) as { sequence: number }).sequence };
    const later: ConversationStreamEvent[] = [];
    await vi.waitFor(async () => {
      later.length = 0;
      (await h.runtime.subscribe(identity, cursor, event => { later.push(event); }))();
      expect(later.at(-1)).toMatchObject({ type: 'run.finished', runId: unseen.runId });
    });
    expect(later.slice(1).every(event => 'runId' in event && event.runId === unseen.runId)).toBe(true);

    const other: ConversationStreamEvent[] = [];
    (await h.runtime.subscribe({ ...identity, conversationId: 'two' }, {}, event => { other.push(event); }))();
    expect(other).toHaveLength(1);
    h.authorize.mockResolvedValue(false);
    await expect(h.runtime.subscribe(identity, {}, () => {})).rejects.toThrow('denied');
    await expect(h.runtime.submit({ ...identity, prompt: 'no' })).rejects.toThrow('denied');
  });

  it('starts a workflow turn from a command, with the workflow tool bound to the conversation', async () => {
    const h = await harness(); await h.runtime.close();
    const runtime = await createConversationRuntime({ ...h.options, stateDir: join(h.tmp.root, 'workflows'), workflows: true });
    cleanups.push(() => runtime.close());
    expect(await runtime.workflowCommand(identity, 'status')).toBe('当前没有工作流。');
    expect(await runtime.workflowCommand(identity, 'start')).toContain('用法');
    h.authorize.mockResolvedValueOnce(false);
    await expect(runtime.workflowCommand(identity, 'status')).rejects.toThrow('denied');

    const live: ConversationStreamEvent[] = [];
    (await runtime.subscribe(identity, {}, event => { live.push(event); }));
    expect(await runtime.workflowCommand(identity, 'start build the thing')).toBeUndefined();
    await vi.waitFor(() => expect(live.at(-1)).toMatchObject({ type: 'run.finished', result: 'completed' }));
    const options = h.agent.runOptions[0]!;
    expect(options.prompt).toContain('build the thing');
    expect(options.prompt).toContain('<bridge_instructions>');
    expect(Object.keys(options.env ?? {}).length).toBeGreaterThan(0);

    // The workflow tool authorizes its caller by resolving the conversation's session again; that must
    // find the session the turn just ran in, system prompt included.
    const host = (runtime as unknown as { workflows: { resolveRoot(scope: string, catalog: unknown): Promise<{ root: { scopeId: string } } | undefined> };
      catalog: unknown }).workflows;
    const scope = [...(host as unknown as { origins: Map<string, unknown> }).origins.keys()][0]!;
    expect(await host.resolveRoot(scope, (runtime as unknown as { catalog: unknown }).catalog)).toMatchObject({ root: { scopeId: scope } });

    // An ordinary message of a conversation without a workflow is passed through unchanged.
    h.agent.setEvents(events);
    const run = await runtime.submit({ ...identity, prompt: 'plain question' });
    if (!run.ok) throw Error('expected started');
    await vi.waitFor(() => expect(live.at(-1)).toMatchObject({ type: 'run.finished', runId: run.runId }));
    expect(h.agent.runOptions[1]).toMatchObject({ prompt: 'plain question' });
    expect(h.agent.runOptions[1]!.env).toBeUndefined();
  });

  it('queues a workflow turn behind the active run and reports workflows as off when not enabled', async () => {
    const h = await harness();
    expect(await h.runtime.workflowCommand(identity, 'status')).toBe('当前会话未启用工作流。');
    await h.runtime.close();
    const held = askingAgent();
    const runtime = await createConversationRuntime({ ...h.options, stateDir: join(h.tmp.root, 'queued'), workflows: true,
      execution: new FixedExecutionController(held.agent, h.options.config) });
    cleanups.push(() => runtime.close());
    const live: ConversationStreamEvent[] = [];
    await runtime.subscribe(identity, {}, event => { live.push(event); });
    const first = await runtime.submit({ ...identity, prompt: 'first' });
    if (!first.ok) throw Error('expected started');
    await vi.waitFor(() => expect(live.some(event => event.type === 'run.question')).toBe(true));
    expect(await runtime.workflowCommand(identity, 'start later')).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(held.runOptions).toHaveLength(1);
    const question = live.find(event => event.type === 'run.question') as { id: string };
    await runtime.answerQuestion(identity, question.id, [['A']]);
    await vi.waitFor(() => expect(held.runOptions).toHaveLength(2));
    expect((held.runOptions[1] as { prompt: string }).prompt).toContain('later');
  });

  it('does not offer the question tool to a run whose host cannot show questions', async () => {
    const h = await harness();
    await run(h.runtime);
    expect(h.agent.runOptions[0]?.userQuestions).toBeFalsy();
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

  it('streams a question to the browser and continues the run with the posted answer', async () => {
    const h = await harness(); await h.runtime.close();
    const asking = askingAgent();
    const host = new ChannelHost(); cleanups.push(() => host.close());
    const web = await host.connect(createWebPlugin({ ...h.options, stateDir: join(h.tmp.root, 'ask'),
      execution: new FixedExecutionController(asking.agent, h.options.config) }));
    const url = new URL(web.url);
    const headers = { 'x-ui-token': new URLSearchParams(url.hash.slice(1)).get('token')! };
    const post = (path: string, body: object) => fetch(`${url.origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const response = await post('/api/chat', { conversationId: 'browser', text: 'choose' });
    const reader = response.body!.getReader(); const decoder = new TextDecoder();
    const messages: Array<Record<string, unknown>> = []; let pending = '';
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n'); pending = lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line) as Record<string, unknown>;
        messages.push(message);
        if (message.type !== 'run.question') continue;
        expect((await post('/api/answer', { conversationId: 'browser', requestId: message.id, answers: 'A' })).status).toBe(400);
        expect(await (await post('/api/answer', { conversationId: 'other', requestId: message.id, answers: [['A']] })).json())
          .toMatchObject({ settled: false });
        expect(await (await post('/api/answer', { conversationId: 'browser', requestId: message.id, answers: [['B']] })).json())
          .toMatchObject({ settled: true });
      }
      if (done) break;
    }
    expect(asking.answerUserInput).toHaveBeenCalledWith('native-1', { answers: [['B']] });
    expect(messages.map(message => message.type)).toEqual(expect.arrayContaining(['run.question', 'run.question.settled']));
    expect(messages.at(-1)).toMatchObject({ type: 'run.finished', result: 'completed' });
  });

  it('follows a conversation over a long-lived stream that a client can resume', async () => {
    const h = await harness(); await h.runtime.close();
    const host = new ChannelHost(); cleanups.push(() => host.close());
    const web = await host.connect(createWebPlugin({ ...h.options, stateDir: join(h.tmp.root, 'events'), display: { show_tools: false } }));
    const url = new URL(web.url);
    const headers = { 'x-ui-token': new URLSearchParams(url.hash.slice(1)).get('token')! };
    const follow = async (query: string, until: (event: Record<string, unknown>) => boolean) => {
      const abort = new AbortController();
      const response = await fetch(`${url.origin}/api/events?conversationId=browser${query}`, { headers, signal: abort.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader(); const decoder = new TextDecoder();
      const received: Array<Record<string, unknown>> = []; let pending = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          const lines = pending.split('\n'); pending = lines.pop()!;
          for (const line of lines.filter(Boolean)) received.push(JSON.parse(line));
          if (done || received.some(until)) return received;
        }
      } finally { abort.abort(); }
    };
    expect((await fetch(`${url.origin}/api/events?conversationId=browser`)).status).toBe(401);
    expect((await fetch(`${url.origin}/api/events?conversationId=browser&after=x`, { headers })).status).toBe(400);

    const following = follow('', event => event.type === 'run.finished');
    const sent = await fetch(`${url.origin}/api/send`, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'browser', text: 'hello' }) });
    const { runId } = await sent.json() as { runId: string };
    const first = await following;
    expect(first[0]).toMatchObject({ type: 'stream.opened' });
    expect(first.at(-1)).toMatchObject({ type: 'run.finished', runId, result: 'completed' });
    // The stream carries what this host is configured to show.
    const shown = first.filter(event => event.type === 'run.state').at(-1) as { state: { blocks: Array<{ kind: string }> } };
    expect(shown.state.blocks.every(block => block.kind !== 'tool')).toBe(true);

    expect((await fetch(`${url.origin}/api/command`, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'browser', text: 'hello' }) })).status).toBe(400);
    const command = await fetch(`${url.origin}/api/command`, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'browser', text: '/workflow status' }) });
    expect(await command.json()).toEqual({ reply: '当前会话未启用工作流。' });

    const again = await follow(`&stream=${first[0]!.stream}&after=${first.at(-1)!.sequence}`, event => event.type === 'stream.opened');
    expect(again).toHaveLength(1);
    const replayed = await follow('', event => event.type === 'run.finished');
    expect(replayed.at(-1)).toMatchObject({ type: 'run.finished', runId });
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
    expect(initial.options.map((option: { value: string }) => option.value)).toEqual(AGENT_KINDS);

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
