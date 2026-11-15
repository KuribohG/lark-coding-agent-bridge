import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preparedRun } from '../../../src/agent/prepared-run';
import type { AgentAdapter, AgentEvent, AgentQuestionAnswer } from '../../../src/agent/types';
import { ChannelHost } from '../../../src/channels/plugin';
import { createWebPlugin } from '../../../src/channels/web/server';
import type { RunProfileConfig } from '../../../src/config/profile-schema';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { FixedExecutionController } from '../../helpers/fixed-execution';
import { createTmpProfile } from '../../helpers/tmp-profile';

vi.mock('@larksuite/channel', () => { throw new Error('Web imported the Lark SDK'); });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** The few DOM operations the bundled page uses; enough to run its script against a real server. */
class Element {
  children: Element[] = []; parentNode?: Element; dataset: Record<string, string> = {};
  className = ''; value = ''; hidden = false; disabled = false; checked = false; type = ''; name = ''; placeholder = '';
  onclick?: (event: unknown) => unknown; onsubmit?: (event: unknown) => unknown; onchange?: unknown; onkeydown?: unknown;
  private own = '';
  constructor(readonly tag: string) {}
  get textContent(): string { return this.own + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.own = value; this.children = []; }
  get options(): Element[] { return this.children; }
  append(...nodes: Array<Element | string>) {
    for (const node of nodes) {
      if (typeof node === 'string') this.own += node;
      else { node.parentNode = this; this.children.push(node); }
    }
  }
  replaceChildren() { this.children = []; }
  all(tag: string): Element[] { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.all(tag)]); }
}

class Storage {
  private readonly items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, value); }
}

interface Browser { local: Storage; session: Storage }

async function open(url: URL, browser: Browser, withToken = true) {
  const html = await readFile(new URL('../../../src/channels/web/page.html', import.meta.url), 'utf8');
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  const elements = new Map<string, Element>();
  const document = {
    getElementById: (id: string) => elements.get(id) ?? elements.set(id, new Element(id)).get(id)!,
    createElement: (tag: string) => new Element(tag),
  };
  const aborts = new AbortController();
  const fetchPage = (path: string, init: RequestInit = {}) => fetch(`${url.origin}${path}`,
    { ...init, signal: init.signal ? AbortSignal.any([init.signal, aborts.signal]) : aborts.signal });
  new Function('document', 'location', 'history', 'sessionStorage', 'localStorage', 'fetch', script)(
    document, { hash: withToken ? url.hash : '', host: url.host, pathname: '/' }, { replaceState() {} }, browser.session, browser.local, fetchPage);
  const page = {
    el: document.getElementById,
    articles: () => document.getElementById('messages').children.map(article => ({ role: article.className, text: article.all('pre')[0]?.textContent ?? '', article })),
    send: async (text: string) => { document.getElementById('prompt').value = text; await document.getElementById('form').onsubmit!({ preventDefault() {} }); },
    /** Closing the tab drops its connections; the server keeps the conversation. */
    close: async () => { aborts.abort(); },
  };
  cleanups.push(page.close);
  return page;
}

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

