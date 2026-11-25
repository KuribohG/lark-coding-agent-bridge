import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentQuestion, AgentQuestionMode } from '../../agent/types';
import { log } from '../../core/logger';
import { writeFileAtomic } from '../../platform/atomic-write';
import type { SequencedConversationEvent } from '../../runtime/conversation-events';
import type { Block, RunState } from '../../runtime/run-state';

/** A conversation as the page lists it. */
export interface WebConversation {
  id: string;
  title: string;
  /** Set once a person named the conversation; until then the title follows its first message. */
  named?: boolean;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  /** The latest thing said, cut short. */
  preview: string;
  /** The run that is going, while one is. Not stored. */
  activeRunId?: string;
}

interface ItemBase {
  /** Identifies the item within its conversation: a run's ID, a question's ID, otherwise one made here. */
  key: string;
  /** Position in the conversation; an item keeps it when it changes. */
  ord: number;
  /** Grows with every change in the conversation, so a follower can ask for what it has not seen. */
  rev: number;
  at: number;
}

export type TranscriptItem = ItemBase & (
  | { kind: 'user'; text: string; via: 'message' | 'input' | 'command' }
  | {
      kind: 'run'; runId: string; state: RunState; result?: string; error?: string; finishedAt?: number;
      /** The server stopped while this run was going, so how it ended is not known. */
      lost?: boolean;
    }
  | { kind: 'notice'; text: string; source: 'workflow' | 'command' | 'bridge' }
  | {
      kind: 'question'; id: string; runId: string; mode: AgentQuestionMode; questions: AgentQuestion[];
      /** What became of it, in words for the person; absent while it waits for an answer. */
      status?: string;
      answers?: string[][];
    }
);

type RunItem = Extract<TranscriptItem, { kind: 'run' }>;
type QuestionItem = Extract<TranscriptItem, { kind: 'question' }>;
type Unplaced<T> = T extends unknown ? Omit<T, 'ord' | 'rev' | 'at'> & { at?: number } : never;
/** An item before it has its place in a conversation. */
type Draft = Unplaced<TranscriptItem>;

/** A run's state without its blocks; `reasoningFrom` says how much of the reasoning the follower already has. */
type RunHead = Omit<RunItem, 'state' | 'kind' | 'key' | 'ord' | 'rev'> & { state: Omit<RunState, 'blocks'> };

export type TranscriptEvent =
  /** First on every connection. With `reset` the follower drops what it holds: the items that follow are the conversation's tail. */
  | { type: 'open'; epoch: string; reset: boolean }
  | { type: 'item'; item: TranscriptItem }
  /**
   * A going run changed. Its blocks before `from` are as the follower has them and `blocks` replace the rest;
   * the reasoning is what follows its first `reasoningFrom` characters.
   */
  | ({ type: 'run'; key: string; rev: number; base: number; from: number; blocks: Block[]; reasoningFrom: number } & RunHead)
  /** The connection has caught up. After a reset, `more` says whether older items exist before the position `first`. */
  | { type: 'ready'; rev: number; first?: number; more?: boolean }
  | { type: 'conversation'; conversation: WebConversation }
  | { type: 'gone' };

export interface TranscriptCursor {
  epoch?: string;
  since?: number;
  /** How many of the latest items a fresh follower is sent. */
  tail?: number;
}

interface LiveRun {
  /** Each block as it was last sent, serialized. */
  sent: string[];
  reasoning: string;
  pending?: RunState;
  timer?: NodeJS.Timeout;
  savedAt: number;
  unsaved: boolean;
}

interface Loaded {
  id: string;
  file: string;
  items: TranscriptItem[];
  byKey: Map<string, TranscriptItem>;
  rev: number;
  nextOrd: number;
  /** Lines in the file, of which only one per item still counts. */
  lines: number;
  listeners: Set<(event: TranscriptEvent) => void>;
  live: Map<string, LiveRun>;
  writes: Promise<void>;
  /** Writes asked for that have not reached the file yet. */
  writing: number;
  usedAt: number;
}

