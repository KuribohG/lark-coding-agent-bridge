import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InboxGui } from '../../../src/inbox/gui';
import { normalizeInbox, type IntakeScope } from '../../../src/inbox/config';
import type { InboxService } from '../../../src/inbox/service';
import type { InboxLark } from '../../../src/inbox/lark';
import type { InboxJob } from '../../../src/inbox/types';
import type { InboxTaskSources } from '../../../src/inbox/task-sources';
import { workItemTarget } from '../../../src/inbox/lark-target';

const workers: InboxGui[] = [];
afterEach(async () => { await Promise.all(workers.splice(0).map(w => w.close())); });
const id = '01234567-0123-4123-8123-0123456789ab';
async function setup(compactSync = false) {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-gui-test-'));
  const key = join(dir, 'key'); await writeFile(key, 'test-key', { mode: 0o600 });
  const config = normalizeInbox({ enabled: true, executorProfile: 'codex', recipientKey: 'ou_owner',
    target: workItemTarget({ chatId: 'oc_result', threadId: 'omt_result', replyTo: 'om_anchor' }),
    gui: { publicUrl: 'https://gui.example', apiKeyFile: key } });
  const service = { config, list: vi.fn((_limit = 100): InboxJob[] => []), get: vi.fn((): InboxJob | undefined => undefined), manual: vi.fn(async () => ({ id: 'job1' })),
    decide: vi.fn(async () => {}), stopAnalysis: vi.fn<InboxService['stopAnalysis']>() };
  const lark = { call: vi.fn(async () => ({ messages: [] })), checkOwner: vi.fn(async () => {}),
    recent: vi.fn(async () => ({ chats: [], next: '' })) };
  let commands: object[] = []; let failReceipt = false;
  const request = vi.fn(async (url: string | URL | Request, _options?: RequestInit) => {
    if (String(url).endsWith('/receipt') && failReceipt) return new Response('', { status: 503 });
    return Response.json(String(url).endsWith('/sync') ? { commands, compactSync } : { ok: true });
  });
  const ledger = join(dir, 'receipts.json');
  const changeMode = vi.fn(async (mode: string) => { config.enabled = mode !== 'off'; config.autoAnalyze = mode === 'auto'; });
  const changeScope = vi.fn(async (scope: IntakeScope) => { service.config.intakeScope = scope; });
  const taskSources = { select: vi.fn(() => undefined), list: vi.fn((_limit = 500): InboxJob[] => []), command: vi.fn(async () => ({ handled: false })) };
  const make = () => { const worker = new InboxGui(service as unknown as InboxService, lark as unknown as InboxLark,
    'cli_test', ledger, request, changeMode, changeScope, taskSources as unknown as InboxTaskSources); workers.push(worker); return worker; };
  const worker = make();
  return { key, ledger, changeMode, changeScope, service, lark, request, worker, make, taskSources,
    commands: (value: object[]) => { commands = value; }, failReceipt: () => { failReceipt = true; } };
}
const command = (action: string, target: string) => ({ id, action, target, expiresAt: Date.now() + 60000 });
const idle = async (request: ReturnType<typeof vi.fn>) => { await vi.waitFor(() => expect(request).toHaveBeenCalled()); await new Promise(r => setTimeout(r, 20)); };

