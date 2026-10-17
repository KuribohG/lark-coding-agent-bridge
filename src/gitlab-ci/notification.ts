import { readFile } from 'node:fs/promises';
import { normalizeInbox } from '../inbox/config';
import { InboxLark } from '../inbox/lark';
import type { InboxJob } from '../inbox/types';
import type { GitLabCiConfig } from './config';
import type { CiIO, CiRun } from './service';

export function ciNotification(config: GitLabCiConfig, rootDir?: string): Pick<CiIO, 'announce' | 'deliver'> & { close(): void } {
  if (!config.notification) return { close() {} };
  const settings = normalizeInbox({ ...config.notification, enabled: true, executorProfile: config.executorProfile });
  const lark = new InboxLark({ profile: config.executorProfile, rootDir }, settings);
  const job = (run: CiRun): InboxJob => ({
    id: `gitlab-ci-${run.id}`, ownerOpenId: settings.ownerOpenId, profile: config.executorProfile,
    destination: settings.destination, analysisTopic: run.topic,
    source: { chatId: '', name: `${run.repository.project} · CI #${run.pipeline.id}`, type: 'group' },
    messages: [{ id: `pipeline-${run.pipeline.id}`, chatId: '', chatName: run.repository.project, chatType: 'group',
      senderId: '', senderName: 'GitLab', bot: true, time: run.createdAt, text: run.pipeline.web_url, mentions: [] }],
    state: 'ready', createdAt: run.createdAt, updatedAt: run.updatedAt, automatic: true, alert: true,
    attention: { state: 'needed', reason: 'GitLab CI failed' }, startDelivery: { id: run.id, text: '', attempts: 0, startedAt: run.createdAt, retryAt: 0 },
    // Stable across restarts and delivery retries.
    attempt: 0, error: run.error,
  });
  return {
    close: () => lark.close(),
    announce: async (run, signal) => {
      signal.throwIfAborted();
      return lark.beginAnalysis(job(run), `${run.repository.project} CI #${run.pipeline.id} 失败，已开始分析（${config.model || '默认模型'}）。\n${run.pipeline.web_url}`);
    },
    deliver: async (run, signal) => {
      signal.throwIfAborted();
      const item = job(run);
      if (run.state === 'obsolete') {
        item.replyDraft = '已跳过这次分析：pipeline 状态或失败 job 已改变。';
        item.analysis = '执行前重新查询发现该失败记录已过期；后续的新失败由监控继续跟踪。';
      }
      if (run.resultPath) {
        const result = JSON.parse(await readFile(run.resultPath, 'utf8')) as { replyDraft: string; analysis: string; missingInfo: string };
        Object.assign(item, result);
      }
      await lark.deliver(item, 'result');
    },
  };
}