const INDEX_VERSION = 1;
const MAX_ID_LENGTH = 200;
const MAX_TITLE = 60;
const MAX_PREVIEW = 120;
const MAX_TOOL_OUTPUT = 8_000;
const MAX_TOOL_INPUT = 4_000;
const MAX_REASONING = 48_000;
const DEFAULT_TAIL = 60;
const MAX_PAGE = 200;
/** A going run reaches its followers at most this often. */
const RUN_FLUSH_MS = 50;
/** A going run is written down at most this often, so a stopped server loses little of it. */
const RUN_SAVE_MS = 5_000;
const MAX_IDLE_LOADED = 16;
const UNTITLED = '新对话';
const LOST_QUESTION = '服务已重启，这个提问不再等待回答';

/** Whether a conversation with this ID is recorded; others still run, but leave no history. */
export function recordable(id: string): boolean {
  return id.length > 0 && id.length <= MAX_ID_LENGTH && !/[\u0000-\u001f]/.test(id);
}

const clipText = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${text.slice(0, head)}\n… 省略 ${text.length - max} 个字符 …\n${text.slice(-tail)}`;
};

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Bounds what a run keeps of each tool call, so a long run stays showable. */
function clipState(state: RunState): RunState {
  return {
    ...state,
    reasoning: { ...state.reasoning, content: clipText(state.reasoning.content, MAX_REASONING) },
    blocks: state.blocks.map(block => {
      if (block.kind !== 'tool') return block;
      const { tool } = block;
      let input = tool.input;
      if (input !== undefined && typeof input !== 'string') {
        const serialized = JSON.stringify(input) ?? '';
        if (serialized.length > MAX_TOOL_INPUT) input = clipText(serialized, MAX_TOOL_INPUT);
      } else if (typeof input === 'string') input = clipText(input, MAX_TOOL_INPUT);
      return { kind: 'tool', tool: { ...tool, input, ...(tool.output === undefined ? {} : { output: clipText(tool.output, MAX_TOOL_OUTPUT) }) } };
    }),
  };
}

function settledState(state: RunState, terminal: RunState['terminal']): RunState {
  return {
    ...state,
    blocks: state.blocks.map(block => block.kind === 'text' && block.streaming ? { ...block, streaming: false }
      : block.kind === 'tool' && block.tool.status === 'running' ? { kind: 'tool', tool: { ...block.tool, status: 'error' } } : block),
    reasoning: { ...state.reasoning, active: false },
    footer: null,
    terminal: state.terminal === 'running' ? terminal : state.terminal,
  };
}

function answerText(state: RunState): string {
  if (state.finalText?.trim()) return state.finalText;
  for (let index = state.blocks.length - 1; index >= 0; index--) {
    const block = state.blocks[index]!;
    if (block.kind === 'text' && block.content.trim()) return block.content;
  }
  return state.errorMsg ?? '';
}

/**
 * The Web chat's record of its conversations: which exist, and what was said in each. The runtime keeps only what
 * a run needs to continue; this is what a person sees when they come back, in any browser.
 *
 * One JSON file lists the conversations. Each conversation has a file of its own to which an item is appended
 * every time it changes; the last line of a key is the item. A conversation's file is read when someone opens it.
 */
export class WebTranscripts {
  /** Changes with every start of the server: a cursor from an earlier one may point past what was written down. */
  readonly epoch = randomUUID();
  private readonly index = new Map<string, WebConversation>();
  private readonly active = new Map<string, string>();
  private readonly loaded = new Map<string, Loaded>();
  private readonly loading = new Map<string, Promise<Loaded>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly watchers = new Set<() => void>();
  private indexTimer?: NodeJS.Timeout;
  private indexWrite: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {}

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let raw: string;
    try { raw = await readFile(join(this.dir, 'index.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      const parsed = JSON.parse(raw) as { conversations?: WebConversation[] };
      for (const entry of parsed.conversations ?? []) {
        if (entry && typeof entry.id === 'string' && recordable(entry.id)) this.index.set(entry.id, entry);
      }
    } catch (err) {
      // The conversations' own files are intact; a list that cannot be read starts over rather than stopping the chat.
      log.warn('web', 'transcript-index-unreadable', { err: String(err) });
    }
  }

  /** Pinned conversations first, then the most recently active. */
  list(): WebConversation[] {
    return [...this.index.values()].map(entry => this.shown(entry))
      .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.updatedAt - a.updatedAt);
  }

  get(id: string): WebConversation | undefined {
    const entry = this.index.get(id);
    return entry ? this.shown(entry) : undefined;
  }

  /** Called on every change of the list; returns the function that stops it. */
  watch(listener: () => void): () => void {
    this.watchers.add(listener);
    return () => { this.watchers.delete(listener); };
  }

  /**
   * What a person sent. `messageId` is the page's own name for the message, so the page can match what it already
   * shows with the item recorded here.
   */
  addUser(id: string, text: string, via: 'message' | 'input' | 'command', messageId?: string): Promise<void> {
    return this.change(id, loaded => {
      const key = `u-${messageId && /^[A-Za-z0-9-]{8,64}$/.test(messageId) ? messageId : randomUUID()}`;
      if (loaded.byKey.has(key)) return;
      this.put(loaded, { kind: 'user', key, text, via });
      const entry = this.entry(id);
      // A conversation is called after the first thing asked of the agent in it, not after a command.
      if (!entry.named && entry.title === UNTITLED && via !== 'command') entry.title = oneLine(text, MAX_TITLE) || UNTITLED;
      this.touch(entry, text);
    });
  }

  /** What the bridge says outside any run. */
  addNotice(id: string, text: string, source: 'workflow' | 'command' | 'bridge'): Promise<void> {
    return this.change(id, loaded => {
      this.put(loaded, { kind: 'notice', key: `n-${randomUUID()}`, text, source });
      this.touch(this.entry(id), text);
    });
  }

  /** The answers a person gave, kept with the question so the conversation shows what was chosen. */
  recordAnswers(id: string, questionId: string, answers: string[][]): Promise<void> {
    return this.change(id, loaded => {
      const item = loaded.byKey.get(questionId);
      if (item?.kind === 'question') this.put(loaded, { ...item, answers });
    });
  }

  /** Takes one event of the runtime's conversation stream into the record. */
  observe(id: string, event: SequencedConversationEvent): void {
    if (!recordable(id) || this.closed) return;
    void this.change(id, loaded => this.apply(loaded, event))
      .catch(err => log.warn('web', 'transcript-observe-failed', { err: String(err) }));
  }

  async rename(id: string, title: string): Promise<WebConversation | undefined> {
    const entry = this.index.get(id);
    if (!entry) return undefined;
    entry.title = oneLine(title, MAX_TITLE) || UNTITLED;
    entry.named = true;
    this.indexChanged(id);
    return this.shown(entry);
  }

  async pin(id: string, pinned: boolean): Promise<WebConversation | undefined> {
    const entry = this.index.get(id);
    if (!entry) return undefined;
    if (pinned) entry.pinned = true; else delete entry.pinned;
    this.indexChanged(id);
    return this.shown(entry);
  }

  /** Forgets a conversation and what was said in it. False while one of its runs is going. */
  async remove(id: string): Promise<boolean> {
    if (this.active.has(id)) return false;
    await this.enqueue(id, async () => {
      const loaded = this.loaded.get(id);
      if (loaded) {
        await loaded.writes;
        for (const listener of [...loaded.listeners]) deliver(listener, { type: 'gone' });
        this.loaded.delete(id);
      }
      this.index.delete(id);
      await rm(this.file(id), { force: true });
    });
    this.indexChanged();
    return true;
  }

  /**
   * Follows a conversation: `open`, then the items the cursor has not seen (or the tail, for a fresh follower or
   * one of an earlier server), then `ready`, then every change as it happens. Returns the function that stops it.
   */
  async follow(id: string, cursor: TranscriptCursor, listener: (event: TranscriptEvent) => void): Promise<() => void> {
    return this.enqueue(id, async () => {
      const loaded = await this.transcript(id);
      const resumed = cursor.epoch === this.epoch && cursor.since !== undefined && cursor.since <= loaded.rev;
      deliver(listener, { type: 'open', epoch: this.epoch, reset: !resumed });
      if (resumed) {
        for (const item of loaded.items) if (item.rev > cursor.since!) deliver(listener, { type: 'item', item });
        deliver(listener, { type: 'ready', rev: loaded.rev });
      } else {
        const tail = Math.min(MAX_PAGE, Math.max(1, Math.trunc(cursor.tail ?? DEFAULT_TAIL)));
        const items = loaded.items.slice(-tail);
        for (const item of items) deliver(listener, { type: 'item', item });
        deliver(listener, { type: 'ready', rev: loaded.rev, first: items[0]?.ord ?? loaded.nextOrd, more: loaded.items.length > items.length });
      }
      loaded.listeners.add(listener);
      return () => { loaded.listeners.delete(listener); this.evict(); };
    });
  }

  /** Up to `limit` items before the position `before`, oldest first. */
  async page(id: string, before: number, limit: number): Promise<{ items: TranscriptItem[]; more: boolean }> {
    return this.enqueue(id, async () => {
      const loaded = await this.transcript(id);
      const older = loaded.items.filter(item => item.ord < before);
      const size = Math.min(MAX_PAGE, Math.max(1, Math.trunc(limit)));
      return { items: older.slice(-size), more: older.length > size };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.queues.values()]);
    for (const loaded of this.loaded.values()) {
      for (const [key, live] of loaded.live) {
        if (live.timer) clearTimeout(live.timer);
        this.flushRun(loaded, key, live);
        const item = loaded.byKey.get(key);
        if (item && live.unsaved) this.save(loaded, item);
      }
    }
    await Promise.allSettled([...this.loaded.values()].map(loaded => loaded.writes));
    if (this.indexTimer) { clearTimeout(this.indexTimer); this.indexTimer = undefined; this.writeIndex(); }
    await this.indexWrite;
  }

  private shown(entry: WebConversation): WebConversation {
    const activeRunId = this.active.get(entry.id);
    return { ...entry, ...(activeRunId ? { activeRunId } : {}) };
  }

  private file(id: string): string {
    return join(this.dir, `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.jsonl`);
  }

  /** Runs one thing at a time for a conversation, in the order asked. */
  private enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => {});
    this.queues.set(id, settled);
    void settled.then(() => { if (this.queues.get(id) === settled) this.queues.delete(id); });
    return next;
  }

  private change(id: string, apply: (loaded: Loaded) => void): Promise<void> {
    if (!recordable(id)) return Promise.resolve();
    return this.enqueue(id, async () => {
      apply(await this.transcript(id));
      this.evict();
    });
  }

  private entry(id: string): WebConversation {
    let entry = this.index.get(id);
    if (!entry) {
      const at = this.now();
      entry = { id, title: UNTITLED, createdAt: at, updatedAt: at, preview: '' };
      this.index.set(id, entry);
    }
    return entry;
  }

  private touch(entry: WebConversation, said: string): void {
    entry.updatedAt = this.now();
    const preview = oneLine(said, MAX_PREVIEW);
    if (preview) entry.preview = preview;
    this.indexChanged(entry.id);
  }

  private indexChanged(id?: string): void {
    const entry = id ? this.index.get(id) : undefined;
    if (entry) {
      const loaded = this.loaded.get(entry.id);
      if (loaded) for (const listener of [...loaded.listeners]) deliver(listener, { type: 'conversation', conversation: this.shown(entry) });
    }
    for (const watcher of [...this.watchers]) { try { watcher(); } catch { /* a watcher's failure is its own */ } }
    if (this.closed) { this.writeIndex(); return; }
    this.indexTimer ??= setTimeout(() => { this.indexTimer = undefined; this.writeIndex(); }, 150);
  }

  private writeIndex(): void {
    const body = JSON.stringify({ version: INDEX_VERSION, conversations: [...this.index.values()] });
    this.indexWrite = this.indexWrite.then(() => writeFileAtomic(join(this.dir, 'index.json'), body))
      .catch(err => log.warn('web', 'transcript-index-write-failed', { err: String(err) }));
  }

  private async transcript(id: string): Promise<Loaded> {
    const known = this.loaded.get(id);
    if (known) { known.usedAt = this.now(); return known; }
    let pending = this.loading.get(id);
    if (!pending) {
      pending = this.read(id).finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    const loaded = await pending;
    this.loaded.set(id, loaded);
    return loaded;
  }

  private async read(id: string): Promise<Loaded> {
    const loaded: Loaded = { id, file: this.file(id), items: [], byKey: new Map(), rev: 0, nextOrd: 0, lines: 0,
      listeners: new Set(), live: new Map(), writes: Promise.resolve(), writing: 0, usedAt: this.now() };
    let raw = '';
    try { raw = await readFile(loaded.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      loaded.lines++;
      let item: TranscriptItem;
      // A line cut short by a crash is the last one; whatever came before it stands.
      try { item = JSON.parse(line) as TranscriptItem; } catch { continue; }
      if (!item || typeof item.key !== 'string' || typeof item.ord !== 'number' || typeof item.rev !== 'number') continue;
      loaded.byKey.set(item.key, item);
      loaded.rev = Math.max(loaded.rev, item.rev);
      loaded.nextOrd = Math.max(loaded.nextOrd, item.ord + 1);
    }
    loaded.items = [...loaded.byKey.values()].sort((a, b) => a.ord - b.ord);
    // Nothing of an earlier server is still going.
    for (const item of loaded.items) {
      if (item.kind === 'run' && item.finishedAt === undefined) {
        this.put(loaded, { ...item, state: settledState(item.state, 'interrupted'), finishedAt: item.at, lost: true });
      } else if (item.kind === 'question' && item.status === undefined) {
        this.put(loaded, { ...item, status: LOST_QUESTION });
      }
    }
    if (loaded.lines > loaded.items.length * 2 + 200) this.compact(loaded);
    return loaded;
  }

  /** Adds an item or replaces the one with its key, tells the followers and writes it down. */
  private put(loaded: Loaded, item: Draft, options: { quiet?: boolean; save?: boolean } = {}): TranscriptItem {
    const known = loaded.byKey.get(item.key);
    const stored = { ...item, ord: known?.ord ?? loaded.nextOrd++, rev: ++loaded.rev, at: known?.at ?? item.at ?? this.now() } as TranscriptItem;
    loaded.byKey.set(stored.key, stored);
    if (known) loaded.items[loaded.items.indexOf(known)] = stored; else loaded.items.push(stored);
    if (!options.quiet) for (const listener of [...loaded.listeners]) deliver(listener, { type: 'item', item: stored });
    if (options.save !== false) this.save(loaded, stored);
    return stored;
  }

  private save(loaded: Loaded, item: TranscriptItem): void {
    const line = `${JSON.stringify(item)}\n`;
    loaded.lines++;
    loaded.writing++;
    loaded.writes = loaded.writes.then(() => appendFile(loaded.file, line, { mode: 0o600 }))
      .catch(err => log.warn('web', 'transcript-write-failed', { err: String(err) }))
      .finally(() => { loaded.writing--; });
  }

  private compact(loaded: Loaded): void {
    loaded.writing++;
    loaded.writes = loaded.writes.then(async () => {
      await writeFileAtomic(loaded.file, loaded.items.map(item => `${JSON.stringify(item)}\n`).join(''));
      loaded.lines = loaded.items.length;
    }).catch(err => log.warn('web', 'transcript-compact-failed', { err: String(err) }))
      .finally(() => { loaded.writing--; });
  }

  private apply(loaded: Loaded, event: SequencedConversationEvent): void {
    const entry = this.entry(loaded.id);
    switch (event.type) {
      case 'run.started': {
        if (loaded.byKey.has(event.runId)) return;
        this.put(loaded, { kind: 'run', key: event.runId, runId: event.runId,
          state: { blocks: [], reasoning: { content: '', active: false }, footer: 'thinking', terminal: 'running' } });
        loaded.live.set(event.runId, { sent: [], reasoning: '', savedAt: this.now(), unsaved: false });
        this.active.set(loaded.id, event.runId);
        this.indexChanged(loaded.id);
        return;
      }
      case 'run.state': {
        const live = loaded.live.get(event.runId);
        // A state without its start belongs to a run this record never took up.
        if (!live) return;
        live.pending = event.state;
        if (event.state.terminal !== 'running') {
          if (live.timer) { clearTimeout(live.timer); live.timer = undefined; }
          this.flushRun(loaded, event.runId, live);
          return;
        }
        live.timer ??= setTimeout(() => {
          live.timer = undefined;
          this.flushRun(loaded, event.runId, live);
        }, RUN_FLUSH_MS);
        return;
      }
      case 'run.finished':
      case 'run.failed': {
        const live = loaded.live.get(event.runId);
        const item = loaded.byKey.get(event.runId);
        if (!live || item?.kind !== 'run') return;
        if (live.timer) { clearTimeout(live.timer); live.timer = undefined; }
        this.flushRun(loaded, event.runId, live);
        const current = loaded.byKey.get(event.runId) as RunItem;
        const failed = event.type === 'run.failed';
        const result = failed ? 'failed' : event.result;
        const finished: RunItem = { ...current,
          state: settledState(current.state, result === 'completed' ? 'done' : result === 'stopped' ? 'interrupted' : 'error'),
          result, finishedAt: this.now(), ...(failed ? { error: event.error } : {}) };
        loaded.live.delete(event.runId);
        this.put(loaded, finished);
        if (this.active.get(loaded.id) === event.runId) this.active.delete(loaded.id);
        this.touch(entry, answerText(finished.state));
        return;
      }
      case 'run.question': {
        this.put(loaded, { kind: 'question', key: event.id, id: event.id, runId: event.runId, mode: event.mode,
          questions: event.questions.map(question => ({ ...question, options: [...question.options] })) });
        this.touch(entry, event.questions[0]?.question ?? '');
        return;
      }
      case 'run.question.settled': {
        const item = loaded.byKey.get(event.id);
        if (item?.kind === 'question') this.put(loaded, { ...item, status: event.status || '已回答' } satisfies QuestionItem);
        return;
      }
      case 'notice':
        this.put(loaded, { kind: 'notice', key: `n-${randomUUID()}`, text: event.text, source: 'workflow' });
        this.touch(entry, event.text);
        return;
    }
  }

  /** Sends a going run's latest state to the followers as what changed since the last one sent. */
  private flushRun(loaded: Loaded, key: string, live: LiveRun): void {
    const item = loaded.byKey.get(key);
    const pending = live.pending;
    live.pending = undefined;
    if (!pending || item?.kind !== 'run') return;
    const state = clipState(pending);
    const serialized = state.blocks.map(block => JSON.stringify(block));
    let from = 0;
    while (from < serialized.length && from < live.sent.length && serialized[from] === live.sent[from]) from++;
    const reasoning = state.reasoning.content;
    const reasoningFrom = reasoning.startsWith(live.reasoning) ? live.reasoning.length : 0;
    live.sent = serialized;
    live.reasoning = reasoning;
    const base = item.rev;
    const due = this.now() - live.savedAt >= RUN_SAVE_MS;
    const stored = this.put(loaded, { ...item, state }, { quiet: true, save: due }) as RunItem;
    live.unsaved = !due;
    if (due) live.savedAt = this.now();
    const { blocks, ...head } = state;
    const event: TranscriptEvent = { type: 'run', key, rev: stored.rev, base, from, blocks: blocks.slice(from), reasoningFrom,
      runId: stored.runId, at: stored.at, state: { ...head, reasoning: { ...head.reasoning, content: reasoning.slice(reasoningFrom) } } };
    for (const listener of [...loaded.listeners]) deliver(listener, event);
  }

  /** Lets go of conversations nobody follows and nothing runs in, beyond the few most recently used. */
  private evict(): void {
    const idle = [...this.loaded.values()].filter(loaded => loaded.listeners.size === 0 && loaded.live.size === 0
      && loaded.writing === 0 && !this.queues.has(loaded.id));
    if (idle.length <= MAX_IDLE_LOADED) return;
    idle.sort((a, b) => a.usedAt - b.usedAt);
    for (const loaded of idle.slice(0, idle.length - MAX_IDLE_LOADED)) this.loaded.delete(loaded.id);
  }
}

/** One follower's failure must not reach the record or the other followers. */
function deliver(listener: (event: TranscriptEvent) => void, event: TranscriptEvent): void {
  try { listener(event); } catch { /* the transport that threw closes itself */ }
}
