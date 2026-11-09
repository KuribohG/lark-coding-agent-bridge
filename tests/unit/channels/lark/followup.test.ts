import { describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../../src/runtime/active-runs';
import { FollowupRouter } from '../../../../src/channels/lark/followup';
import type { AgentInput, AgentRun } from '../../../../src/agent/types';

function harness() {
  const activeRuns = new ActiveRuns();
  const run: AgentRun = { runId: 'r', capabilities: { finalAnswer: 'stream', input: 'active-session' },
    events: { async *[Symbol.asyncIterator]() {} }, stop: vi.fn(async () => {}), waitForExit: async () => true,
    sendInput: vi.fn(async ({ messageId }: AgentInput) => ({ status: 'accepted', messageId, scope: 'active-session' } as const)) };
  activeRuns.register('chat:topic', run);
  const router = new FollowupRouter();
  const deliver = (prepare = async () => 'supplement') => router.deliver({ scope: 'chat:topic', messageId: 'm', activeRuns, prepare });
  return { activeRuns, run, router, deliver };
}
function gate() { let resolve!: (value: string) => void; const promise = new Promise<string>(r => { resolve = r; }); return { promise, resolve }; }

describe('follow-up routing', () => {
  it('records accepted input and reports unknown receipts', async () => {
    const h = harness();
    h.run.sendInput = vi.fn(async input => ({ status: 'accepted', messageId: input.messageId, scope: 'active-turn' } as const));
    expect(await h.deliver()).toBe('accepted');
    expect(h.activeRuns.get('chat:topic')?.inputMessageIds).toContain('m');
    expect(h.run.sendInput).toHaveBeenCalledWith({ text: 'supplement', messageId: 'm' });
    h.run.sendInput = vi.fn(async input => ({ status: 'unknown', messageId: input.messageId, message: 'lost receipt' } as const));
    expect(await h.deliver()).toBe('unknown');
    expect(h.run.sendInput).toHaveBeenCalledTimes(1);
  });
  it('keeps preparation and delivery ordered', async () => {
    const h = harness(); const g = gate();
    const first = h.deliver(() => g.promise); const second = h.deliver(async () => 'second');
    await Promise.resolve(); expect(h.run.sendInput).not.toHaveBeenCalled();
    g.resolve('first');
    expect(await Promise.all([first, second])).toEqual(['accepted', 'accepted']);
    expect(vi.mocked(h.run.sendInput!).mock.calls.map(x => x[0].text)).toEqual(['first', 'second']);
    expect(h.run.stop).not.toHaveBeenCalled();
  });
  it('cancels input being prepared when /stop arrives, including a subsequent new run', async () => {
    const h = harness(); const g = gate(); const result = h.deliver(() => g.promise);
    await Promise.resolve(); h.activeRuns.interrupt('chat:topic');
    h.activeRuns.register('chat:topic', { ...h.run, runId: 'new' });
    g.resolve('old supplement');
    expect(await result).toBe('cancelled'); expect(h.run.sendInput).not.toHaveBeenCalled();
  });
  it('does not send a prepared message into another run or another topic', async () => {
    const h = harness(); const g = gate(); const result = h.deliver(() => g.promise);
    await Promise.resolve(); h.activeRuns.unregister('chat:topic', h.run); g.resolve('late');
    expect(await result).toBe('queued');
    expect(await h.router.deliver({ scope: 'chat:other', messageId: 'm', activeRuns: h.activeRuns, prepare: async () => 'other' })).toBe('queued');
    expect(h.run.sendInput).not.toHaveBeenCalled();
  });
  it('reports uncertain delivery without replaying', async () => {
    const h = harness(); vi.mocked(h.run.sendInput!).mockRejectedValue(new Error('lost response'));
    expect(await h.deliver()).toBe('unknown'); expect(h.run.sendInput).toHaveBeenCalledTimes(1);
  });
  it('does not queue after stop races with an inactive response', async () => {
    const h = harness();
    h.run.sendInput = async ({ messageId }) => { h.activeRuns.interrupt('chat:topic'); return { status: 'inactive', messageId }; };
    expect(await h.deliver()).toBe('cancelled');
  });
});
