import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordable, WebTranscripts, type TranscriptEvent, type TranscriptItem } from '../../../src/channels/web/transcript';
import type { ConversationEvent } from '../../../src/runtime/conversation-events';
import type { Block, RunState } from '../../../src/runtime/run-state';
import { applyEvent, emptyTranscript, missedPatch, type TranscriptView } from '../../../web/chat/src/lib/transcript';
import type { PageEvent } from '../../../web/chat/src/lib/types';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function store(dir?: string) {
  const root = dir ?? await mkdtemp(join(tmpdir(), 'bridge-web-transcript-'));
  if (!dir) cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  const transcripts = new WebTranscripts(root);
  await transcripts.load();
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await transcripts.close(); } };
  cleanups.push(close);
  let sequence = 0;
  const observe = (id: string, event: ConversationEvent) => transcripts.observe(id, { ...event, sequence: ++sequence });
  /** Everything asked of the conversation so far has been done, and a going run has reached its followers. */
  const settled = async (id: string) => {
    await new Promise(resolve => setTimeout(resolve, 90));
    return (await transcripts.page(id, Number.MAX_SAFE_INTEGER, 200)).items;
  };
  return { root, transcripts, observe, settled, close };
}

const text = (content: string, streaming = false): Block => ({ kind: 'text', content, streaming });
const tool = (id: string, status: 'running' | 'done' | 'error', output?: string): Block =>
  ({ kind: 'tool', tool: { id, name: 'Read', input: { file_path: `${id}.ts` }, status, ...(output === undefined ? {} : { output }) } });
const state = (blocks: Block[], more: Partial<RunState> = {}): RunState =>
  ({ blocks, reasoning: { content: '', active: false }, footer: 'streaming', terminal: 'running', ...more });

/** A page following a conversation: what the server sent, and the view the page's own code makes of it. */
function follower() {
  const events: TranscriptEvent[] = [];
  let view: TranscriptView = emptyTranscript;
  let missed = 0;
  return {
    events,
    listener: (event: TranscriptEvent) => {
      events.push(event);
      if (missedPatch(view, event as PageEvent)) missed++;
      view = applyEvent(view, event as PageEvent);
    },
    view: () => view,
    missed: () => missed,
  };
}

const shape = (items: readonly Pick<TranscriptItem, 'kind'>[]) => items.map(item => item.kind);

