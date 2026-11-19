import type { WorkflowView } from './types';

type Routing = Pick<WorkflowView, 'workQueue' | 'swarms'>;

/** What a member may be named. */
export const MEMBER_NAME = /^[A-Za-z0-9_.-]{1,40}$/;

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

/**
 * Whether the member can still take work from the queue: it consumes that queue in a swarm of the current run that is
 * running, it has not stopped, and it can be woken again (the swarm's lead always, another member while it has
 * wake-ups left).
 */
export function consumes(state: Pick<WorkflowView, 'swarms' | 'script'>, name: string, queue: string): boolean {
  for (const swarm of state.swarms ?? []) {
    const member = swarm.members.find(item => item.name === name);
    if (member) return swarm.status === 'running' && swarm.runId === state.script?.runId && !swarm.finish && !member.stopped && member.queue === queue
      && (swarm.lead === name || member.turns < swarm.maxTurns);
  }
  return false;
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
