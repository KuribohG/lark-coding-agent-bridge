import type { ConversationIdentity, ConversationRuntime } from '../../runtime/conversation';
import type { ConversationStreamEvent } from '../../runtime/conversation-events';
import type { RunState } from '../../runtime/run-state';
import type { SlackDisplayConfig } from '../../config/channel-display';
import { log } from '../../core/logger';
import type { SlackApi } from './api';
import { parseSlackConversationId } from './conversation-id';
import { boundSlackText, splitSlackText, toSlackMrkdwn } from './format';
import { renderSlackState } from './output';

export interface SlackEventMirrorOptions {
  api: SlackApi;
  display: SlackDisplayConfig;
  progressIntervalMs?: number;
  now?: () => number;
}

const DEFAULT_PROGRESS_INTERVAL_MS = 1_200;

interface RunView {
  state?: RunState;
  messageTs?: string;
  lastText: string;
  lastUpdateAt: number;
}

/**
 * Mirrors a conversation's event stream into its Slack thread. Slack renders
 * its own `runtime.start()` runs from their output plugin; this covers the
 * runs the runtime starts itself (workflow turns, worker-report wakes) and
 * the notices a workflow publishes, which otherwise only reach the web UI.
 */
export class SlackEventMirror {
  private readonly subscriptions = new Map<string, Promise<(() => void) | undefined>>();
  private readonly views = new Map<string, RunView>();
  private readonly now: () => number;
  private closing = false;

  constructor(private readonly options: SlackEventMirrorOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Subscribes this conversation once; repeated calls keep the first
   * subscription. Awaiting it guarantees no workflow turn starts unwatched.
   */
  async watch(runtime: ConversationRuntime, identity: ConversationIdentity): Promise<void> {
    if (this.closing) return;
    const key = `${identity.actorId}\u0000${identity.conversationId}`;
    const existing = this.subscriptions.get(key);
    if (existing) {
      await existing;
      return;
    }
    const subscription = runtime.subscribe(identity, {}, event => {
      void this.handle(identity.conversationId, event).catch(error => {
        log.warn('slack', 'event-mirror-failed', {
          conversationId: identity.conversationId,
          err: error instanceof Error ? error.message : String(error),
        });
      });
    }).catch(error => {
      log.warn('slack', 'event-subscribe-failed', {
        conversationId: identity.conversationId,
        err: error instanceof Error ? error.message : String(error),
      });
      this.subscriptions.delete(key);
      return undefined;
    });
    this.subscriptions.set(key, subscription);
    await subscription;
  }

  /** Routes one conversation event into the thread its conversation belongs to. */
  async handle(conversationId: string, event: ConversationStreamEvent): Promise<void> {
    if (event.type === 'notice') {
      await this.post(conversationId, event.text);
      return;
    }
    // Slack has no answer UI, so run.question events carry nothing it can show.
    if (event.type === 'stream.opened' || event.type === 'run.question' || event.type === 'run.question.settled') return;
    const key = `${conversationId}\u0000${event.runId}`;
    const view = this.views.get(key) ?? { lastText: '', lastUpdateAt: 0 };
    if (event.type === 'run.started') {
      this.views.set(key, view);
      return;
    }
    if (event.type === 'run.state') {
      view.state = event.state;
      this.views.set(key, view);
      if (event.state.terminal === 'running' && !this.options.display.show_progress) return;
      const text = toSlackMrkdwn(renderSlackState(event.state, this.options.display));
      if (!text || text === view.lastText) return;
      const interval = this.options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
      if (event.state.terminal === 'running' && view.messageTs && this.now() - view.lastUpdateAt < interval) return;
      await this.show(conversationId, view, text, false);
      return;
    }
    this.views.delete(key);
    const text = event.type === 'run.failed'
      ? `*Agent failed:* ${event.error}`
      : view.state
        ? toSlackMrkdwn(renderSlackState(view.state, this.options.display, true))
        : 'Run finished without a text response.';
    await this.show(conversationId, view, text, true);
  }

  close(): void {
    this.closing = true;
    for (const subscription of this.subscriptions.values()) {
      void subscription.then(unsubscribe => unsubscribe?.()).catch(() => {});
    }
    this.subscriptions.clear();
    this.views.clear();
  }

  private async post(conversationId: string, markdown: string): Promise<void> {
    const target = parseSlackConversationId(conversationId);
    if (!target) return;
    for (const chunk of splitSlackText(toSlackMrkdwn(markdown))) {
      await this.options.api.postMessage({ channel: target.channel, threadTs: target.threadTs, text: chunk });
    }
  }

  /** Keeps one message per run: progress updates it in place, the result replaces it. */
  private async show(conversationId: string, view: RunView, text: string, final: boolean): Promise<void> {
    const target = parseSlackConversationId(conversationId);
    if (!target) return;
    const chunks = final ? splitSlackText(text) : [text];
    const first = chunks.shift() ?? text;
    if (!view.messageTs) {
      view.messageTs = await this.options.api.postMessage({
        channel: target.channel, threadTs: target.threadTs, text: boundSlackText(first),
      });
    } else {
      await this.options.api.updateMessage({
        channel: target.channel, ts: view.messageTs, text: boundSlackText(first),
      });
    }
    view.lastText = text;
    view.lastUpdateAt = this.now();
    for (const chunk of chunks) {
      await this.options.api.postMessage({ channel: target.channel, threadTs: target.threadTs, text: chunk });
    }
  }
}
