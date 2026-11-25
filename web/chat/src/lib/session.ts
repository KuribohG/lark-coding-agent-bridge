import { ApiError, type Api } from './api';
import { follow, type Link } from './stream';
import { activeRun, addPending, applyEvent, dropItem, emptyTranscript, failPending, missedPatch, prependItems, type TranscriptView } from './transcript';
import type { Conversation, ConversationState, Meta, PageEvent } from './types';

export interface SessionState {
  link: Link;
  meta?: Meta;
  /** Why the page could not start, when it could not. */
  fatal?: string;
  conversations: Conversation[];
  /** The list has arrived at least once. */
  listed: boolean;
  /** Absent for a conversation that has not been started: it gets its ID with its first message. */
  conversationId?: string;
  view: TranscriptView;
  /** Engine, directory and model of the open conversation. */
  engine?: ConversationState;
  /** A run the server accepted that has not appeared in the conversation yet. */
  starting?: string;
  loadingOlder: boolean;
}

/** Works where `crypto.randomUUID` does not: a page served over plain HTTP from another host. */
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Where the page's address says it is; a browser keeps it in the URL, so a conversation can be linked to and reloaded. */
export interface Route {
  current(): string | undefined;
  /** `replace` keeps the browser's history as it is: the address changed, the place did not. */
  go(id: string | undefined, replace?: boolean): void;
  onChange(listener: (id: string | undefined) => void): void;
}

/**
 * Everything the page knows and does, apart from how it looks: the list of conversations, the open one, and the
 * connection that keeps both current. Components read its state and call its methods.
 */
export class Session {
  private state: SessionState = { link: 'connecting', conversations: [], listed: false, view: emptyTranscript, loadingOlder: false };
  private readonly listeners = new Set<() => void>();
  private connection?: AbortController;
  private notifying = false;

  constructor(readonly api: Api, private readonly route: Route) {}

  getState = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(change: Partial<SessionState>): void {
    this.state = { ...this.state, ...change };
    if (this.notifying) return;
    this.notifying = true;
    // A burst of events from one read of the connection draws once.
    queueMicrotask(() => {
      this.notifying = false;
      for (const listener of [...this.listeners]) listener();
    });
  }

