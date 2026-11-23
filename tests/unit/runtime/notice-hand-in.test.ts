import { describe, expect, it, vi } from 'vitest';
import { NOTICE_PROMPT_MAX } from '../../../src/runtime/agent-entry';
import { NOTICE_GAP_MS, NOTICE_GATHER_MS, NoticeHandIn, type PendingNotice } from '../../../src/runtime/notice-hand-in';

function harness(answer: 'accepted' | 'queued' | 'cancelled' | 'unknown' = 'accepted') {
  let now = 1_000_000;
  const pending: PendingNotice[] = [];
  const steer = vi.fn(async (_scope: string, _messageId: string, _text: string) => answer);
  // What the kernel does: a notice that was handed in is no longer undelivered.
  const markNotified = vi.fn((_scope: string, ids: string[], _delivered: boolean) => {
    for (const id of ids) pending.splice(pending.findIndex(notice => notice.id === id), 1);
  });
  const handIn = new NoticeHandIn({ undelivered: () => [...pending], steer, markNotified, now: () => now });
  const raise = (kind: string, id = `n${pending.length + 1}`) => pending.push({ id, kind, summary: `${kind} ${id}`, createdAt: now });
  return { handIn, pending, steer, markNotified, raise, pass: (ms: number) => { now += ms; } };
}

describe('workflow notices for a main agent that is in a turn', () => {
  it('hands a reply into the turn at once, and settles it as delivered', async () => {
    const h = harness();
    await h.handIn.run('chat');
    expect(h.steer).not.toHaveBeenCalled();
    h.raise('worker_reply', 'reply');
    await h.handIn.run('chat');
    expect(h.steer).toHaveBeenCalledWith('chat', expect.stringMatching(/^workflow-notices:/), expect.stringContaining('[worker_reply] worker_reply reply（事件 reply）'));
    expect(h.steer.mock.calls[0]![2]).toContain('这不是用户输入');
    expect(h.markNotified).toHaveBeenCalledWith('chat', ['reply'], true);
  });

  it('gathers reports of how things stand, and sends them along with a reply that does not wait', async () => {
    const h = harness();
    h.raise('swarm_attention', 'dry');
    h.pass(NOTICE_GAP_MS);
    h.raise('review_due', 'review');
    await h.handIn.run('chat');
    expect(h.steer).not.toHaveBeenCalled();
    // The first of them has waited long enough: both go in as one message.
    h.pass(NOTICE_GATHER_MS - NOTICE_GAP_MS);
    await h.handIn.run('chat');
    expect(h.steer).toHaveBeenCalledOnce();
    expect(h.markNotified).toHaveBeenCalledWith('chat', ['dry', 'review'], true);

    h.pass(NOTICE_GAP_MS);
    h.raise('swarm_attention', 'dry-again');
    h.raise('worker_reply', 'reply');
    await h.handIn.run('chat');
    expect(h.markNotified).toHaveBeenLastCalledWith('chat', ['dry-again', 'reply'], true);
  });

  it('looks at a turn once per gap, and sends what one message does not hold in the next', async () => {
    const h = harness();
    for (let n = 0; n < NOTICE_PROMPT_MAX + 2; n++) h.raise('worker_reply');
    await h.handIn.run('chat');
    await h.handIn.run('chat');
    expect(h.steer).toHaveBeenCalledOnce();
    expect(h.steer.mock.calls[0]![2]).toContain(`产生了 ${NOTICE_PROMPT_MAX} 条通知`);
    expect(h.pending.map(notice => notice.id)).toEqual([`n${NOTICE_PROMPT_MAX + 1}`, `n${NOTICE_PROMPT_MAX + 2}`]);
    h.pass(NOTICE_GAP_MS);
    await h.handIn.run('chat');
    expect(h.steer).toHaveBeenCalledTimes(2);
    expect(h.pending).toEqual([]);
  });

  it('leaves the notices for the wake when the turn cannot take them, and does not repeat one whose receipt was lost', async () => {
    for (const answer of ['queued', 'cancelled'] as const) {
      const h = harness(answer);
      h.raise('worker_reply');
      await h.handIn.run('chat');
      expect(h.steer).toHaveBeenCalledOnce();
      expect(h.markNotified).not.toHaveBeenCalled();
      // It is tried again once the gap has passed, not on every pass of the scheduler.
      await h.handIn.run('chat');
      expect(h.steer).toHaveBeenCalledOnce();
      h.pass(NOTICE_GAP_MS);
      await h.handIn.run('chat');
      expect(h.steer).toHaveBeenCalledTimes(2);
    }
    const lost = harness('unknown');
    lost.raise('worker_reply', 'reply');
    await lost.handIn.run('chat');
    // Not delivered for certain: it stays pending in the status, and is not sent a second time.
    expect(lost.markNotified).toHaveBeenCalledWith('chat', ['reply'], false);
  });
});
