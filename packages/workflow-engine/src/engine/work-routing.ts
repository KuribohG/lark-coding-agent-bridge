import type { WorkflowView } from './types';

type Routing = Pick<WorkflowView, 'workQueue' | 'swarms'>;

export function queueName(value: unknown = 'default'): string {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)
    || ['parent', 'constructor', 'prototype'].includes(value)) throw new Error('Invalid work queue name');
  return value;
}

/** The queue a swarm member consumes; such a member claims from that queue only. */
export function memberQueue(state: Pick<WorkflowView, 'swarms'>, name?: string): string | undefined {
  for (const swarm of state.swarms ?? []) {
    const member = swarm.members.find(item => item.name === name);
    if (member) return member.queue;
  }
  return undefined;
}

export function queueNames(state: Routing): string[] {
  return [...new Set(['default', ...Object.keys(state.workQueue?.queues ?? {}),
    ...(state.workQueue?.items ?? []).map(item => item.queue ?? 'default'),
    ...(state.swarms ?? []).flatMap(swarm => swarm.members.flatMap(member => member.queue ? [member.queue] : []))])];
}

/** Closure state of a queue; undefined while the queue does not exist. Queues are created by openQueue (work-queue.ts). */
export function queueControl(state: Routing, name: string): { readonly closedAt?: number; readonly closeKey?: string } | undefined {
  queueName(name);
  const work = state.workQueue;
  if (!work || name === 'default') return work;
  return Object.hasOwn(work.queues ?? {}, name) ? work.queues![name] : undefined;
}
