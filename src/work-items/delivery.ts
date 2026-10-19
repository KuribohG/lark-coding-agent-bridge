import { randomUUID } from 'node:crypto';
import type { WorkItemConfig } from './config';
import type { WorkItemRuntime } from './contracts';
import type { WorkItemStore } from './store';
import type { WorkItem } from './types';
import type { WorkItemEvent } from './events';
import { evidenceSignature as signature } from './identity';
import { handlingState } from './result';

interface DeliveryHost {
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  blocked(): boolean;
  safe(job: WorkItem): boolean;
  accepts(job: WorkItem): boolean;
  error?: string;
}
const resolved = (job: WorkItem) => handlingState(job) !== 'open';

/** Reserve and persist, send outside the transaction, then persist the matching receipt. */
export class WorkItemDelivery {
  constructor(private store: WorkItemStore, private config: WorkItemConfig, private io: WorkItemRuntime,
    private now: () => number, private host: DeliveryHost) {}
  async begin(job: WorkItem, signal: AbortSignal, current: () => boolean): Promise<void> {
    const pending = await this.host.transaction(async () => {
      if (!current()) throw new Error('分析已取消');
      const clean = (s: string) => s.replace(/[\r\n]/g, ' ').replace(/<\/?at\b[^>]*>/gi, '');
      const page = this.config.gui.publicUrl || this.config.h5.publicUrl;
      const link = job.messages.find(m => m.link && /^https:\/\/applink\.(feishu\.cn|larksuite\.com)\//.test(m.link))?.link;
      const delivery = job.startDelivery ??= { id: randomUUID(), attempts: 0, startedAt: this.now(), retryAt: this.now(),
        text: `已开始分析 · ${clean(job.source.name)}\n${clean(job.attention?.reason || '你提交的会话事项')}\n\n我会进行分析，并将结果和回复草稿发在本话题下。${link ? `\n原消息：${link}` : ''}${page ? `\n查看与处理：${page}#job=${job.id}` : ''}` };
      if (delivery.attempts >= 3 || this.now() - delivery.startedAt > 240_000) throw new Error('话题通知未确认，已停止重复创建；请在工作台核对');
      delivery.attempts++; delivery.retryAt = this.now() + 60_000;
      await this.store.save();
      return { job: structuredClone(job), delivery: structuredClone(delivery) };
    });
    signal.throwIfAborted();
    const { delivery } = pending;
    const topic = await this.io.beginAnalysis!(pending.job, delivery.text);
    await this.host.transaction(async () => {
      // Keep a confirmed topic even if the user cancels while the send is in flight.
      job.analysisTopic = topic;
      if (job.startDelivery?.id === delivery.id) job.startDelivery.confirmed = true;
      await this.store.save();
    });
  }
  enqueue(job: WorkItem, event: WorkItemEvent): void {
    if (!event.notice || !this.io.notifyChange) return;
    const notices = job.sourceNotices ??= [];
    // Keep only a small receipt history, never discard an outstanding delivery.
    job.sourceNotices = [...notices.filter(n => !n.sentAt && !n.abandoned),
      ...notices.filter(n => n.sentAt || n.abandoned).slice(-10),
      { id: event.eventId ?? randomUUID(), text: event.notice, startedAt: this.now(), attempts: 0, retryAt: this.now() }];
  }
  async changes(): Promise<void> {
    if (!this.io.notifyChange || this.host.blocked()) return;
    for (const job of [...this.store.data.jobs]) {
      for (const notice of [...(job.sourceNotices ?? [])]) {
        const send = await this.host.transaction(async () => {
          if (this.host.blocked() || resolved(job) || !this.host.accepts(job) || job.notificationSuppressed || notice.sentAt || notice.abandoned) return undefined;
          if (notice.attempts >= 3 || this.now() - notice.startedAt > 240_000) {
            notice.abandoned = true; this.host.error = '来源通知未确认，请在工作台查看'; await this.store.save(); return undefined;
          }
          if (notice.retryAt > this.now()) return undefined;
          notice.attempts++; notice.retryAt = this.now() + 60_000; await this.store.save();
          return { job: structuredClone(job), notice: structuredClone(notice) };
        });
        if (!send) { if (!notice.sentAt && !notice.abandoned) break; continue; }
        let target: WorkItem['destination'];
        try { target = await this.io.notifyChange(send.job, send.notice); }
        catch { this.host.error = '来源通知暂未确认，分析继续运行'; break; }
        await this.host.transaction(async () => {
          // A send may finish after cancellation; retain its confirmed receipt and topic.
          job.analysisTopic = target;
          const receipt = job.sourceNotices?.find(n => n.id === send.notice.id);
          if (receipt) receipt.sentAt = this.now();
          if (this.host.error === '来源通知暂未确认，分析继续运行') this.host.error = undefined;
          await this.store.save();
        });
      }
    }
  }
  async results(): Promise<void> {
    for (const job of [...this.store.data.jobs]) {
      const pending = await this.host.transaction(async () => {
        if (this.host.blocked() || !this.store.data.jobs.includes(job)) return;
        const now = this.now();
        if (!(job.state === 'ready' || (job.state === 'failed' && job.analysisTopic) ||
          (this.io.notifyChange && job.state === 'done' && job.result && !job.deliveredAt && job.analysisTopic))) return;
        if (!this.io.deliver) {
          if (job.state === 'ready') job.state = 'done';
          await this.store.save(); return;
        }
        // Automatic results can only use a confirmed topic.
        if ((!this.io.notifyChange || job.businessState !== 'resolved') && !resolved(job) && this.host.safe(job) &&
          (!job.draftStale || job.error) && (!job.automatic || this.host.accepts(job)) && !job.deliveredAt &&
          (job.analysisTopic || (!this.config.gui.publicUrl && !job.automatic && job.attention?.state === 'needed'))) {
          const delivery = job.resultDelivery ??= { attempts: 0, startedAt: now, retryAt: now };
          delivery.id ??= randomUUID();
          if (delivery.confirmedAt !== undefined) {
            if (job.state === 'ready') job.state = 'done';
            await this.store.save(); return;
          }
          if (delivery.attempts >= 3 || now - delivery.startedAt > 240_000) {
            job.error = '结果投递未确认，请在工作台查看；已停止重复发送';
          } else {
            if (delivery.retryAt > now) return;
            delivery.attempts++; delivery.retryAt = now + 60_000;
            await this.store.save();
            return { input: structuredClone(job), delivery };
          }
        }
        if (job.state === 'ready') job.state = 'done';
        await this.store.save();
      });
      if (!pending || this.host.blocked() || resolved(job) || job.resultDelivery?.id !== pending.delivery.id ||
        job.revision !== pending.input.revision || job.evidenceVersion !== pending.input.evidenceVersion) continue;
      try { await this.io.deliver!(pending.input, 'result'); }
      catch { this.host.error = '结果投递暂未确认，等待重试'; continue; }
      await this.host.transaction(async () => {
        // The receipt belongs to the reserved output, not a newer analysis or edited draft.
        if (job.resultDelivery?.id !== pending.delivery.id) return;
        job.resultDelivery!.confirmedAt = this.now();
        if (job.attempt === pending.input.attempt && job.evidenceVersion === pending.input.evidenceVersion &&
          job.revision === pending.input.revision) {
          job.deliveredAt = this.now();
          if (job.state === 'ready') job.state = 'done';
        }
        await this.store.save();
      });
    }
  }
  async attention(): Promise<void> {
    const pending = await this.host.transaction(async () => {
      if (this.host.blocked() || !this.io.notifyAttention || this.io.beginAnalysis) return;
      const data = this.store.data; const now = this.now();
      const eligible = (j: WorkItem) => !resolved(j) && this.host.accepts(j) && j.attention?.state === 'needed' && !j.notifiedAt && !j.notificationSuppressed;
      let outbox = data.notificationOutbox;
      if (!outbox) {
        const day = new Date(now).toISOString().slice(0, 10);
        const usage = data.notificationUsage ??= {};
        if ((data.lastDigestAt !== undefined && now - data.lastDigestAt < 600_000) || (usage[day] ?? 0) >= 12) return;
        const jobs = data.jobs.filter(eligible).slice(0, 20);
        if (!jobs.length) return;
        outbox = data.notificationOutbox = { id: randomUUID(), jobs: jobs.map(j => ({ id: j.id, signature: signature(j) })), attempts: 0, retryAt: now };
        data.lastDigestAt = now; usage[day] = (usage[day] ?? 0) + 1;
      }
      if (outbox.retryAt > now) return;
      const jobs = outbox.jobs.map(entry => data.jobs.find(j => j.id === entry.id && signature(j) === entry.signature && eligible(j)));
      // An ambiguous send must retain its original identity and content on retry.
      if (jobs.some(j => !j) || outbox.attempts >= 3 || now - (data.lastDigestAt ?? now) > 240_000) {
        if (outbox.attempts) for (const entry of outbox.jobs) { const j = data.jobs.find(j => j.id === entry.id); if (j) j.notificationSuppressed = true; }
        data.notificationOutbox = undefined; await this.store.save(); return;
      }
      outbox.attempts++; outbox.retryAt = now + 60_000; await this.store.save();
      return { outbox, jobs: structuredClone(jobs as WorkItem[]) };
    });
    if (!pending) return;
    try { await this.io.notifyAttention!(pending.jobs, pending.outbox.id); }
    catch { this.host.error = '关注通知暂未确认，等待重试'; return; }
    await this.host.transaction(async () => {
      for (const entry of pending.outbox.jobs) {
        const job = this.store.data.jobs.find(j => j.id === entry.id && signature(j) === entry.signature);
        if (job) job.notifiedAt = this.now();
      }
      if (this.store.data.notificationOutbox === pending.outbox) this.store.data.notificationOutbox = undefined;
      await this.store.save();
    });
  }
}
