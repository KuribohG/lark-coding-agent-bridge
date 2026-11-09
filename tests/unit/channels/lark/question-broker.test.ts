import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { QuestionBroker, type QuestionEvent } from '../../../../src/channels/lark/question-broker';
import type { SessionCatalogIdentity } from '../../../../src/session/catalog';

const scope = 'oc_chat:omt_topic';
const identity: SessionCatalogIdentity = { scopeId: scope, agentId: 'claude', cwdRealpath: '/repo', policyFingerprint: 'run-fp' };
const message = { chatId: 'oc_chat', chatType: 'group', threadId: 'omt_topic', senderId: 'ou_user', messageId: 'om_1' } as NormalizedMessage;
const event: QuestionEvent = { type: 'user_input', id: 'req-1', mode: 'blocking', sessionId: 'sess-1',
  questions: [{ question: 'Where?', options: [{ label: 'A' }, { label: 'B' }] }] };

function setup() {
  const answerUserInput = vi.fn(async () => 'accepted' as const);
  const handle = { run: { runId: 'run-1', answerUserInput }, interrupted: false };
  const broker = new QuestionBroker({
    presenter: { present: async () => 'om_card', settle: async () => undefined, forget: () => undefined },
    activeRuns: { get: () => handle, generation: () => 0 } as never,
    followups: {} as never,
    pending: {} as never,
    catalog: { activeFor: () => ({ sessionId: 'sess-1' }) } as never,
    isTimed: () => false,
    botOpenId: () => 'ou_bot',
  });
  return { broker, handle, answerUserInput };
}

async function publishAndAnswer(broker: QuestionBroker, answerIdentity: SessionCatalogIdentity) {
  await broker.publish(event, { runId: 'run-1', identity, message, replyTo: 'om_1', mentionUser: false,
    allowQueue: true, isCancelled: () => false });
  const [request] = [...(broker as unknown as { requests: Map<string, { id: string }> }).requests.values()];
  return broker.answer({ requestId: request!.id, ref: 'om_card', scope, chatId: 'oc_chat', operatorId: 'ou_user',
    identity: answerIdentity, answers: [['A']], verify: () => true });
}

describe('QuestionBroker', () => {
  it('delivers a matching answer to the waiting run', async () => {
    const { broker, answerUserInput } = setup();
    const result = await publishAndAnswer(broker, identity);
    expect(result.kind).toBe('settled');
    expect(answerUserInput).toHaveBeenCalledWith('req-1', { answers: [['A']] });
  });

  it('declines a stale blocking request so the waiting run does not hang', async () => {
    const { broker, answerUserInput } = setup();
    const result = await publishAndAnswer(broker, { ...identity, policyFingerprint: 'other-fp' });
    expect(result).toMatchObject({ kind: 'settled', request: { status: expect.stringContaining('任务已按默认假设继续') } });
    expect(answerUserInput).toHaveBeenCalledWith('req-1', { declined: expect.any(String) });
  });

  it('leaves an interrupted run alone when the answer is stale', async () => {
    const { broker, handle, answerUserInput } = setup();
    handle.interrupted = true;
    const result = await publishAndAnswer(broker, { ...identity, policyFingerprint: 'other-fp' });
    expect(result).toMatchObject({ kind: 'settled', request: { status: expect.stringContaining('原任务已停止') } });
    expect(answerUserInput).not.toHaveBeenCalled();
  });

  it('reports the plain stale status when the native decline fails', async () => {
    const { broker, answerUserInput } = setup();
    answerUserInput.mockRejectedValueOnce(new Error('closed'));
    const result = await publishAndAnswer(broker, { ...identity, policyFingerprint: 'other-fp' });
    expect(result).toMatchObject({ kind: 'settled', request: { status: expect.stringContaining('原任务已停止') } });
  });
});