/** Streams some text, then waits for an answer to its question (or for `release`) before finishing. */
function heldAgent(question: boolean) {
  let release!: (answer: AgentQuestionAnswer) => void;
  const released = new Promise<AgentQuestionAnswer>(resolve => { release = resolve; });
  const capabilities = { input: 'active-turn', finalAnswer: 'stream' } as const;
  const agent: AgentAdapter = { id: 'claude', displayName: 'held', capabilities, isAvailable: async () => true,
    prepareRun: async options => preparedRun({}, () => ({ runId: options.runId, capabilities,
      answerUserInput: async (_id: string, value: AgentQuestionAnswer) => { release(value); return 'accepted' as const; },
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
  return { agent, release: () => release({ declined: 'released' }) };
}

describe('bundled Web page', () => {
  it('sends a message, renders the run from the event stream and keeps one entry per run across reloads', async () => {
    const url = await serve(new FakeAgentAdapter({ id: 'claude', events: [
      { type: 'system', sessionId: 's1' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
      { type: 'final_text', content: 'answer' }, { type: 'done', terminationReason: 'normal' },
    ] }));
    const browser = { local: new Storage(), session: new Storage() };
    const page = await open(url, browser);
    await page.send('hello');
    await vi.waitFor(() => expect(page.articles().map(a => [a.role, a.text])).toEqual([['user', 'hello'], ['assistant', 'answer']]));
    await vi.waitFor(() => expect(page.el('send').textContent).toBe('发送'));
    expect(page.el('status').textContent).toBe('就绪');
    expect(page.articles()[1]!.article.all('details')[0]!.all('pre')[0]!.textContent).toBe('Read · done');
    expect(page.el('error').textContent).toBe('');
    await page.send('/workflow status');
    expect(page.articles().slice(2).map(a => [a.role, a.text])).toEqual([['user', '/workflow status'], ['assistant', '当前会话未启用工作流。']]);
    await page.close();

    // The reloaded page replays the server's buffer on top of its saved transcript.
    const reloaded = await open(url, browser, false);
    await vi.waitFor(() => expect(reloaded.el('status').textContent).toBe('就绪'));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(reloaded.articles().map(a => a.text)).toEqual(['hello', 'answer', '/workflow status', '当前会话未启用工作流。']);
    expect(reloaded.el('send').textContent).toBe('发送');
  });

  it('answers shared slash commands in the transcript without starting a run', async () => {
    const url = await serve(new FakeAgentAdapter({ id: 'claude', events: [] }));
    const page = await open(url, { local: new Storage(), session: new Storage() });
    await page.send('/status');
    await vi.waitFor(() => expect(page.articles().map(article => [article.role, article.text]))
      .toEqual([['user', '/status'], ['assistant', 'Engine: claude\nState: idle']]));
  });

  it('shows a run that is still going to a page opened after it started, and its result afterwards', async () => {
    const held = heldAgent(false);
    const url = await serve(held.agent);
    const browser = { local: new Storage(), session: new Storage() };
    const page = await open(url, browser);
    await page.send('long task');
    await vi.waitFor(() => expect(page.articles().at(-1)).toMatchObject({ role: 'assistant', text: 'working' }));
    await page.close();

    const reopened = await open(url, browser, false);
    await vi.waitFor(() => expect(reopened.el('send').textContent).toBe('补充'));
    expect(reopened.el('stop').disabled).toBe(false);
    held.release();
    await vi.waitFor(() => expect(reopened.articles().map(a => a.text)).toEqual(['long task', 'working\n\nreleased']));
    await vi.waitFor(() => expect(reopened.el('send').textContent).toBe('发送'));
  });

  it('renders a question, restores it after a reload and continues the run with the submitted answer', async () => {
    const url = await serve(heldAgent(true).agent);
    const browser = { local: new Storage(), session: new Storage() };
    const page = await open(url, browser);
    await page.send('choose');
    await vi.waitFor(() => expect(page.el('messages').all('fieldset')).toHaveLength(1));
    await page.close();

    const reloaded = await open(url, browser, false);
    await vi.waitFor(() => expect(reloaded.el('send').textContent).toBe('补充'));
    const forms = reloaded.el('messages').all('fieldset');
    expect(forms).toHaveLength(1);
    expect(forms[0]!.textContent).toContain('Which?');
    const picks = forms[0]!.all('input').filter(input => input.type === 'radio');
    expect(picks.map(pick => pick.value)).toEqual(['A', 'B']);
    picks[1]!.checked = true;
    const submit = reloaded.el('messages').all('button')[0]!;
    await submit.onclick!({});
    expect(submit.disabled).toBe(true);
    await vi.waitFor(() => expect(reloaded.articles().filter(a => a.text).at(-1)!.text).toContain('chose B'));
    await vi.waitFor(() => expect(reloaded.el('send').textContent).toBe('发送'));
  });
});
