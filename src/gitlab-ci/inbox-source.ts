import { join } from 'node:path';
import type { InboxTaskDriver, InboxTaskEvent } from '../inbox/task-source';
import type { InboxJob } from '../inbox/types';
import { replyContent } from '../inbox/reply';
import { writeFileAtomic } from '../platform/atomic-write';
import type { GitLabClient } from './client';
import type { GitLabCiConfig } from './config';
import { prepareCi, readCiResult } from './processor';
import type { CiRun } from './service';
import type { RuleAssessmentPolicy } from '../work-items/contracts';

export const ciAssessment: RuleAssessmentPolicy = {
  kind: 'rule',
  evaluate(event) {
    const run = event.data as CiRun;
    return { state: run.pipeline.status === 'failed' ? 'needed' : 'quiet', reason: event.reason };
  },
};

export function ciTaskDriver(config: GitLabCiConfig, client?: GitLabClient): InboxTaskDriver {
  return {
    accepts(job) {
      const run = job.external?.data as CiRun | undefined;
      return Boolean(run && run.url === config.url && run.executorProfile === config.executorProfile &&
        config.repositories.some(repo => repo.project === run.repository.project && (!repo.refs.length || repo.refs.includes(run.pipeline.ref))));
    },
    prepare(job, signal) {
      if (!client) throw new Error('GitLab CI source is offline');
      return prepareCi(job.external!.data as CiRun, config, client, signal, job.automatic);
    },
    async completed(job, result, settings) {
      const run = job.external!.data as CiRun;
      await writeFileAtomic(join(config.outputDir, run.id, 'result.json'), JSON.stringify({ runId: run.id,
        model: settings.model ?? 'default', completedAt: new Date().toISOString(), ...JSON.parse(result.text) as object,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens }, null, 2));
    },
  };
}

/** Import legacy outcomes without sending again or repeating a completed investigation. */
export async function ciTaskEvent(run: CiRun, config: GitLabCiConfig): Promise<InboxTaskEvent> {
  if (!/^[a-f0-9]{32}$/.test(run.id)) throw new Error('Invalid CI failure ID');
  const initial: InboxTaskEvent['initial'] = {};
  let url = '';
  try { const parsed = new URL(run.pipeline.web_url); if (parsed.origin === new URL(config.url).origin && !parsed.username && !parsed.password) url = parsed.href; } catch { /* optional source link */ }
  if (run.topic) initial.analysisTopic = run.topic;
  if (run.deliveredAt) initial.deliveredAt = run.deliveredAt;
  if (run.topic) initial.startDelivery = { id: run.id, text: `继续分析 · ${run.repository.project} CI #${run.pipeline.id}`, attempts: 0, startedAt: Date.now(), retryAt: 0, confirmed: true };
  if (run.resultPath) {
    try {
      // The canonical private run path is authoritative, never an arbitrary saved path.
      const result = await readCiResult(join(config.outputDir, run.id, 'result.json'), run.id);
      Object.assign(initial, replyContent(result.text), { result: result.text, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        state: run.deliveredAt || !config.notification || (run.deliveryAttempts ?? 0) > 0 ? 'done' : 'ready' });
      if (!run.deliveredAt && (run.deliveryAttempts ?? 0) > 0) initial.error = '旧任务投递未确认，结果已导入工作台，不再自动发送';
    } catch { initial.state = 'failed'; initial.error = '旧分析结果无法读取，请检查证据目录后手动重试'; }
  } else if (['running', 'failed', 'ready', 'done'].includes(run.state) || run.attempts >= 3) {
    initial.state = 'failed'; initial.error = '旧分析未完成或结果缺失，请在工作台手动重试';
  } else if (run.state === 'obsolete') {
    initial.businessState = 'resolved';
    initial.state = 'done'; initial.analysis = '旧盯盘已确认本次失败过期，未重复分析。';
    initial.replyDraft = '此失败已过期。'; initial.missingInfo = '';
  }
  if (initial.state === 'failed' && run.topic) initial.resultDelivery = { attempts: 3, startedAt: Date.now(), retryAt: 0 };
  return { key: run.id, title: `${run.repository.project} · CI #${run.pipeline.id}`,
    reason: `GitLab CI 失败 · ${run.pipeline.ref} · ${run.pipeline.sha.slice(0, 12)}`, url, time: run.createdAt,
    data: run, evidenceDir: join(config.outputDir, run.id), maxAttempts: Math.max(1, 3 - run.attempts), initial };
}