describe('hosted inbox connection', () => {
  it('keeps pending work from every source ahead of history and reports the full owner-scoped total', async () => {
    const s = await setup();
    const job = (id: string): InboxJob => ({ id, ownerKey: 'ou_owner', profile: 'codex', target: s.service.config.target,
      sourceRef: { name: id, containerId: 'oc_source', transport: 'lark', kind: 'direct' }, messages: [], state: 'done', handlingState: 'open',
      attention: { state: 'needed', reason: '需要确认' }, createdAt: 1, updatedAt: 1, automatic: true, alert: false });
    const conversations = Array.from({ length: 634 }, (_, i) => ({ ...job(`chat-${i}`),
      attention: { state: i === 0 ? 'needed' as const : 'quiet' as const, reason: '会话' }, updatedAt: 1000 + i }));
    const tasks = Array.from({ length: 6 }, (_, i) => ({ ...job(`ci-${i}`),
      external: { source: 'gitlab-ci', key: `ci-${i}`, url: 'https://gitlab.test', data: {}, analysisAttempts: 1, maxAttempts: 3 } }));
    s.service.list.mockImplementation((limit = 100) => conversations.slice(0, limit));
    s.taskSources.list.mockReturnValue([...tasks, { ...job('foreign-owner'), ownerKey: 'ou_other' }, { ...job('foreign-profile'), profile: 'claude' }]);
    await s.worker.start(); await idle(s.request);
    const { snapshot } = JSON.parse(String(s.request.mock.calls[0]?.[1]?.body));
    expect(snapshot.jobs).toHaveLength(500);
    expect(snapshot.jobs.map((j: { id: string }) => j.id)).toEqual(expect.arrayContaining(['chat-0', ...tasks.map(j => j.id)]));
    expect(snapshot.jobs.some((j: { id: string }) => j.id.startsWith('foreign-'))).toBe(false);
    expect(snapshot.total).toBe(640);
  });

  it.each([false, true])('syncs a stopped job with its receipt and does not replay cancellation (compact=%s)', async compact => {
    const s = await setup(compact);
    const job = { id: 'job1', ownerKey: 'ou_owner', profile: 'codex', state: 'waiting', revision: 2, analysisStoppedAt: 1000,
      sourceRef: { name: '示例', containerId: 'oc_source', transport: 'lark', kind: 'direct' }, messages: [] } as unknown as InboxJob;
    s.service.stopAnalysis.mockImplementation(async () => { s.service.list.mockReturnValue([job]); return job; });
    s.commands([command('stop', JSON.stringify({ id: job.id, revision: 1 }))]);
    await s.worker.start(); await vi.waitFor(() => expect(s.request.mock.calls.some(c => String(c[0]).endsWith('/receipt'))).toBe(true));
    expect(s.service.stopAnalysis).toHaveBeenCalledWith({ id: job.id, revision: 1 }, 'ou_owner', id);
    const receipt = JSON.parse(String(s.request.mock.calls.find(c => String(c[0]).endsWith('/receipt'))![1]?.body));
    expect(receipt.ok).toBe(true); expect(JSON.parse(receipt.result)).toMatchObject({ state: 'waiting', analysisStoppedAt: 1000 });
    const snapshot = compact ? receipt.snapshot : JSON.parse(String(s.request.mock.calls.at(-2)![1]?.body)).snapshot;
    expect(snapshot.stopControl).toBe(true); expect(snapshot.jobs[0]).toMatchObject({ state: 'waiting', analysisStoppedAt: 1000 });
    await s.worker.close(); const restarted = s.make(); await restarted.start(); await idle(s.request);
    expect(s.service.stopAnalysis).toHaveBeenCalledOnce();
  });
  it('requires a private credential file before any outbound request', async () => {
    const s = await setup(); await chmod(s.key, 0o644);
    await expect(s.worker.start()).rejects.toThrow('仅本人'); expect(s.request).not.toHaveBeenCalled();
  });
  it('links to the result group instead of the original thread for new-topic delivery', async () => {
    const s = await setup(); s.service.config.deliveryMode = 'new_topic';
    await s.worker.start(); await idle(s.request);
    const data = JSON.parse(String(s.request.mock.calls[0]?.[1]?.body));
    expect(data.snapshot.resultUrl).toBe('https://applink.feishu.cn/client/chat/open?openChatId=oc_result');
    expect(s.lark.call).not.toHaveBeenCalled();
  });
  it('authenticates outbound calls and forbids redirects', async () => {
    const s = await setup(); await s.worker.start(); await idle(s.request);
    const [url, options] = s.request.mock.calls[0]!;
    expect(url).toBe('https://gui.example/openapi/inbox/sync');
    expect(options?.redirect).toBe('error'); expect(options?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    await s.worker.close(); const count = s.request.mock.calls.length; await s.worker.tick();
    expect(s.request).toHaveBeenCalledTimes(count);
  });
  it('persists execution before remote acknowledgement and replays the receipt after restart', async () => {
    const s = await setup(); s.commands([command('manual', 'oc_source')]); s.failReceipt();
    await s.worker.start(); await vi.waitFor(() => expect(s.worker.lastError).toContain('503'));
    expect(s.service.manual).toHaveBeenCalledTimes(1); expect(s.service.manual).toHaveBeenCalledWith('oc_source', id);
    expect(JSON.parse(await readFile(s.ledger, 'utf8')).receipts[id].ok).toBe(true);
    await s.worker.close(); const restarted = s.make(); await restarted.start();
    await vi.waitFor(() => expect(restarted.lastError).toContain('503'));
    expect(s.service.manual).toHaveBeenCalledTimes(1);
  });
  it.each([['shell', 'rm anything', 60000], ['manual', 'oc_source', -1000]])('rejects invalid or expired command %s', async (action, target, expiry) => {
    const s = await setup(); s.commands([{ ...command(action, target), expiresAt: Date.now() + expiry }]);
    await s.worker.start(); await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(s.request.mock.calls[1]?.[1]?.body));
    expect(body.ok).toBe(false); expect(s.service.manual).not.toHaveBeenCalled(); expect(s.service.decide).not.toHaveBeenCalled();
  });
  it('switches modes while off, syncs confirmation before acknowledgement, and does not replay a mode change', async () => {
    const s = await setup(); s.service.config.enabled = false; s.commands([command('mode', 'on')]);
    await s.worker.start(); await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(3));
    expect(s.changeMode).toHaveBeenCalledWith('on');
    const synced = JSON.parse(String(s.request.mock.calls[1]?.[1]?.body));
    expect(synced.snapshot).toMatchObject({ enabled: true, autoAnalyze: false, modeControl: true });
    const receipt = JSON.parse(String(s.request.mock.calls[2]?.[1]?.body));
    expect(receipt.ok).toBe(true); expect(JSON.parse(receipt.result).mode).toBe('on');
    await s.worker.tick(); expect(s.changeMode).toHaveBeenCalledTimes(1);
  });
  it.each(['browse', 'manual', 'process'])('blocks %s while off at the command boundary', async action => {
    const s = await setup(); s.service.config.enabled = false; s.commands([command(action, 'oc_source')]);
    await s.worker.start(); await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(s.request.mock.calls[1]?.[1]?.body)).ok).toBe(false);
    expect(s.lark.recent).not.toHaveBeenCalled(); expect(s.service.manual).not.toHaveBeenCalled();
    expect(s.service.decide).not.toHaveBeenCalled();
  });
  it('rejects invalid mode values without writing configuration', async () => {
    const s = await setup(); s.commands([command('mode', 'enable-anything')]);
    await s.worker.start(); await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(2));
    expect(s.changeMode).not.toHaveBeenCalled();
    expect(JSON.parse(String(s.request.mock.calls[1]?.[1]?.body)).ok).toBe(false);
  });
  it('checks user identity before browsing and isolates jobs by owner', async () => {
    const s = await setup(); s.commands([command('browse', JSON.stringify({ type: 'p2p', page: '' }))]);
    s.lark.checkOwner.mockRejectedValueOnce(new Error('wrong owner')); await s.worker.start();
    await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(2)); expect(s.lark.recent).not.toHaveBeenCalled();
    s.service.list.mockReturnValue([{ id: 'foreign', ownerKey: 'ou_other', sourceRef: { name: 'other', containerId: 'oc_other', transport: 'lark', kind: 'direct' },
      messages: [], state: 'waiting' } as unknown as InboxJob]);
    s.service.get.mockReturnValue(s.service.list()[0]);
    s.commands([{ ...command('claim', 'foreign'), id: '11234567-0123-4123-8123-0123456789ab' }]);
    await s.worker.tick(); expect(s.service.decide).not.toHaveBeenCalled();
    expect(JSON.parse(String(s.request.mock.calls.at(-1)?.[1]?.body)).ok).toBe(false);
  });
});

