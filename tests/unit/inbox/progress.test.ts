import { expect, it, vi } from 'vitest';
import { startInboxProgress } from '../../../src/inbox/progress';
import { InboxLark } from '../../../src/inbox/lark';
import { normalizeInbox } from '../../../src/inbox/config';
import type { InboxJob } from '../../../src/inbox/types';

const destination = { chatId: 'oc_target', threadId: 'omt_menu', replyTo: 'om_menu' };
const topic = { chatId: 'oc_target', threadId: 'omt_item', replyTo: 'om_root' };
const job: InboxJob = { id: 'item', ownerOpenId: 'ou_owner', profile: 'codex', destination, analysisTopic: topic,
  source: { chatId: 'oc_source', name: '项目群', type: 'group' }, messages: [], state: 'running', attempt: 1,
  automatic: true, alert: false, createdAt: 1, updatedAt: 1 };

function setup() {
  const exec = vi.fn(async (args: string[]) => {
    const id = args[args.indexOf('--message-ids') + 1];
    return { code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ ok: true, data:
      args.includes('+messages-reply') ? { message_id: 'om_progress' } : { messages: [{ message_id: id,
        chat_id: 'oc_target', thread_id: 'omt_item', create_time: '1000000', content: '', sender: { sender_type: 'app' } }] } }) };
  });
  const lark = new InboxLark({ profile: 'codex' }, normalizeInbox({ enabled: true, ownerOpenId: 'ou_owner', destination }), exec);
  const events: { event_type: string; content: string }[] = [];
  const client = { create: vi.fn(async () => ({ cot_id: 'cot_test', message_id: 'om_cot' })),
    update: vi.fn(async (_ref: unknown, updates: readonly { event_type: string; content: string }[]) => { events.push(...updates); }),
    complete: vi.fn(async () => {}) };
  return { exec, lark, events, client };
}

it('anchors progress inside the item topic, displaying public progress and tools separately from the final draft', async () => {
  const s = setup();
  const progress = await startInboxProgress(job, s.lark, s.client, 'detailed', new AbortController().signal);
  expect(progress).toBeDefined();
  progress!.event({ type: 'thinking', delta: 'private reasoning' });
  progress!.event({ type: 'thinking', delta: 'more private reasoning' });
  progress!.event({ type: 'text', delta: '正在核对源码和日志。' });
  progress!.event({ type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: 'src/main.ts', secret: 'private args' } });
  progress!.event({ type: 'tool_result', id: 'tool', output: 'private output', isError: false });
  progress!.event({ type: 'retry', attempt: 1, maxAttempts: 3, delayMs: 30_000 });
  progress!.event({ type: 'final_text', content: '{"replyDraft":"private draft"}' });
  progress!.event({ type: 'done', terminationReason: 'normal' });
  expect(s.client.complete).not.toHaveBeenCalled();
  await progress!.finish(true);
  expect(s.client.create).toHaveBeenCalledWith('oc_target', 'om_progress');
  const sends = s.exec.mock.calls.map(c => c[0]).filter(a => a.includes('+messages-reply'));
  expect(sends).toHaveLength(1);
  expect(sends[0]).toEqual(expect.arrayContaining(['--as', 'bot', '--message-id', 'om_root', '--reply-in-thread']));
  expect(sends[0]).not.toContain('oc_source');
  const output = JSON.stringify(s.events);
  expect(output).toContain('正在核对源码和日志'); expect(output).toContain('src/main.ts'); expect(output).toContain('自动重试');
  expect(output).not.toContain('private'); expect(output).not.toContain('REASONING');
  expect(s.events.filter(e => JSON.parse(e.content).delta === '正在分析和核对信息。')).toHaveLength(1);
  expect(s.client.complete).toHaveBeenCalledWith(expect.anything(), 'done');
});

it.each(['off', 'missing-topic', 'cancelled', 'wrong-chat', 'wrong-anchor'] as const)('does not create progress in an unverified target (%s)', async kind => {
  const s = setup(); const controller = new AbortController(); const input = structuredClone(job);
  if (kind === 'missing-topic') input.analysisTopic = undefined;
  if (kind === 'cancelled') controller.abort();
  if (kind === 'wrong-chat') input.analysisTopic!.chatId = 'oc_source';
  if (kind === 'wrong-anchor') s.exec.mockResolvedValue({ code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ ok: true, data: { messages: [] } }) });
  expect(await startInboxProgress(input, s.lark, s.client, kind === 'off' ? 'off' : 'brief', controller.signal)).toBeUndefined();
  expect(s.client.create).not.toHaveBeenCalled();
});

it('finishes cancellation once and drops late progress', async () => {
  const s = setup(); const controller = new AbortController();
  const progress = (await startInboxProgress(job, s.lark, s.client, 'brief', controller.signal))!;
  controller.abort(); progress.event({ type: 'text', delta: 'late content' });
  await progress.finish(false); await progress.finish(false);
  expect(s.client.complete).toHaveBeenCalledTimes(1);
  expect(s.client.complete).toHaveBeenCalledWith(expect.anything(), 'error');
  expect(JSON.stringify(s.events)).toContain('分析已取消'); expect(JSON.stringify(s.events)).not.toContain('late content');
});

it.each(['create', 'update', 'complete'] as const)('contains progress API failure at %s', async stage => {
  const s = setup(); s.client[stage].mockRejectedValueOnce(Error('API unavailable'));
  const progress = await startInboxProgress(job, s.lark, s.client, 'brief', new AbortController().signal);
  if (stage === 'create') expect(progress).toBeUndefined();
  else { expect(progress).toBeDefined(); await expect(progress!.finish(true)).resolves.toBeUndefined(); }
  expect(s.client.create).toHaveBeenCalledTimes(1);
});