describe('Web chat transcripts', () => {
  it('records what was said, names the conversation after its first message and keeps both across a restart', async () => {
    const h = await store();
    await h.transcripts.addUser('c1', '/status', 'command');
    await h.transcripts.addNotice('c1', '**Engine:** claude', 'command');
    expect(h.transcripts.get('c1')).toMatchObject({ title: '新对话', preview: '**Engine:** claude' });
    await h.transcripts.addUser('c1', 'Explain   the\nproject layout', 'message', 'message-0001');
    // The page names a message when it sends it; the same name is not recorded twice.
    await h.transcripts.addUser('c1', 'Explain   the\nproject layout', 'message', 'message-0001');
    h.observe('c1', { type: 'run.started', runId: 'r1' });
    h.observe('c1', { type: 'run.state', runId: 'r1', state: state([text('It is a web app.')], { terminal: 'done', footer: null, finalText: 'It is a web app.' }) });
    h.observe('c1', { type: 'run.finished', runId: 'r1', result: 'completed' });
    h.observe('c1', { type: 'notice', text: 'workflow finished' });
    const items = await h.settled('c1');
    expect(shape(items)).toEqual(['user', 'notice', 'user', 'run', 'notice']);
    expect(items[2]).toMatchObject({ key: 'u-message-0001', via: 'message' });
    expect(items[3]).toMatchObject({ runId: 'r1', result: 'completed', state: { terminal: 'done' } });
    expect((items[3] as { finishedAt?: number }).finishedAt).toBeTypeOf('number');
    expect(h.transcripts.list()).toMatchObject([{ id: 'c1', title: 'Explain the project layout', preview: 'workflow finished' }]);
    expect(h.transcripts.list()[0]).not.toHaveProperty('activeRunId');

    await h.close();
    const again = await store(h.root);
    expect(again.transcripts.list()).toMatchObject([{ id: 'c1', title: 'Explain the project layout' }]);
    expect(await again.settled('c1')).toEqual(items);
    expect(JSON.parse(await readFile(join(h.root, 'index.json'), 'utf8'))).toMatchObject({ version: 1 });
  });

  it('sends a going run to its followers as what changed, which the page puts back together', async () => {
    const h = await store();
    await h.transcripts.addUser('c1', 'go', 'message');
    const page = follower();
    const stop = await h.transcripts.follow('c1', {}, page.listener);
    expect(page.events.map(event => event.type)).toEqual(['open', 'item', 'ready']);
    expect(page.events[0]).toMatchObject({ reset: true, epoch: h.transcripts.epoch });

    const thought = (content: string, active = false) => ({ reasoning: { content, active } });
    h.observe('c1', { type: 'run.started', runId: 'r1', settings: { agent: 'claude', model: 'm1', effort: 'high' } });
    h.observe('c1', { type: 'run.state', runId: 'r1', state: state([], thought('First, ', true)) });
    await h.settled('c1');
    expect(h.transcripts.get('c1')).toMatchObject({ activeRunId: 'r1' });
    h.observe('c1', { type: 'run.state', runId: 'r1', state: state([], thought('First, the files.', true)) });
    await h.settled('c1');
    h.observe('c1', { type: 'run.state', runId: 'r1', state: state([text('Looking', true)], thought('First, the files.')) });
    // Several states within one flush reach the followers as the latest of them.
    h.observe('c1', { type: 'run.state', runId: 'r1', state: state([text('Looking.'), tool('t1', 'running')], thought('First, the files.')) });
    await h.settled('c1');
    // What the run thinks after a tool call stands after it, though only the first of these two states says so.
    h.observe('c1', { type: 'run.state', runId: 'r1', state: state([text('Looking.'), tool('t1', 'done', 'ok')], thought('First, the files.Then the answer.', true)) });
    h.observe('c1', { type: 'run.state', runId: 'r1', state: state([text('Looking.'), tool('t1', 'done', 'ok'), text('Done', true)], thought('First, the files.Then the answer.')) });
    const items = await h.settled('c1');

    const patches = page.events.filter(event => event.type === 'run');
    expect(patches.map(patch => [patch.from, patch.blocks.length, patch.keep])).toEqual([[0, 1, undefined], [0, 1, 'First, '.length], [0, 3, undefined], [2, 3, undefined]]);
    // Streamed reasoning and text are sent as what was added.
    expect(patches[1]!.blocks[0]).toEqual({ kind: 'reasoning', content: 'the files.', active: true });
    expect(patches.every(patch => patch.state.reasoning.content === '')).toBe(true);
    expect(patches[0]).toMatchObject({ settings: { agent: 'claude', model: 'm1', effort: 'high' } });
    const run = items.at(-1) as Extract<TranscriptItem, { kind: 'run' }>;
    expect(run.settings).toEqual({ agent: 'claude', model: 'm1', effort: 'high' });
    expect(run.state.blocks).toEqual([
      { kind: 'reasoning', content: 'First, the files.' }, text('Looking.'), tool('t1', 'done', 'ok'),
      { kind: 'reasoning', content: 'Then the answer.' }, text('Done', true),
    ]);
    expect(page.missed()).toBe(0);
    expect(page.view().items).toEqual(items);
    expect(page.view().rev).toBe(items.at(-1)!.rev);

    h.observe('c1', { type: 'run.failed', runId: 'r1', error: 'conversation failed' });
    const failed = await h.settled('c1');
    expect(failed.at(-1)).toMatchObject({ result: 'failed', error: 'conversation failed', state: { terminal: 'error', footer: null } });
    expect((failed.at(-1) as { state: RunState }).state.blocks.at(-1)).toMatchObject({ streaming: false });
    expect(page.view().items).toEqual(failed);
    expect(h.transcripts.get('c1')).not.toHaveProperty('activeRunId');
    stop();
  });

  it('gives a returning follower only what it has not seen, and the tail to one of an earlier server', async () => {
    const h = await store();
    for (let index = 0; index < 5; index++) await h.transcripts.addUser('c1', `message ${index}`, 'message');
    const first = follower();
    (await h.transcripts.follow('c1', { tail: 2 }, first.listener))();
    expect(first.view().items.map(item => (item as { text: string }).text)).toEqual(['message 3', 'message 4']);
    expect(first.view()).toMatchObject({ ready: true, more: true, first: 3 });
    expect((await h.transcripts.page('c1', first.view().first, 2)).items.map(item => (item as { text: string }).text)).toEqual(['message 1', 'message 2']);
    expect(await h.transcripts.page('c1', 1, 10)).toMatchObject({ more: false, items: [{ text: 'message 0' }] });

    await h.transcripts.addUser('c1', 'message 5', 'message');
    const resumed: TranscriptEvent[] = [];
    (await h.transcripts.follow('c1', { epoch: h.transcripts.epoch, since: first.view().rev }, event => { resumed.push(event); }))();
    expect(resumed.map(event => event.type)).toEqual(['open', 'item', 'ready']);
    expect(resumed[0]).toMatchObject({ reset: false });
    expect(resumed[1]).toMatchObject({ item: { text: 'message 5' } });

    const stale: TranscriptEvent[] = [];
    (await h.transcripts.follow('c1', { epoch: 'an-earlier-server', since: first.view().rev, tail: 1 }, event => { stale.push(event); }))();
    expect(stale.map(event => event.type)).toEqual(['open', 'item', 'ready']);
    expect(stale[0]).toMatchObject({ reset: true });
    expect(stale[2]).toMatchObject({ more: true, first: 5 });
  });

  it('shows what a stopped server left going as over', async () => {
    const h = await store();
    await h.transcripts.addUser('c1', 'long task', 'message');
    h.observe('c1', { type: 'run.started', runId: 'r1' });
    h.observe('c1', { type: 'run.question', runId: 'r1', id: 'q1', mode: 'blocking', questions: [{ question: 'Which?', options: [{ label: 'A' }] }] });
    h.observe('c1', { type: 'run.state', runId: 'r1', state: state([text('working', true), tool('t1', 'running')]) });
    await h.settled('c1');
    // The server goes away without the run ending: nothing reports how it finished.
    await h.close();

    const again = await store(h.root);
    expect(again.transcripts.list()[0]).not.toHaveProperty('activeRunId');
    const items = await again.settled('c1');
    expect(items[1]).toMatchObject({ kind: 'run', lost: true, state: { terminal: 'interrupted', footer: null } });
    expect((items[1] as { state: RunState }).state.blocks).toMatchObject([{ streaming: false }, { tool: { status: 'error' } }]);
    expect(items[2]).toMatchObject({ kind: 'question', status: expect.stringContaining('重启') });
    expect(await again.transcripts.remove('c1')).toBe(true);
  });

  it('records a question with what was answered, and bounds what a run keeps of each tool call', async () => {
    const h = await store();
    h.observe('c1', { type: 'run.started', runId: 'r1' });
    h.observe('c1', { type: 'run.question', runId: 'r1', id: 'q1', mode: 'blocking', questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] });
    await h.transcripts.recordAnswers('c1', 'q1', [['B']]);
    h.observe('c1', { type: 'run.question.settled', runId: 'r1', id: 'q1', status: '已回答' });
    h.observe('c1', { type: 'run.state', runId: 'r1', state: state([tool('t1', 'done', 'x'.repeat(50_000))], { terminal: 'done' }) });
    h.observe('c1', { type: 'run.finished', runId: 'r1', result: 'completed' });
    const items = await h.settled('c1');
    expect(items[1]).toMatchObject({ kind: 'question', answers: [['B']], status: '已回答' });
    const output = (items[0] as { state: RunState }).state.blocks[0] as { tool: { output: string } };
    expect(output.tool.output.length).toBeLessThan(9_000);
    expect(output.tool.output).toContain('省略');
  });

  it('bounds a long stretch of reasoning so that it still reaches its followers as what was added', async () => {
    const h = await store();
    const page = follower();
    const stop = await h.transcripts.follow('c1', {}, page.listener);
    const thinking = (length: number) => ({ type: 'run.state' as const, runId: 'r1', state: state([], { reasoning: { content: 'x'.repeat(length), active: true } }) });
    h.observe('c1', { type: 'run.started', runId: 'r1' });
    for (const length of [20_000, 30_500, 31_000, 31_500, 40_000]) { h.observe('c1', thinking(length)); await h.settled('c1'); }
    const patches = page.events.filter(event => event.type === 'run');
    const sizes = patches.map(patch => (patch.blocks[0] as { content: string }).content.length);
    // Past the bound a stretch is cut in its middle; until the cut moves, only its end is sent.
    expect(patches.map(patch => patch.keep !== undefined)).toEqual([false, false, true, true, false]);
    expect(sizes.slice(2, 4)).toEqual([500, 500]);
    expect(Math.max(sizes[1]!, sizes[4]!)).toBeLessThan(24_100);
    const held = (page.view().items.at(-1) as Extract<TranscriptItem, { kind: 'run' }>).state.blocks[0] as { content: string };
    expect(held.content).toMatch(/^x{12000}\n… 省略 \d+ 个字符 …\nx+$/);
    expect(page.view().items).toEqual(await h.settled('c1'));
    expect(page.missed()).toBe(0);
    stop();
  });

  it('renames, pins and removes a conversation, telling whoever watches the list and whoever follows it', async () => {
    const h = await store();
    await h.transcripts.addUser('old', 'older', 'message');
    await new Promise(resolve => setTimeout(resolve, 5));
    await h.transcripts.addUser('new', 'newer', 'message');
    let changes = 0;
    const unwatch = h.transcripts.watch(() => { changes++; });
    const page = follower();
    await h.transcripts.follow('old', {}, page.listener);
    expect(h.transcripts.list().map(entry => entry.id)).toEqual(['new', 'old']);
    expect(await h.transcripts.pin('old', true)).toMatchObject({ pinned: true });
    expect(h.transcripts.list().map(entry => entry.id)).toEqual(['old', 'new']);
    expect(await h.transcripts.rename('old', '  A better   name ')).toMatchObject({ title: 'A better name', named: true });
    await h.transcripts.addUser('old', 'a later message does not rename it', 'message');
    expect(h.transcripts.get('old')).toMatchObject({ title: 'A better name' });
    expect(page.events.filter(event => event.type === 'conversation').at(-1)).toMatchObject({ conversation: { title: 'A better name', pinned: true } });
    expect(changes).toBeGreaterThanOrEqual(3);
    expect(await h.transcripts.rename('missing', 'x')).toBeUndefined();

    h.observe('old', { type: 'run.started', runId: 'r1' });
    await h.settled('old');
    expect(await h.transcripts.remove('old')).toBe(false);
    h.observe('old', { type: 'run.finished', runId: 'r1', result: 'stopped' });
    await h.settled('old');
    expect(await h.transcripts.remove('old')).toBe(true);
    expect(page.events.at(-1)).toEqual({ type: 'gone' });
    expect(h.transcripts.list().map(entry => entry.id)).toEqual(['new']);
    expect(await h.settled('old')).toEqual([]);
    unwatch();
  });

  it('leaves conversations with unusable IDs unrecorded', async () => {
    const h = await store();
    expect(recordable('x'.repeat(201))).toBe(false);
    expect(recordable('line\nbreak')).toBe(false);
    expect(recordable('a/b c:中文')).toBe(true);
    await h.transcripts.addUser('x'.repeat(201), 'hello', 'message');
    h.observe('line\nbreak', { type: 'notice', text: 'n' });
    await h.settled('c1');
    expect(h.transcripts.list()).toEqual([]);
  });
});

