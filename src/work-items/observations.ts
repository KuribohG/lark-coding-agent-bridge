import { createHash } from 'node:crypto';
import type { WorkItemConfig } from './config';
import type { WorkItemCore } from './control';
import type { WorkItemEvent } from './events';
import { observationDigest, recordObservation } from './identity';
import { resolved } from './result';
import type { WorkItemTasks } from './tasks';
import type { WorkItem } from './types';

/** Turns collector events into items; a batch and the collector's state commit or roll back together. */
export class WorkItemObservations {
  constructor(private core: WorkItemCore<WorkItemConfig>, private tasks: WorkItemTasks) {}
  record(events: readonly WorkItemEvent[], collector?: { value: unknown }): Promise<WorkItem[]> {
    const { store, control } = this.core;
    const source = this.core.source.acceptsEvents ? this.core.source.id : undefined;
    const valid = events.map(input => {
      const event = structuredClone(input);
      if (!source || !event.key || !event.title || !Number.isFinite(event.time) ||
        (event.revision !== undefined && (!Number.isSafeInteger(event.revision) || event.revision < 1 || !event.eventId)) ||
        (event.operation !== undefined && !['upsert', 'resolve'].includes(event.operation)) ||
        ((event.eventId !== undefined || event.operation !== undefined) && event.revision === undefined)) throw new Error('无效盯盘事项');
      return event;
    });
    return control.serial(async () => {
      if (control.stopped) throw new Error('事项来源已关闭');
      const undo: (() => void)[] = [];
      const committed: (() => void)[] = [];
      const previous = store.data.collector;
      try {
        const items = valid.map(event => this.apply(source!, event, undo, committed));
        if (collector) store.data.collector = collector.value;
        await store.save();
        for (const fn of committed) fn();
        return items.map(job => structuredClone(job));
      } catch (error) {
        for (const fn of undo.reverse()) fn();
        store.data.collector = previous;
        throw error;
      }
    });
  }
  private decide(event: WorkItemEvent) {
    const { assessment } = this.core.source;
    return assessment?.kind === 'rule' ? assessment.evaluate(event) : { state: 'needed' as const, reason: event.reason, priority: event.priority };
  }
  private apply(source: string, event: WorkItemEvent, undo: (() => void)[], committed: (() => void)[]): WorkItem {
    const { store, config, now, delivery } = this.core;
    const id = createHash('sha256').update(JSON.stringify([source, config.ownerKey, config.executorProfile, event.key])).digest('hex');
    const existing = store.data.jobs.find(job => job.id === id);
    if (existing) return this.update(existing, event, undo, committed);
    const digest = observationDigest(event);
    const decision = this.decide(event);
    const job: WorkItem = {
      id, ownerKey: config.ownerKey, profile: config.executorProfile,
      target: { ...config.target },
      sourceRef: { transport: 'event', containerId: '', name: event.title, kind: 'external' },
      messages: [],
      createdAt: event.time, updatedAt: now(), state: decision.state === 'needed' ? 'queued' : 'waiting', automatic: true, alert: true,
      attention: decision, handlingState: 'open', revision: 1,
      external: { source, key: event.key, url: event.url, data: structuredClone(event.data),
        analysisAttempts: 0, maxAttempts: Math.max(1, Math.min(3, event.maxAttempts ?? 3)), evidenceDir: event.evidenceDir },
    };
    delivery.enqueue(job, event);
    recordObservation(job);
    if (event.revision !== undefined) job.observation = { id: event.eventId!, revision: event.revision, time: event.time, digest };
    if (event.operation === 'resolve') {
      job.businessState = 'resolved'; job.state = 'done';
      job.attention = { state: 'quiet', reason: event.reason };
    }
    job.analysisRequested = job.state === 'queued';
    store.data.jobs.push(job);
    undo.push(() => { store.data.jobs.splice(store.data.jobs.indexOf(job), 1); });
    return job;
  }
  private update(job: WorkItem, event: WorkItemEvent, undo: (() => void)[], committed: (() => void)[]): WorkItem {
    // Unrevisioned events are create-only. A collector must opt into ordered updates explicitly.
    if (event.revision === undefined || event.revision < (job.observation?.revision ?? 0)) return job;
    const digest = observationDigest(event);
    if (event.revision === job.observation?.revision) {
      if (job.observation.id !== event.eventId || job.observation.digest !== digest) throw new Error('事项观测版本冲突');
      return job;
    }
    if (job.observation?.id === event.eventId) throw new Error('观测 ID 不可复用于新版本');
    const decision = this.decide(event);
    const before = structuredClone(job);
    undo.push(() => {
      for (const key of Object.keys(job)) delete (job as unknown as Record<string, unknown>)[key];
      Object.assign(job, before);
    });
    if (job.state === 'running') committed.push(() => this.tasks.analyses.get(job.id)?.controller.abort());
    job.sourceRef.name = event.title;
    job.external!.data = structuredClone(event.data); job.external!.url = event.url;
    job.external!.evidenceDir = event.evidenceDir; job.external!.analysisAttempts = 0;
    recordObservation(job);
    job.origin!.url = event.url;
    job.observation = { id: event.eventId!, revision: event.revision, time: event.time, digest };
    job.businessState = event.operation === 'resolve' ? 'resolved' : 'open';
    job.draftStale = Boolean(job.result || job.replyDraft);
    job.analysisRequested = false;
    if (!resolved(job)) {
      job.attention = job.businessState === 'resolved' ? { state: 'quiet', reason: event.reason } : decision;
      if (job.businessState === 'open' && decision.state === 'needed' && !job.analysisPaused && !job.draftEdited) {
        job.state = 'queued'; job.automatic = true; job.analysisRequested = true;
        job.retryAt = undefined; job.error = undefined;
        job.resultDelivery = undefined; job.deliveredAt = undefined;
      } else if (['queued', 'running', 'ready', 'failed'].includes(job.state)) {
        job.state = job.result ? 'done' : 'waiting';
      }
    }
    this.core.delivery.enqueue(job, event);
    this.core.lifecycle.touch(job);
    return job;
  }
}
