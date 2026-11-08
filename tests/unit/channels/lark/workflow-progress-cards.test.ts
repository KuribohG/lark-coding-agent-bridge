import type { NormalizedMessage } from '@larksuite/channel';
import type { WorkflowState } from '@kuribohg/agent-workflows';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowProgressCards } from '../../../../src/channels/lark/workflow-progress-cards';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function workflowState(patch: Partial<WorkflowState> = {}): WorkflowState {
  return { workflowId: 'wf-1', root: { scopeId: 'scope' }, definition: { id: 'script' }, goal: 'review the design', status: 'active',
    createdAt: Date.now(), deadlineAt: Date.now() + 3_600_000, tasks: [], artifacts: [], events: [], sessions: [], stateVersion: 1,
    script: { name: 'review', status: 'running', logs: [] }, ...patch } as unknown as WorkflowState;
}

function fixture(path?: string) {
  let current = workflowState();
  const changes = new EventEmitter();
  const kernel = {
    state: vi.fn((scope: string, workflowId?: string) => scope === 'scope' && workflowId === current.workflowId ? current : undefined),
    onChange: (scope: string, listener: () => void) => { changes.on(scope, listener); return () => { changes.off(scope, listener); }; },
  };
  const channel = {
    createCard: vi.fn(async (_card: object) => ({ cardId: 'card-1' })),
    send: vi.fn(async (_chat: string, _content: object, _options?: object) => ({ messageId: 'om_card' })),
    updateCard: vi.fn(async (_message: string, _card: object) => {}),
    updateCardById: vi.fn(async (_card: string, _json: object, _sequence: number) => {}),
  };
  const origins = new Map([['scope', { chatId: 'oc_chat', messageId: 'om_origin', threadId: 'omt_topic' } as unknown as NormalizedMessage]]);
  const cards = new WorkflowProgressCards({ channel: channel as never, kernel: kernel as never, origins, path, minIntervalMs: 0, refreshMs: 60_000 });
  closers.push(() => cards.close());
  const change = (patch: Partial<WorkflowState>) => { current = { ...current, ...patch }; changes.emit('scope'); };
  return { cards, channel, kernel, change, state: () => current, listeners: () => changes.listenerCount('scope') };
}

const content = (card: object) => JSON.stringify(card);

describe('workflow progress cards', () => {
  it('sends one card beside the plan, edits it on change and stops after the workflow settles', async () => {
    const f = fixture();
    await f.cards.start();
    f.cards.track(f.state());
    f.cards.track(f.state());
    await vi.waitFor(() => expect(f.channel.send).toHaveBeenCalledTimes(1));
    expect(f.channel.send).toHaveBeenCalledWith('oc_chat', { cardId: 'card-1' }, { replyTo: 'om_origin', replyInThread: true });
    expect(content(f.channel.createCard.mock.calls[0]![0])).toContain('运行中');

    f.change({ script: { ...f.state().script!, phase: 'stage two' } });
    await vi.waitFor(() => expect(f.channel.updateCardById).toHaveBeenCalledTimes(1));
    expect(f.channel.updateCardById.mock.calls[0]![2]).toBe(1);
    expect(content(f.channel.updateCardById.mock.calls[0]![1])).toContain('stage two');

    // A save that changes nothing visible does not rewrite the card.
    f.change({ stateVersion: 2 });
    await f.cards.flush();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.channel.updateCardById).toHaveBeenCalledTimes(1);

    f.change({ status: 'completed' });
    await vi.waitFor(() => expect(f.channel.updateCardById).toHaveBeenCalledTimes(2));
    const final = content(f.channel.updateCardById.mock.calls[1]![1]);
    expect(final).toContain('已完成');
    expect(final).toContain('green');
    expect(final).not.toContain('自动刷新');
    expect(f.listeners()).toBe(0);
  });

  it('keeps editing the same card after a restart and falls back to inline cards without CardKit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-cards-')); dirs.push(dir);
    const path = join(dir, 'workflow-progress-cards.json');
    const first = fixture(path);
    await first.cards.start();
    first.cards.track(first.state());
    await vi.waitFor(() => expect(first.channel.send).toHaveBeenCalledTimes(1));
    first.change({ script: { ...first.state().script!, phase: 'later' } });
    await vi.waitFor(() => expect(first.channel.updateCardById).toHaveBeenCalledTimes(1));
    await first.cards.close();
    expect(JSON.parse(await readFile(path, 'utf8')).cards[0]).toMatchObject({ workflowId: 'wf-1', messageId: 'om_card', cardId: 'card-1', sequence: 1 });

    const restarted = fixture(path);
    restarted.change({ status: 'interrupted' });
    await restarted.cards.start();
    await vi.waitFor(() => expect(restarted.channel.updateCardById).toHaveBeenCalledTimes(1));
    expect(restarted.channel.send).not.toHaveBeenCalled();
    // A lost write before the stop must not make CardKit reject the next sequence.
    expect(restarted.channel.updateCardById.mock.calls[0]![2]).toBeGreaterThan(1);
    expect(content(restarted.channel.updateCardById.mock.calls[0]![1])).toContain('已中断');

    const inline = fixture();
    inline.channel.createCard.mockRejectedValueOnce(new Error('cardkit unavailable'));
    await inline.cards.start();
    inline.cards.track(inline.state());
    await vi.waitFor(() => expect(inline.channel.send).toHaveBeenCalledTimes(1));
    expect(inline.channel.send.mock.calls[0]![1]).toHaveProperty('card');
    inline.change({ status: 'cancelled' });
    await vi.waitFor(() => expect(inline.channel.updateCard).toHaveBeenCalledWith('om_card', expect.anything()));
    expect(inline.channel.updateCardById).not.toHaveBeenCalled();
  });

  it('ignores child workflows and scopes without a chat destination', async () => {
    const f = fixture();
    await f.cards.start();
    f.cards.track(workflowState({ parent: { workflowId: 'parent' } as WorkflowState['parent'] }));
    f.cards.track(workflowState({ root: { scopeId: 'elsewhere' } as WorkflowState['root'] }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.channel.createCard).not.toHaveBeenCalled();
    expect(f.listeners()).toBe(0);
  });
});
