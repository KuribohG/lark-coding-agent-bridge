import type { WorkConsumerPool, WorkflowState } from './types';

export function queueName(value: unknown = 'default'): string {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)
    || ['parent', 'constructor', 'prototype'].includes(value)) throw new Error('Invalid work queue name');
  return value;
}

export function consumerPools(state: WorkflowState): WorkConsumerPool[] {
  return [...(state.consumerPool ? [state.consumerPool] : []), ...(state.consumerPools ?? [])];
}

export function memberPool(state: WorkflowState, name?: string): WorkConsumerPool | undefined {
  return consumerPools(state).find(pool => pool.members.some(member => member.name === name));
}

export function queueNames(state: WorkflowState): string[] {
  return [...new Set(['default', ...Object.keys(state.workQueue?.queues ?? {}),
    ...(state.workQueue?.items ?? []).map(item => item.queue ?? 'default'),
    ...consumerPools(state).map(pool => pool.queue ?? 'default')])];
}

export function queueControl(state: WorkflowState, name: string, create = false): { closedAt?: number; closeKey?: string } | undefined {
  queueName(name);
  if (create) state.workQueue ??= { items: [], claims: [], operations: [] };
  const work = state.workQueue;
  if (!work || name === 'default') return work;
  if (!Object.hasOwn(work.queues ?? {}, name) && create) {
    if (queueNames(state).length >= 16) throw new Error('Work queue limit reached');
    (work.queues ??= {})[name] = {};
  }
  return Object.hasOwn(work.queues ?? {}, name) ? work.queues![name] : undefined;
}