it('acknowledges a persisted scope while off without starting work', async () => {
  const s = await setup(); s.service.config.enabled = false; s.commands([command('scope', 'all')]);
  await s.worker.start(); await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(3));
  expect(s.changeScope).toHaveBeenCalledWith('all');
  const sync = JSON.parse(String(s.request.mock.calls[1]?.[1]?.body));
  expect(sync.snapshot).toMatchObject({ intakeScope: 'all', scopeControl: true, enabled: false });
  expect(s.changeMode).not.toHaveBeenCalled(); expect(s.service.manual).not.toHaveBeenCalled();
  await s.worker.tick(); expect(s.changeScope).toHaveBeenCalledTimes(1);
});
it('rejects unknown intake scopes', async () => {
  const s = await setup(); s.commands([command('scope', 'unknown')]);
  await s.worker.start(); await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(2));
  expect(s.changeScope).not.toHaveBeenCalled();
  expect(JSON.parse(String(s.request.mock.calls[1]?.[1]?.body)).ok).toBe(false);
});

it('connects while off even when Feishu message lookup is unavailable', async () => {
  const s = await setup(); s.service.config.enabled = false;
  s.lark.call.mockRejectedValue(new Error('chat API unavailable'));
  await s.worker.start(); await idle(s.request);
  expect(s.lark.call).not.toHaveBeenCalled();
  const body = JSON.parse(String(s.request.mock.calls[0]?.[1]?.body));
  expect(body.snapshot.enabled).toBe(false);
  expect(body.snapshot.resultUrl).toContain('open_thread_id=omt_result');
});

it('uses compact polls only after negotiation and periodically resends the full snapshot', async () => {
  const s = await setup(true); await s.worker.start(); await idle(s.request);
  expect(JSON.parse(String(s.request.mock.calls[0]![1]?.body)).snapshot).toBeDefined();
  await s.worker.tick(); expect(JSON.parse(String(s.request.mock.calls.at(-1)![1]?.body)).snapshot).toBeUndefined();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16000);
  try { await s.worker.tick(); expect(JSON.parse(String(s.request.mock.calls.at(-1)![1]?.body)).snapshot).toBeDefined(); }
  finally { clock.mockRestore(); }
});
it('saves changed snapshot with the receipt in two requests rather than three', async () => {
  const s = await setup(true); s.service.config.enabled = false; s.commands([command('mode', 'on')]);
  await s.worker.start(); await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(2));
  const [url, options] = s.request.mock.calls[1]!;
  expect(String(url)).toContain('/receipt');
  const body = JSON.parse(String(options?.body));
  expect(body.ok).toBe(true); expect(body.snapshot.enabled).toBe(true);
  await s.worker.tick(); expect(s.changeMode).toHaveBeenCalledTimes(1);
});