describe('the page\'s view of a conversation', () => {
  const user = (key: string, ord: number, rev: number, more: object = {}): PageEvent =>
    ({ type: 'item', item: { kind: 'user', key, ord, rev, at: 1, text: key, via: 'message', ...more } });

  it('shows a sent message at once and replaces it with the server\'s record of it', async () => {
    const { addPending, failPending } = await import('../../../web/chat/src/lib/transcript');
    let view = applyEvent(emptyTranscript, { type: 'open', epoch: 'e1', reset: true });
    view = applyEvent(view, user('u-a', 0, 1));
    view = addPending(view, 'b', 'second', 'message', 2);
    view = addPending(view, 'c', 'third', 'message', 3);
    expect(view.items.map(item => [item.key, (item as { pending?: boolean }).pending ?? false])).toEqual([['u-a', false], ['u-b', true], ['u-c', true]]);
    // The server's items take their place in its order, whatever order they were shown in.
    view = applyEvent(view, user('u-c', 1, 2));
    view = applyEvent(view, user('u-b', 2, 3));
    expect(view.items.map(item => item.key)).toEqual(['u-a', 'u-c', 'u-b']);
    expect(view.items.every(item => !(item as { pending?: boolean }).pending)).toBe(true);

    view = failPending(addPending(view, 'd', 'fourth', 'message', 4), 'd', 'offline');
    // A reset drops what the server will send again and keeps what it never had.
    view = applyEvent(view, { type: 'open', epoch: 'e2', reset: true });
    expect(view.items).toMatchObject([{ key: 'u-d', failed: 'offline' }]);
    expect(view).toMatchObject({ epoch: 'e2', rev: 0, ready: false });
  });

  it('refuses a patch that does not fit what it holds', () => {
    const run: PageEvent = { type: 'item', item: { kind: 'run', key: 'r1', runId: 'r1', ord: 0, rev: 4, at: 1,
      state: { blocks: [{ kind: 'text', content: 'a', streaming: true }], reasoning: { content: '', active: false }, footer: 'streaming', terminal: 'running' } } };
    const view = applyEvent(emptyTranscript, run);
    const patch: PageEvent = { type: 'run', key: 'r1', runId: 'r1', at: 1, rev: 9, base: 7, from: 0, blocks: [],
      state: { reasoning: { content: '', active: false }, footer: null, terminal: 'done' } };
    expect(missedPatch(view, patch)).toBe(true);
    expect(applyEvent(view, patch)).toBe(view);
    expect(missedPatch(view, { ...patch, base: 4 })).toBe(false);
    expect(applyEvent(view, { ...patch, base: 4 }).items[0]).toMatchObject({ rev: 9, state: { blocks: [], terminal: 'done' } });
    // A block that grew is sent as what was added to it.
    const grown = applyEvent(view, { ...patch, base: 4, keep: 1, blocks: [{ kind: 'text', content: 'bc', streaming: true }, { kind: 'reasoning', content: 'why' }] });
    expect(grown.items[0]).toMatchObject({ state: { blocks: [{ kind: 'text', content: 'abc', streaming: true }, { kind: 'reasoning', content: 'why' }] } });
  });
});
