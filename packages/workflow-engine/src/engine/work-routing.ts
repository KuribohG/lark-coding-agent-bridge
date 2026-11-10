import type { WorkflowView } from './types';

type Pools = Pick<WorkflowView, 'consumerPool' | 'consumerPools'>;
type Routing = Pools & Pick<WorkflowView, 'workQueue'>;
type PoolOf<S extends Pools> = NonNullable<S['consumerPool']>;

export function queueName(value: unknown = 'default'): string {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)
    || ['parent', 'constructor', 'prototype'].includes(value)) throw new Error('Invalid work queue name');
  return value;
}

export function consumerPools<S extends Pools>(state: S): Array<PoolOf<S>> {
  return [...(state.consumerPool ? [state.consumerPool] : []), ...(state.consumerPools ?? [])] as Array<PoolOf<S>>;
}

export function memberPool<S extends Pools>(state: S, name?: string): PoolOf<S> | undefined {
  return consumerPools<Pools>(state).find(pool => pool.members.some(member => member.name === name)) as PoolOf<S> | undefined;
}

export function queueNames(state: Routing): string[] {
  return [...new Set(['default', ...Object.keys(state.workQueue?.queues ?? {}),
    ...(state.workQueue?.items ?? []).map(item => item.queue ?? 'default'),
    ...consumerPools<Pools>(state).map(pool => pool.queue ?? 'default')])];
}

/** Closure state of a queue; undefined while the queue does not exist. Queues are created by openQueue (work-queue.ts). */
export function queueControl(state: Routing, name: string): { readonly closedAt?: number; readonly closeKey?: string } | undefined {
  queueName(name);
  const work = state.workQueue;
  if (!work || name === 'default') return work;
  return Object.hasOwn(work.queues ?? {}, name) ? work.queues![name] : undefined;
}
