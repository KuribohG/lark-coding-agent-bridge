import { normalizeInbox } from '../inbox/config';
import { EventSource } from '../work-items/event-source';
import { createInvestigator } from '../work-items/investigation';
import type { WorkItemDeliveryPort } from '../work-items/delivery-port';
import type { WorkItemSourceOptions } from '../work-items/registry';
import type { MonitorSourceOptions } from '../monitoring/host';

/** Assemble generic work-item execution around an injected delivery port. */
export function createWorkItemSource(
  options: MonitorSourceOptions & { delivery?: WorkItemDeliveryPort },
): WorkItemSourceOptions {
  if ((!options.source && !options.driver.accepts) || (options.source && options.assessment)) {
    throw new Error('Invalid source adapter');
  }
  const delivery = options.delivery;
  const config = normalizeInbox({
    ...(delivery ? { destination: delivery.destination } : {}),
    executorProfile: options.profile,
    ownerOpenId: delivery?.ownerKey ?? `local:${options.profile}`,
    enabled: options.enabled,
    watchPrivate: false,
    watchMentions: false,
  });
  return {
    id: options.id,
    label: options.label,
    config,
    status: options.status,
    source: options.source ?? new EventSource(options.id, options.driver.accepts!, options.assessment),
    runtime: {
      dailyAnalysisLimit: options.dailyAnalysisLimit,
      resumeInterrupted: options.resumeInterrupted,
      canInvestigate: () => {
        const executor = options.executor();
        return executor?.available === true && !executor.signal?.aborted;
      },
      checkAccess: async () => {},
      cancel: () => delivery?.close?.(),
      ...(delivery?.deliver ? { deliver: delivery.deliver.bind(delivery) } : {}),
      ...(delivery?.beginAnalysis ? { beginAnalysis: delivery.beginAnalysis.bind(delivery) } : {}),
      ...(delivery?.notifyChange ? { notifyChange: delivery.notifyChange.bind(delivery) } : {}),
      ...(delivery?.notifyAttention
        ? { notifyAttention: delivery.notifyAttention.bind(delivery) }
        : {}),
      investigate: async (job, signal) => {
        const executor = options.executor();
        if (!executor?.available) throw new Error('执行器暂不可用');
        signal = executor.signal ? AbortSignal.any([signal, executor.signal]) : signal;
        signal.throwIfAborted();
        const settings = await executor.settings(options.model, options.reasoningEffort);
        let progress: Awaited<ReturnType<NonNullable<WorkItemDeliveryPort['progress']>>>;
        let success = false;
        try {
          const result = await createInvestigator(options.driver, async (prepared) => {
            if (delivery?.progress) {
              try {
                progress = await delivery.progress(job, signal);
              } catch (error) {
                if (!options.sourceNotifications) throw error;
              }
            }
            return executor.execute({
              runId: `inbox-${job.id}-${job.attempt}`,
              cwd: prepared.cwd,
              prompt: prepared.prompt,
              ...settings,
              deadlineAt: Date.now() + 30 * 60_000,
            }, signal, (event) => progress?.event(event));
          }, settings)(job, signal);
          signal.throwIfAborted();
          success = true;
          return result;
        } finally {
          await progress?.finish(success);
        }
      },
    },
  };
}
