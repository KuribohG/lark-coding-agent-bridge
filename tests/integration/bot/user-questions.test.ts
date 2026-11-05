import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { FollowupRouter } from '../../../src/bot/followup';
import { PendingQueue } from '../../../src/bot/pending-queue';
import type { AgentQuestion, AgentQuestionAnswer, AgentRun } from '../../../src/agent/types';
import { UserQuestions } from '../../../src/channels/lark/question-cards';
import { CallbackAuth } from '../../../src/card/callback-auth';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { respondToCardAction } from '../../../src/card/response';
import { SessionCatalog } from '../../../src/session/catalog';
import { createFakeChannel } from '../../helpers/fake-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(cleanups.splice(0).map(fn => fn())); });

async function harness(options: { auth?: boolean; timed?: boolean; mention?: boolean; mode?: 'async' | 'blocking';
  questions?: AgentQuestion[]; native?: 'accepted' | 'inactive'; blockingTimeoutMs?: number } = {}) {
  const tmp = await createTmpProfile('user-questions-');
  const channel = createFakeChannel();
  const activeRuns = new ActiveRuns();
  const pending = new PendingQueue(60_000, () => {});
  const catalog = new SessionCatalog(`${tmp.profile}/catalog.json`);
  const nonceStore = new CallbackNonceStore(`${tmp.profile}/nonces.json`);
  const auth = new CallbackAuth({ keys: [{ version: 1, secret: 'test-secret' }], nonceStore });
  const codexIdentity = { scopeId: 'oc_group:omt_topic', agentId: 'codex' as const, cwdRealpath: tmp.workspace, policyFingerprint: 'fp' };
  catalog.upsertActive({ ...codexIdentity, threadId: 'codex-thread' });
  const claudeIdentity = { ...codexIdentity, agentId: 'claude' as const };
  const identity: typeof codexIdentity | typeof claudeIdentity = options.mode === 'blocking' ? claudeIdentity : codexIdentity;
  catalog.upsertActive({ ...claudeIdentity, sessionId: 'claude-session' });
  const steer = vi.fn(async (_prompt: string, _messageId: string): Promise<'accepted' | 'inactive'> => 'accepted');
  const answerUserInput = vi.fn(async (_id: string, _answer: AgentQuestionAnswer): Promise<'accepted' | 'inactive'> => options.native ?? 'accepted');
  const run: AgentRun = { runId: 'run-1', capabilities: { finalAnswer: 'stream', input: 'active-session' },
    events: { async *[Symbol.asyncIterator]() {} }, answerUserInput, stop: vi.fn(async () => {}), waitForExit: async () => true,
    async sendInput({ text, messageId }) {
      return await steer(text, messageId) === 'accepted'
        ? { status: 'accepted', messageId, scope: 'active-session' } : { status: 'inactive', messageId };
    } };
  const handle = activeRuns.register(identity.scopeId, run);
  const message: NormalizedMessage = { messageId: 'om_origin', chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic',
    senderId: 'ou_user', content: 'task', rawContentType: 'text', resources: [], mentions: [], mentionedBot: false, mentionAll: false, createTime: 1 };
  const manager = new UserQuestions({ channel: channel as unknown as LarkChannel, auth: options.auth === false ? undefined : auth,
    activeRuns, pending, catalog, followups: new FollowupRouter(), isTimed: () => options.timed === true,
    blockingTimeoutMs: options.blockingTimeoutMs });
  const mode = options.mode ?? 'async';
  const publish = () => manager.publish({ type: 'user_input', id: 'question-item', mode,
    ...(mode === 'async' ? { threadId: 'codex-thread' } : { sessionId: 'claude-session' }), questions: options.questions ?? [
    { question: '处理范围？', options: [{ label: '全部' }, { label: '仅本次' }] },
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
  return { manager, publish, values, click, channel, activeRuns, pending, catalog, identity, run, steer, handle, answerUserInput };
}

describe('native async question cards', () => {
  it.each(['delivery', 'update'] as const)('responds while %s is pending, then settles the card without duplicate delivery', async stage => {
    const h = await harness(); await h.publish();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (stage === 'delivery') h.steer.mockImplementationOnce(async () => { await gate; return 'accepted'; });
    else {
      const update = h.channel.updateCardById.bind(h.channel);
      vi.spyOn(h.channel, 'updateCardById').mockImplementationOnce(async (...args) => { await gate; return update(...args); });
    }
    const notify = vi.fn();
    vi.useFakeTimers();
    const response = respondToCardAction(() => h.click(h.values()[0]!), notify);
    await vi.advanceTimersByTimeAsync(500);
    expect(await response).toMatchObject({ toast: { type: 'info' } });
    expect(h.steer).toHaveBeenCalledOnce();
    // A different choice must remain locked after the early callback response.
    await h.click(h.values()[1]!);
    expect(h.steer).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(h.channel.rawClient.requests)).toContain('已送入当前任务');
    expect(h.pending.cancel(h.identity.scopeId)).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });
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

describe('blocking and multi-question requests', () => {
  const two: AgentQuestion[] = [
    { question: '处理范围？', header: '范围', options: [{ label: '全部', description: '所有消息' }, { label: '仅本次' }] },
    { question: '要跑哪些检查？', options: [{ label: 'lint' }, { label: 'test' }], multiSelect: true },
  ];
  it('answers a blocking question through the run instead of steering text', async () => {
    const h = await harness({ mode: 'blocking' }); await h.publish();
    await h.click(h.values()[1]!);
    expectOneAnswer(h.answerUserInput, 'question-item', { answers: [['仅本次']] });
    expect(h.steer).not.toHaveBeenCalled();
    expect(JSON.stringify(h.channel.rawClient.requests)).toContain('已送入当前任务');
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('任务在等待你的回答');
  });
  it('falls back to follow-up input when the run no longer waits for the request', async () => {
    const h = await harness({ mode: 'blocking', native: 'inactive' }); await h.publish();
    await h.click(h.values()[0]!);
    expect(h.answerUserInput).toHaveBeenCalledOnce();
    expect(h.steer.mock.calls[0]?.[0]).toContain('全部');
  });
  it('submits several questions as one form with selections, multi-select arrays, and typed answers', async () => {
    const h = await harness({ mode: 'blocking', questions: two }); await h.publish();
    const card = JSON.stringify(h.channel.sent[0]?.content);
    expect(card).toContain('select_static');
    expect(card).toContain('multi_select_static');
    expect(card).toContain('全部：所有消息');
    expect(h.values().map(v => v.choice)).toEqual(['form']);
    const payload = h.values()[0]!;
    await h.click(payload, { form: { q0: '1' } });
    expect(h.answerUserInput).not.toHaveBeenCalled();
    await h.click(payload, { form: { q0: '1', t0: '', q1: ['0', '1'] } });
    expectOneAnswer(h.answerUserInput, 'question-item', { answers: [['仅本次'], ['lint', 'test']] });
  });
  it('prefers typed text over a selection and formats async multi-answers as one input', async () => {
    const h = await harness({ questions: two }); await h.publish();
    await h.click(h.values()[0]!, { form: { q0: '0', t0: '只看新消息', q1: '1' } });
    const prompt = h.steer.mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('只看新消息');
    expect(prompt).toContain('要跑哪些检查？');
    expect(prompt).toContain('test');
  });
  it('treats the asker\'s topic reply as the answer to the only waiting blocking question', async () => {
    const h = await harness({ mode: 'blocking' }); await h.publish();
    const resolveIdentity = async () => h.identity;
    expect(await h.manager.answerWithText({ scope: h.identity.scopeId, senderId: 'ou_other', text: 'x', resolveIdentity })).toBeUndefined();
    const status = await h.manager.answerWithText({ scope: h.identity.scopeId, senderId: 'ou_user', text: '只处理新消息', resolveIdentity });
    expect(status).toContain('已提交：只处理新消息');
    expectOneAnswer(h.answerUserInput, 'question-item', { answers: [['只处理新消息']] });
    expect(await h.manager.answerWithText({ scope: h.identity.scopeId, senderId: 'ou_user', text: 'again', resolveIdentity })).toBeUndefined();
  });
  it.each([['async', undefined], ['blocking', two]] as const)('leaves %s replies as ordinary input', async (mode, questions) => {
    const h = await harness({ mode, ...(questions ? { questions: [...questions] } : {}) }); await h.publish();
    expect(await h.manager.answerWithText({ scope: h.identity.scopeId, senderId: 'ou_user', text: 'x',
      resolveIdentity: async () => h.identity })).toBeUndefined();
    expect(h.answerUserInput).not.toHaveBeenCalled();
  });
  it('declines an unanswered blocking question after the timeout and settles the card', async () => {
    vi.useFakeTimers();
    const h = await harness({ mode: 'blocking', blockingTimeoutMs: 60_000 }); await h.publish();
    await vi.advanceTimersByTimeAsync(60_000);
    expectOneAnswer(h.answerUserInput, 'question-item', { declined: expect.stringContaining('1 分钟内没有回答') });
    expect(JSON.stringify(h.channel.rawClient.requests)).toContain('任务已按默认假设继续');
    await h.click(h.values()[0]!);
    expect(h.answerUserInput).toHaveBeenCalledOnce();
  });
});


function expectOneAnswer(mock: { mock: { calls: unknown[][] } }, ...args: unknown[]): void {
  expect(mock.mock.calls).toHaveLength(1);
  expect(mock.mock.calls[0]).toEqual(args);
}
