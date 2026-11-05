import { join } from 'node:path';
import type { InvestigationDriver } from '../../../work-items/contracts';
import type { WorkItemEvent as InboxTaskEvent } from '../../../work-items/events';
import type { WorkItem as InboxJob } from '../../../work-items/types';
import { writeFileAtomic } from '../../../platform/atomic-write';
import type { GitLabClient } from './client';
import type { GitLabCiConfig } from './config';
import { prepareCi } from './processor';
import type { CiRun } from './service';
import type { RuleAssessmentPolicy } from '../../../work-items/contracts';

export const ciAssessment: RuleAssessmentPolicy = {
  kind: 'rule',
  evaluate(event) {
    const run = event.data as CiRun;
    return { state: run.pipeline.status === 'failed' ? 'needed' : 'quiet', reason: event.reason };
  },
};

export function ciTaskDriver(config: GitLabCiConfig, client?: GitLabClient): InvestigationDriver & { accepts(item: InboxJob): boolean } {
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

export function ciTaskEvent(run: CiRun, config: GitLabCiConfig): InboxTaskEvent {
  if (!/^[a-f0-9]{32}$/.test(run.id)) throw new Error('Invalid CI failure ID');
  let url = '';
  try { const parsed = new URL(run.pipeline.web_url); if (parsed.origin === new URL(config.url).origin && !parsed.username && !parsed.password) url = parsed.href; } catch { /* optional source link */ }
  return { key: run.id, title: `${run.repository.project} · CI #${run.pipeline.id}`,
    reason: `GitLab CI 失败 · ${run.pipeline.ref} · ${run.pipeline.sha.slice(0, 12)}`, url, time: run.createdAt,
    data: run, evidenceDir: join(config.outputDir, run.id), maxAttempts: 3 };
}
