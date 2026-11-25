import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preparedRun } from '../../../src/agent/prepared-run';
import type { AgentAdapter, AgentEvent, AgentQuestionAnswer } from '../../../src/agent/types';
import { ChannelHost } from '../../../src/channels/plugin';
import { createWebPlugin } from '../../../src/channels/web/server';
import type { RunProfileConfig } from '../../../src/config/profile-schema';
import { Api } from '../../../web/chat/src/lib/api';
import { Session, type Route } from '../../../web/chat/src/lib/session';
import type { QuestionItem, RunItem } from '../../../web/chat/src/lib/types';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { FixedExecutionController } from '../../helpers/fixed-execution';
import { createTmpProfile } from '../../helpers/tmp-profile';

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

async function serve(agent: AgentAdapter) {
  const tmp = await createTmpProfile('bridge-web-page-'); cleanups.push(tmp.cleanup);
  const host = new ChannelHost(); cleanups.push(() => host.close());
  const web = await host.connect(createWebPlugin({ execution: new FixedExecutionController(agent, config(tmp.workspace)),
    config: config(tmp.workspace), namespace: 'page', stateDir: join(tmp.root, 'server') }));
  return new URL(web.url);
}

/**
 * The page's own logic (web/chat/src/lib) against a real server: everything the page does except drawing.
 * Each call is another browser: it shares nothing with the others but the server.
 */
async function open(url: URL, conversation?: string, token = new URLSearchParams(url.hash.slice(1)).get('token')!, base = `${url.origin}/`) {
  let at = conversation;
  const route: Route = { current: () => at, go: id => { at = id; }, onChange: () => {} };
  const session = new Session(new Api(token, base), route);
  cleanups.push(async () => session.close());
  await session.start();
  const page = {
    session,
    state: () => session.getState(),
    id: () => at,
    /** What the conversation shows, as kind and words. */
    said: () => session.getState().view.items.map(item =>
      item.kind === 'run' ? ['run', item.state.finalText ?? item.state.blocks.flatMap(block => block.kind === 'text' ? [block.content] : []).join('')]
        : item.kind === 'question' ? ['question', item.questions[0]!.question] : [item.kind, item.text]),
    run: () => session.getState().view.items.filter(item => item.kind === 'run').at(-1) as RunItem | undefined,
    close: async () => session.close(),
  };
  return page;
}