  async start(): Promise<void> {
    this.route.onChange(id => { if (id !== this.state.conversationId) this.show(id); });
    this.show(this.route.current());
    try { this.set({ meta: await this.api.meta() }); }
    catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) this.set({ link: 'unauthorized' });
      else this.set({ fatal: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Lets go of the connection; a page that is closing needs nothing else. */
  close(): void {
    this.connection?.abort();
  }

  /** Opens a conversation, or the empty page of a new one. */
  open(id: string | undefined): void {
    this.route.go(id);
    if (id !== this.state.conversationId || !id) this.show(id);
  }

  private show(id: string | undefined): void {
    this.set({ conversationId: id, view: emptyTranscript, engine: undefined, starting: undefined, loadingOlder: false });
    this.connect();
    void this.refreshEngine();
  }

  private connect(): void {
    this.connection?.abort();
    const connection = this.connection = new AbortController();
    const id = this.state.conversationId;
    void follow({
      api: this.api,
      signal: connection.signal,
      query: () => {
        const query = new URLSearchParams();
        const { view } = this.state;
        if (id) {
          query.set('conversationId', id);
          if (view.epoch && view.rev > 0) { query.set('epoch', view.epoch); query.set('since', String(view.rev)); }
        }
        return query;
      },
      link: link => { if (!connection.signal.aborted) this.set({ link }); },
      event: event => { if (!connection.signal.aborted) this.take(event); },
    });
  }

  private take(event: PageEvent): void {
    switch (event.type) {
      case 'ping':
        return;
      case 'conversations':
        this.set({ conversations: event.conversations, listed: true });
        return;
      case 'conversation':
        this.set({ conversations: this.state.conversations.map(known => known.id === event.conversation.id ? event.conversation : known) });
        return;
      default: {
        if (missedPatch(this.state.view, event)) {
          // The view fell out of step with the server; forget the cursor and take the conversation again.
          this.set({ view: { ...this.state.view, epoch: undefined } });
          this.connect();
          return;
        }
        const view = applyEvent(this.state.view, event);
        const starting = this.state.starting && view.items.some(item => item.key === this.state.starting) ? undefined : this.state.starting;
        if (view !== this.state.view || starting !== this.state.starting) this.set({ view, starting });
      }
    }
  }

  private async refreshEngine(): Promise<void> {
    const id = this.state.conversationId ?? `draft-${uuid()}`;
    try {
      const engine = await this.api.state(id);
      if ((this.state.conversationId ?? id) === id) this.set({ engine });
    } catch { /* the header simply shows less */ }
  }

  /** The run going in the open conversation, by what the conversation shows or what the list says. */
  runningId(): string | undefined {
    const { view, conversationId, conversations, starting } = this.state;
    return activeRun(view)?.runId ?? conversations.find(known => known.id === conversationId)?.activeRunId ?? starting;
  }

  /**
   * Sends what the person typed: a command to the bridge, a message that starts a run, or, while a run is going,
   * more input for it. Throws with words for the person when it could not be sent at all.
   */
  async send(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    let id = this.state.conversationId;
    if (!id) {
      id = uuid();
      this.route.go(id, true);
      this.set({ conversationId: id, view: { ...emptyTranscript, ready: true } });
      this.connect();
    }
    const messageId = uuid();
    const command = text.startsWith('/');
    const runId = command ? undefined : this.runningId();
    const via = command ? 'command' : runId ? 'input' : 'message';
    this.set({ view: addPending(this.state.view, messageId, text, via, Date.now()) });
    const sameConversation = () => this.state.conversationId === id;
    try {
      if (command) {
        await this.api.command(id, text, messageId);
        void this.refreshEngine();
      } else if (runId) {
        const receipt = await this.api.input(id, runId, text, messageId);
        if (receipt.status !== 'accepted') {
          throw new Error(receipt.status === 'unsupported' ? '当前引擎不支持在运行中补充消息，请等它完成。'
            : receipt.status === 'unknown' ? '不确定补充消息是否送达，请不要重复发送。' : '这次运行刚刚结束，请重新发送。');
        }
      } else {
        const started = await this.api.send(id, text, messageId);
        if (sameConversation() && !this.state.view.items.some(item => item.key === started.runId)) this.set({ starting: started.runId });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A refusal is in the conversation's record already, with its reason; anything else never got there.
      const recorded = error instanceof ApiError && error.status === 409;
      if (sameConversation() && !recorded) this.set({ view: failPending(this.state.view, messageId, reason) });
      if (!recorded) throw error;
    }
  }

  /** Takes a message that could not be sent off the screen. */
  dismiss(key: string): void {
    this.set({ view: dropItem(this.state.view, key) });
  }

  async stop(): Promise<void> {
    const { conversationId } = this.state;
    const runId = this.runningId();
    if (conversationId && runId) await this.api.stop(conversationId, runId);
  }

  async answer(requestId: string, answers: string[][]): Promise<{ settled: boolean; message: string }> {
    return this.api.answer(this.state.conversationId!, requestId, answers);
  }

  async setEngine(agent: string): Promise<void> {
    const id = this.state.conversationId;
    if (!id) {
      // A conversation that does not exist yet has no engine to change; it is created to carry the choice.
      const created = uuid();
      this.route.go(created, true);
      this.set({ conversationId: created, view: { ...emptyTranscript, ready: true } });
      this.connect();
    }
    await this.api.setEngine(this.state.conversationId!, agent);
    await this.refreshEngine();
  }

  async rename(id: string, title: string): Promise<void> { await this.api.update(id, { title }); }
  async pin(id: string, pinned: boolean): Promise<void> { await this.api.update(id, { pinned }); }

  async remove(id: string): Promise<void> {
    await this.api.remove(id);
    if (this.state.conversationId === id) this.open(undefined);
  }

  async loadOlder(): Promise<void> {
    const { conversationId, view, loadingOlder } = this.state;
    if (!conversationId || !view.more || loadingOlder) return;
    this.set({ loadingOlder: true });
    try {
      const page = await this.api.items(conversationId, view.first);
      if (this.state.conversationId === conversationId) this.set({ view: prependItems(this.state.view, page.items, page.more) });
    } finally { this.set({ loadingOlder: false }); }
  }
}
