import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { FollowupRouter } from '../../../src/bot/followup';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { UserQuestions } from '../../../src/bot/user-questions';
import { CallbackAuth } from '../../../src/card/callback-auth';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { SessionCatalog } from '../../../src/session/catalog';
import { createFakeChannel } from '../../helpers/fake-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanups.splice(0).map(fn => fn())); });

async function harness(options: { auth?: boolean; timed?: boolean; mention?: boolean } = {}) {
  const tmp = await createTmpProfile('user-questions-');
  const channel = createFakeChannel();
  const activeRuns = new ActiveRuns();
  const pending = new PendingQueue(60_000, () => {});
  const catalog = new SessionCatalog(`${tmp.profile}/catalog.json`);
  const nonceStore = new CallbackNonceStore(`${tmp.profile}/nonces.json`);
  const auth = new CallbackAuth({ keys: [{ version: 1, secret: 'test-secret' }], nonceStore });
  const identity = { scopeId: 'oc_group:omt_topic', agentId: 'codex' as const, cwdRealpath: tmp.workspace, policyFingerprint: 'fp' };
  catalog.upsertActive({ ...identity, threadId: 'codex-thread' });
  const steer = vi.fn(async (_prompt: string, _messageId: string): Promise<'accepted' | 'inactive'> => 'accepted');
  const run = { runId: 'run-1', events: { async *[Symbol.asyncIterator]() {} }, steer,
    stop: vi.fn(async () => {}), waitForExit: async () => true };
  const handle = activeRuns.register(identity.scopeId, run);
  const message: NormalizedMessage = { messageId: 'om_origin', chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic',
    senderId: 'ou_user', content: 'task', rawContentType: 'text', resources: [], mentions: [], mentionedBot: false, mentionAll: false, createTime: 1 };
  const manager = new UserQuestions({ channel: channel as unknown as LarkChannel, auth: options.auth === false ? undefined : auth,
    activeRuns, pending, catalog, followups: new FollowupRouter(), isTimed: () => options.timed === true });
  const publish = () => manager.publish({ type: 'user_input', id: 'question-item', threadId: 'codex-thread', questions: [
    { title: '处理范围？', options: ['全部', '仅本次'] },
  ] }, { runId: run.runId, identity, message, replyTo: 'om_origin', mentionUser: options.mention !== false,
    allowQueue: !options.timed, isCancelled: () => handle.interrupted });
  const values = (): Array<Record<string, unknown>> => {
    const result: Array<Record<string, unknown>> = [];
    const walk = (v: unknown) => {
      if (!v || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      if (o.cmd === 'question.answer') result.push(o);
      Object.values(o).forEach(walk);
    };
    walk(channel.sent[0]?.content);
    return result;
  };
  const click = (payload: Record<string, unknown>, overrides: { operator?: string; scope?: string; messageId?: string; form?: Record<string, unknown>; identity?: typeof identity } = {}) =>
    manager.answer({ scope: overrides.scope ?? identity.scopeId, identity: overrides.identity ?? identity, formValue: overrides.form,
      evt: { chatId: 'oc_group', messageId: overrides.messageId ?? 'om_fake_1', operator: { openId: overrides.operator ?? 'ou_user' },
        action: { value: payload } } as CardActionEvent });
  cleanups.push(async () => { manager.close(); pending.cancelAll(); await Promise.all([catalog.flush(), nonceStore.flush()]); await tmp.cleanup(); });
  return { manager, publish, values, click, channel, activeRuns, pending, catalog, identity, run, steer, handle };
}

describe('native async question cards', () => {
  it('sends a standalone topic mention with signed choice buttons and free text', async () => {
    const h = await harness(); await h.publish();
    expect(h.channel.sent).toHaveLength(1);
    expect(h.channel.sent[0]?.options).toEqual({ replyTo: 'om_origin', replyInThread: true });
    const card = JSON.stringify(h.channel.sent[0]?.content);
    expect(card).toContain('<at id=\\"ou_user\\"></at>');
    expect(card).toContain('需要你回复');
    expect(h.values().map(v => v.choice)).toEqual([0, 1, 'text']);
    expect(h.values().every(v => String(v.bridge_token).startsWith('bridge_cb.v1.'))).toBe(true);
  });
  it('steers one click into the running task and updates the card without duplicate delivery', async () => {
    const h = await harness(); await h.publish();
    await Promise.all([h.click(h.values()[1]!), h.click(h.values()[0]!)]);
    expect(h.steer).toHaveBeenCalledTimes(1);
    expect(h.steer.mock.calls[0]?.[0]).toContain('仅本次');
    expect(h.pending.cancel(h.identity.scopeId)).toHaveLength(0);
    expect(JSON.stringify(h.channel.rawClient.requests)).toContain('已送入当前任务');
    expect(h.run.stop).not.toHaveBeenCalled();
  });
  it('accepts free text and does not consume an empty form submission', async () => {
    const h = await harness(); await h.publish();
    const payload = h.values()[2]!;
    await h.click(payload, { form: { answer: ' ' } });
    expect(h.steer).not.toHaveBeenCalled();
    await h.click(payload, { form: { answer: '只处理新消息' } });
    expect(h.steer.mock.calls[0]?.[0]).toContain('只处理新消息');
  });
  it('returns the settled card to the clicking client and keeps repeated answers settled', async () => {
    const h = await harness(); await h.publish();
    const payload = h.values()[0]!;
    const response = await h.click(payload);
    const update = h.channel.rawClient.requests.find(r => r.method === 'cardkit.v1.card.update')!;
    expect(response).toEqual({ card: { type: 'raw', data: (update.params as { cardJson: unknown }).cardJson } });
    const encoded = JSON.stringify(response);
    expect(encoded).toContain('已提交：全部');
    expect(encoded).not.toContain('需要你回复');
    expect(encoded).not.toContain('question.answer');
    expect(encoded).not.toContain('bridge_token');
    expect(await h.click(payload)).toEqual(response);
    expect(h.steer).toHaveBeenCalledOnce();
  });
  it.each(['operator', 'scope', 'carrier', 'choice', 'signature', 'policy'] as const)('rejects a mismatched %s', async kind => {
    const h = await harness(); await h.publish();
    const value = { ...h.values()[0]! };
    if (kind === 'choice') value.choice = 1;
    if (kind === 'signature') value.bridge_token = 'invalid';
    await h.click(value, { ...(kind === 'operator' ? { operator: 'ou_other' } : {}),
      ...(kind === 'scope' ? { scope: 'oc_group:omt_other' } : {}), ...(kind === 'carrier' ? { messageId: 'om_forwarded' } : {}),
      ...(kind === 'policy' ? { identity: { ...h.identity, policyFingerprint: 'changed' } } : {}) });
    expect(h.steer).not.toHaveBeenCalled();
    expect(h.pending.cancel(h.identity.scopeId)).toHaveLength(0);
  });
  it('queues a late answer only into the original, still-active session', async () => {
    const h = await harness(); await h.publish();
    h.activeRuns.unregister(h.identity.scopeId, h.run);
    await h.click(h.values()[1]!);
    const queued = h.pending.cancel(h.identity.scopeId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ threadId: 'omt_topic', senderId: 'ou_user' });
    expect(queued[0]?.content).toContain('仅本次');
  });
  it.each(['stopped', 'switched', 'archived', 'timed'] as const)('rejects late answers after %s', async kind => {
    const h = await harness({ timed: kind === 'timed' }); await h.publish();
    h.activeRuns.unregister(h.identity.scopeId, h.run);
    if (kind === 'stopped') h.activeRuns.interrupt(h.identity.scopeId);
    if (kind === 'switched') h.catalog.upsertActive({ ...h.identity, threadId: 'another-thread' });
    if (kind === 'archived') h.catalog.archiveActive(h.identity);
    await h.click(h.values()[0]!);
    expect(h.pending.cancel(h.identity.scopeId)).toHaveLength(0);
    expect(h.steer).not.toHaveBeenCalled();
  });
  it('does not replay when the running task might have received the answer', async () => {
    const h = await harness(); h.steer.mockRejectedValue(new Error('lost acknowledgement')); await h.publish();
    await h.click(h.values()[0]!);
    expect(h.pending.cancel(h.identity.scopeId)).toHaveLength(0);
    expect(JSON.stringify(h.channel.rawClient.requests)).toContain('无法确定答案是否送达');
  });
  it('does not send an old answer into a new run before its session is recorded', async () => {
    const h = await harness(); await h.publish();
    h.activeRuns.unregister(h.identity.scopeId, h.run);
    h.activeRuns.register(h.identity.scopeId, { ...h.run, runId: 'new-run' });
    await h.click(h.values()[0]!);
    expect(h.steer).not.toHaveBeenCalled();
    expect(h.pending.cancel(h.identity.scopeId)).toHaveLength(0);
  });
  it('falls back to a visible topic reminder when CardKit fails', async () => {
    const h = await harness(); vi.spyOn(h.channel, 'createCard').mockRejectedValue(new Error('CardKit unavailable'));
    await h.publish();
    expect(h.channel.sent[0]?.content).toMatchObject({ markdown: expect.stringContaining('处理范围？') });
    expect(h.channel.sent[0]?.options).toMatchObject({ replyInThread: true });
  });
  it('omits unsigned buttons and bot mentions', async () => {
    const h = await harness({ auth: false, mention: false }); await h.publish();
    expect(h.values()).toEqual([]);
    expect(JSON.stringify(h.channel.sent[0]?.content)).not.toContain('<at');
  });
  it('sends nothing for an already cancelled run', async () => {
    const h = await harness(); h.handle.interrupted = true; await h.publish();
    expect(h.channel.sent).toHaveLength(0);
  });
});
