import { expect, it, vi } from 'vitest';
import { InboxService } from '../../../src/inbox/service';
import { InboxStore } from '../../../src/inbox/store';
import { normalizeInbox } from '../../../src/inbox/config';
import { executeInboxCommand } from '../../../src/inbox/workbench';
import type { InboxLark } from '../../../src/inbox/lark';
import type { InboxIO, InboxJob } from '../../../src/inbox/types';
import { workItemTarget } from '../../../src/inbox/lark-target';

const commandId = '01234567-0123-4123-8123-0123456789ab';
function setup() {
  const config = normalizeInbox({ enabled: true, executorProfile: 'codex', recipientKey: 'ou_owner',
    target: workItemTarget({ chatId: 'oc_result', threadId: 'omt_result', replyTo: 'om_result' }) });
  const job: InboxJob = { id: 'target', ownerKey: 'ou_owner', profile: 'codex', target: config.target,
    sourceRef: { transport: 'lark', containerId: 'oc_source', name: '来源会话', kind: 'direct' }, state: 'waiting', createdAt: 1, updatedAt: 1,
    automatic: false, alert: false, attention: { state: 'needed', reason: '需要处理' }, revision: 0,
    messages: [{ id: 'om_source', containerId: 'oc_source', containerName: '来源会话', containerKind: 'direct',
      senderId: 'ou_sender', senderName: '发送者', senderBot: false, time: 1, text: '请确认', mentions: [] }] };
  const store = new InboxStore('unused');
  vi.spyOn(store, 'save').mockResolvedValue();
  store.data.jobs = [...Array.from({ length: 500 }, (_, i) => ({ ...structuredClone(job), id: `quiet-${i}`,
    attention: { state: 'quiet' as const, reason: '无需处理' } })), job];
  const service = new InboxService(store, config, {} as InboxIO);
  const execute = (action: string, target: string) => executeInboxCommand(service, {} as InboxLark,
    { id: commandId, action, target });
  return { service, store, job, execute };
}

it.each(['handled', 'ignored'] as const)('keeps details readable after %s moves the item beyond the first 500', async handlingState => {
  const s = setup();
  s.job.replyDraft = '已有草稿'; s.job.draftStale = true;
  await expect(s.execute('detail', s.job.id)).resolves.toMatchObject({ draftStale: true });
  expect(s.service.list(500).some(j => j.id === s.job.id)).toBe(true);
  await s.execute('review', JSON.stringify({ id: s.job.id, revision: 0, handlingState }));
  expect(s.service.list(500)).toHaveLength(500);
  expect(s.service.list(500).some(j => j.id === s.job.id)).toBe(false);
  await expect(s.execute('detail', s.job.id)).resolves.toMatchObject({ id: s.job.id, handlingState,
    messages: [{ text: '请确认' }], replyDraft: '已有草稿', draftStale: false });
});

it('confirms an unchanged draft and clears its review notice', async () => {
  const s = setup();
  s.job.replyDraft = '已有草稿'; s.job.draftStale = true;
  await expect(s.execute('detail', s.job.id)).resolves.toMatchObject({ draftStale: true });
  await expect(s.execute('review', JSON.stringify({ id: s.job.id, revision: 0, replyDraft: '已有草稿' })))
    .resolves.toMatchObject({ replyDraft: '已有草稿', draftStale: false });
  await expect(s.execute('detail', s.job.id)).resolves.toMatchObject({ replyDraft: '已有草稿', draftStale: false });
  expect(s.job.analysisRequested).toBe(false);
});

it.each(['process', 'claim', 'ignore'])('accepts %s for a retained item outside the list window', async action => {
  const s = setup();
  s.store.data.jobs.reverse();
  s.job.attention = { state: 'quiet', reason: '无需处理' };
  expect(s.service.list(500).some(j => j.id === s.job.id)).toBe(false);
  await expect(s.execute(action, s.job.id)).resolves.toEqual({ id: s.job.id });
  expect(s.job.state).toBe({ process: 'queued', claim: 'claimed', ignore: 'ignored' }[action]);
});

it('rejects absent and foreign records without exposing content or changing state', async () => {
  const s = setup(); s.job.ownerKey = 'ou_other';
  const before = structuredClone(s.job);
  for (const action of ['detail', 'process', 'claim', 'ignore']) {
    await expect(s.execute(action, 'missing')).rejects.toThrow('待办不存在或已归档');
    await expect(s.execute(action, s.job.id)).rejects.toThrow('待办不存在或已归档');
  }
  expect(s.job).toEqual(before); expect(s.store.save).not.toHaveBeenCalled();
});

it('allows retained details while disabled without permitting changes', async () => {
  const s = setup(); s.job.handlingState = 'handled'; s.service.config.enabled = false;
  await expect(s.execute('detail', s.job.id)).resolves.toMatchObject({ id: s.job.id, handlingState: 'handled' });
  await expect(s.execute('process', s.job.id)).rejects.toThrow('助理已关闭');
});

it('returns an isolated record and reflects deletion and ownership changes', () => {
  const s = setup();
  const found = s.service.get(s.job.id)!;
  found.messages[0]!.text = 'changed'; found.attention!.reason = 'changed';
  expect(s.job.messages[0]!.text).toBe('请确认'); expect(s.job.attention!.reason).toBe('需要处理');
  s.job.ownerKey = 'ou_other'; expect(s.service.get(s.job.id)).toBeUndefined();
  s.job.ownerKey = 'ou_owner'; expect(s.service.get(s.job.id)).toBeDefined();
  s.store.data.jobs = s.store.data.jobs.filter(j => j.id !== s.job.id);
  expect(s.service.get(s.job.id)).toBeUndefined();
});
