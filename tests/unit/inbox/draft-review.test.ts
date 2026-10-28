import { expect, it, vi } from 'vitest';
import { normalizeInbox } from '../../../src/inbox/config';
import { guiContent } from '../../../src/inbox/presentation';
import { WorkItemLifecycle } from '../../../src/work-items/lifecycle';
import type { WorkItem } from '../../../src/work-items/types';
import { workItemTarget } from '../../../src/inbox/lark-target';

const config = normalizeInbox({ recipientKey: 'ou_owner', executorProfile: 'codex',
  target: workItemTarget({ chatId: 'oc_target', threadId: 'omt_target', replyTo: 'om_target' }) });
const lifecycle = () => new WorkItemLifecycle(config, () => 1000, vi.fn(), vi.fn());
const result = JSON.stringify({ replyDraft: '原建议', analysis: '已核实的证据', missingInfo: '' });
const job = (patch: Partial<WorkItem> = {}): WorkItem => ({ id: 'item', ownerKey: 'ou_owner', profile: 'codex',
  target: config.target, sourceRef: { transport: 'lark', containerId: 'oc_source', name: '来源会话', kind: 'group' }, messages: [],
  state: 'done', handlingState: 'open', createdAt: 1, updatedAt: 1, automatic: true, alert: false,
  attention: { state: 'needed', reason: '需要处理' }, ...patch });

it.each(['queued', 'ready', 'done', 'failed'] as const)('does not invent a draft warning for new evidence in %s without a draft', state => {
  const item = job({ state, error: state === 'failed' ? '分析调用失败' : undefined });
  const error = item.error;
  const life = lifecycle();
  life.transition(item, { type: 'evidence' });
  expect(item.state).toBe('waiting');
  expect(guiContent(item)).toMatchObject({ draftStale: false, replyDraft: '', error });
  life.assess(item, { attention: { state: 'quiet', reason: '无需动作' }, autoAnalyze: false });
  expect(guiContent(item)).toMatchObject({ draftStale: false, error });
});

it.each([{ result }, { replyDraft: '人工草稿' }])('shows a review notice for an existing draft after new evidence: %j', patch => {
  const item = job(patch);
  lifecycle().transition(item, { type: 'evidence' });
  expect(guiContent(item)).toMatchObject({ draftStale: true, error: undefined });
  expect(item.analysisRequested).toBe(false);
});

it.each(['unchanged', 'resolved', 'quiet', 'handled', 'ignored'] as const)('removes the review notice after %s without deleting the draft', action => {
  const item = job({ result });
  const life = lifecycle();
  life.transition(item, { type: 'evidence' });
  expect(guiContent(item).draftStale).toBe(true);
  if (action === 'handled') life.handle(item);
  else if (action === 'ignored') life.ignore(item);
  else life.assess(item, { attention: { state: 'quiet', reason: '核对完成' }, autoAnalyze: false,
    followUp: action === 'quiet' ? undefined : action });
  expect(guiContent(item)).toMatchObject({ draftStale: false, replyDraft: '原建议', error: undefined });
  if (action === 'resolved') expect(item.draftStale).toBe(true);
});

it.each([
  { result: JSON.stringify({ replyDraft: '', analysis: '仅分析，无需回复', missingInfo: '' }) },
  { result, replyDraft: '' },
  { replyDraft: '  \n' },
])('does not treat analysis or an explicitly empty draft as a draft to review: %j', patch => {
  const item = job(patch);
  lifecycle().transition(item, { type: 'evidence' });
  expect(guiContent(item).draftStale).toBe(false);
});

it('hides review notices on resolved business issues while preserving delivery protection and failure details', () => {
  const item = job({ result, businessState: 'resolved', draftStale: true, error: '结果投递未确认' });
  expect(guiContent(item)).toMatchObject({ draftStale: false, replyDraft: '原建议', error: '结果投递未确认' });
  expect(item.draftStale).toBe(true);
});