/** What a host puts in front of the page to bring it to its own users: under a path of its own, and it is what holds the token. */
async function proxy(url: URL, prefix: string): Promise<string> {
  const token = new URLSearchParams(url.hash.slice(1)).get('token')!;
  const server = createServer((req, res) => {
    if (!req.url?.startsWith(prefix)) { res.writeHead(404).end(); return; }
    const upstream = request({ host: url.hostname, port: url.port, method: req.method, path: `/${req.url.slice(prefix.length)}`,
      headers: { ...req.headers, host: url.host, 'x-ui-token': token } }, answer => { res.writeHead(answer.statusCode!, answer.headers); answer.pipe(res); });
    upstream.on('error', () => res.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}`;
}

/** Streams some text, then waits for an answer to its question (or for `release`) before finishing. */
function heldAgent(question: boolean) {
  let release!: (answer: AgentQuestionAnswer) => void;
  const released = new Promise<AgentQuestionAnswer>(resolve => { release = resolve; });
  const inputs: string[] = [];
  const capabilities = { input: 'active-turn', finalAnswer: 'stream' } as const;
  const agent: AgentAdapter = { id: 'claude', displayName: 'held', capabilities, isAvailable: async () => true,
    prepareRun: async options => preparedRun({}, () => ({ runId: options.runId, capabilities,
      answerUserInput: async (_id: string, value: AgentQuestionAnswer) => { release(value); return 'accepted' as const; },
      sendInput: async input => { inputs.push(input.text); return { status: 'accepted' as const, messageId: input.messageId, scope: 'active-turn' as const }; },
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'system', sessionId: 'session-held' };
        yield { type: 'text', delta: 'working' };
        if (question) yield { type: 'user_input', id: 'native-1', mode: 'blocking', sessionId: 'session-held',
          questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] };
        const answer = await released;
        yield { type: 'final_text', content: 'answers' in answer ? `chose ${answer.answers[0]![0]}` : 'released' };
        yield { type: 'done', terminationReason: 'normal' };
      })(),
      stop: async () => release({ declined: 'stopped' }), waitForExit: async () => true })) };
  return { agent, inputs, release: () => release({ declined: 'released' }) };
}

describe('bundled Web page', () => {
  it('sends a message, shows the run as it goes, and shows the same conversation to any browser afterwards', async () => {
    const url = await serve(new FakeAgentAdapter({ id: 'claude', events: [
      { type: 'system', sessionId: 's1' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
      { type: 'final_text', content: 'answer' }, { type: 'done', terminationReason: 'normal' },
    ] }));
    const page = await open(url);
    await vi.waitFor(() => expect(page.state().meta).toMatchObject({ agent: 'claude', workflows: false }));
    expect(page.state().meta!.commands.map(command => command.name)).toEqual(expect.arrayContaining(['help', 'new', 'status', 'stop']));
    expect(page.state().conversationId).toBeUndefined();

    await page.session.send('hello');
    const id = page.id()!;
    expect(id).toBe(page.state().conversationId);
    await vi.waitFor(() => expect(page.said()).toEqual([['user', 'hello'], ['run', 'answer']]));
    await vi.waitFor(() => expect(page.run()).toMatchObject({ result: 'completed', state: { terminal: 'done' } }));
    expect(page.run()!.state.blocks).toMatchObject([{ kind: 'tool', tool: { name: 'Read', status: 'done', output: 'ok' } }]);
    // What was shown at once has become the server's record of it: one item, no longer pending.
    expect(page.state().view.items[0]).toMatchObject({ kind: 'user', via: 'message' });
    expect(page.state().view.items[0]).not.toHaveProperty('pending');
    expect(page.session.runningId()).toBeUndefined();
    await vi.waitFor(() => expect(page.state().conversations).toMatchObject([{ id, title: 'hello', preview: 'answer' }]));

    await page.session.send('/workflow status');
    await vi.waitFor(() => expect(page.said().slice(2)).toEqual([['user', '/workflow status'], ['notice', '当前会话未启用工作流。']]));
    expect(page.state().view.items.at(-1)).toMatchObject({ source: 'command' });
    await page.close();

    // Another browser has no memory of the conversation; the server has all of it.
    const other = await open(url, id);
    await vi.waitFor(() => expect(other.state().view.ready).toBe(true));
    expect(other.said()).toEqual([['user', 'hello'], ['run', 'answer'], ['user', '/workflow status'], ['notice', '当前会话未启用工作流。']]);
    expect(other.state().conversations).toMatchObject([{ id, title: 'hello' }]);
    await vi.waitFor(() => expect(other.state().engine).toMatchObject({ agent: 'claude' }));
  });

  it('answers shared slash commands in the conversation without starting a run', async () => {
    const url = await serve(new FakeAgentAdapter({ id: 'claude', events: [] }));
    const page = await open(url);
    await page.session.send('/status');
    await vi.waitFor(() => expect(page.said()).toEqual([['user', '/status'], ['notice', '**Engine:** claude\n**State:** idle']]));
    expect(page.state().view.items[0]).toMatchObject({ via: 'command' });
    // A conversation is not named after a command.
    await vi.waitFor(() => expect(page.state().conversations).toMatchObject([{ title: '新对话' }]));
  });

  it('shows a run that is still going to a page opened after it started, takes more input for it, and shows its result', async () => {
    const held = heldAgent(false);
    const url = await serve(held.agent);
    const page = await open(url);
    await page.session.send('long task');
    await vi.waitFor(() => expect(page.said().at(-1)).toEqual(['run', 'working']));
    await vi.waitFor(() => expect(page.state().conversations[0]).toHaveProperty('activeRunId'));
    await page.close();

    const reopened = await open(url, page.id());
    await vi.waitFor(() => expect(reopened.said()).toEqual([['user', 'long task'], ['run', 'working']]));
    expect(reopened.session.runningId()).toBe(reopened.run()!.runId);
    await reopened.session.send('one more thing');
    expect(held.inputs).toEqual(['one more thing']);
    await vi.waitFor(() => expect(reopened.state().view.items.at(-1)).toMatchObject({ kind: 'user', via: 'input', text: 'one more thing' }));
    held.release();
    await vi.waitFor(() => expect(reopened.run()).toMatchObject({ result: 'completed', state: { finalText: 'released' } }));
    await vi.waitFor(() => expect(reopened.session.runningId()).toBeUndefined());
    expect(reopened.state().conversations[0]).not.toHaveProperty('activeRunId');
  });

  it('stops a run on request and says so in the conversation', async () => {
    const url = await serve(heldAgent(false).agent);
    const page = await open(url);
    await page.session.send('long task');
    await vi.waitFor(() => expect(page.session.runningId()).toBeDefined());
    await vi.waitFor(() => expect(page.said().at(-1)).toEqual(['run', 'working']));
    await page.session.stop();
    await vi.waitFor(() => expect(page.run()!.finishedAt).toBeTypeOf('number'));
    expect(page.session.runningId()).toBeUndefined();
  });

  it('shows a question, shows it again to another browser and continues the run with the submitted answer', async () => {
    const url = await serve(heldAgent(true).agent);
    const page = await open(url);
    await page.session.send('choose');
    await vi.waitFor(() => expect(page.said().at(-1)).toEqual(['question', 'Which?']));
    await page.close();

    const reloaded = await open(url, page.id());
    await vi.waitFor(() => expect(reloaded.said().map(([kind]) => kind)).toEqual(['user', 'run', 'question']));
    const question = reloaded.state().view.items.at(-1) as QuestionItem;
    expect(question).toMatchObject({ mode: 'blocking', questions: [{ options: [{ label: 'A' }, { label: 'B' }] }] });
    expect(question.status).toBeUndefined();
    expect(await reloaded.session.answer(question.id, [['B']])).toMatchObject({ settled: true });
    await vi.waitFor(() => expect(reloaded.run()).toMatchObject({ result: 'completed', state: { finalText: 'chose B' } }));
    const answered = reloaded.state().view.items.find(item => item.kind === 'question') as QuestionItem;
    expect(answered.answers).toEqual([['B']]);
    expect(answered.status).toBeTruthy();
  });

  it('renames, pins and deletes a conversation for every open page', async () => {
    const url = await serve(new FakeAgentAdapter({ id: 'claude', events: [
      { type: 'system', sessionId: 's1' }, { type: 'final_text', content: 'answer' }, { type: 'done', terminationReason: 'normal' }] }));
    const page = await open(url);
    await page.session.send('first');
    await vi.waitFor(() => expect(page.run()?.result).toBe('completed'));
    const id = page.id()!;
    const other = await open(url, id);
    await vi.waitFor(() => expect(other.state().view.ready).toBe(true));

    await page.session.rename(id, 'A name of my own');
    await page.session.pin(id, true);
    await vi.waitFor(() => expect(other.state().conversations).toMatchObject([{ id, title: 'A name of my own', pinned: true }]));

    await other.session.remove(id);
    expect(other.state().conversationId).toBeUndefined();
    await vi.waitFor(() => expect(page.state().view.gone).toBe(true));
    await vi.waitFor(() => expect(page.state().conversations).toEqual([]));
    // Nothing of it is left for a page that asks again.
    const again = await open(url, id);
    await vi.waitFor(() => expect(again.state().view.ready).toBe(true));
    expect(again.state().view.items).toEqual([]);
  });

  it('tells a page with a stale link so, and keeps a message the server never took on screen as failed', async () => {
    const url = await serve(new FakeAgentAdapter({ id: 'claude', events: [] }));
    const locked = await open(url, undefined, 'not-the-token');
    await vi.waitFor(() => expect(locked.state().link).toBe('unauthorized'));
    const none = await open(url, undefined, '');
    expect(none.state().link).toBe('unauthorized');

    const page = await open(url);
    await vi.waitFor(() => expect(page.state().link).toBe('live'));
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).endsWith('/api/send')) throw new TypeError('network down');
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    try { await expect(page.session.send('will not arrive')).rejects.toThrow('连接不到服务'); }
    finally { fetching.mockRestore(); }
    expect(page.state().view.items).toMatchObject([{ kind: 'user', text: 'will not arrive', failed: expect.stringContaining('连接不到服务') }]);
    page.session.dismiss(page.state().view.items[0]!.key);
    await vi.waitFor(() => expect(page.state().view.items).toEqual([]));
  });

  it('needs no token of its own behind a proxy that adds it, under any path, or over a transport its host document supplies', async () => {
    const url = await serve(new FakeAgentAdapter({ id: 'claude', events: [
      { type: 'system', sessionId: 's1' }, { type: 'final_text', content: 'answer' }, { type: 'done', terminationReason: 'normal' },
    ] }));
    const page = await open(url, undefined, '', await proxy(url, '/user/someone/chat/'));
    await vi.waitFor(() => expect(page.state().link).toBe('live'));
    await page.session.send('through the proxy');
    await vi.waitFor(() => expect(page.said()).toEqual([['user', 'through the proxy'], ['run', 'answer']]));

    // A host document that reaches the server some other way: here, by adding what a plain request lacks.
    const token = new URLSearchParams(url.hash.slice(1)).get('token')!;
    const host = globalThis as { __bridgeChatFetch?: typeof fetch };
    const asked: string[] = [];
    host.__bridgeChatFetch = (input, init) => {
      asked.push(new URL(String(input)).pathname);
      return fetch(input, { ...init, headers: { ...init?.headers as Record<string, string>, 'x-ui-token': token } });
    };
    try {
      const other = await open(url, page.id(), '');
      await vi.waitFor(() => expect(other.said()).toEqual([['user', 'through the proxy'], ['run', 'answer']]));
      expect(asked).toEqual(expect.arrayContaining(['/api/meta', '/api/stream']));
      await other.close();
    } finally { delete host.__bridgeChatFetch; }
  });
});
