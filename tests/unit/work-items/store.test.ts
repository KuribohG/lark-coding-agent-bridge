import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { readCollectorState, WorkItemStore } from '../../../src/work-items/store';
import { collectorStates } from '../../../src/work-items/registry';
import type { WorkItem, WorkItemState } from '../../../src/work-items/types';

const job: WorkItem = {
  id: 'job-1',
  ownerKey: 'owner',
  profile: 'codex',
  sourceRef: { transport: 'lark', containerId: 'chat', name: 'chat', kind: 'group' },
  target: { transport: 'lark', containerId: 'result', threadId: 'topic', replyTo: 'anchor' },
  messages: [],
  state: 'queued',
  automatic: true,
  alert: true,
  createdAt: 1,
  updatedAt: 2,
  revision: 1,
  handlingState: 'open',
};

it('round-trips the full durable state', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'work-item-store-'));
  const path = join(folder, 'state.sqlite');
  const state: WorkItemState = {
    version: 2,
    ownerKey: 'owner',
    cursors: { group: 10 },
    seen: { message: 20 },
    jobs: [job],
    autoUsage: { '2026-10-28': 2 },
    triageUsage: { '2026-10-28': 3 },
    notificationUsage: { '2026-10-28': 4 },
    lastDigestAt: 30,
    notificationOutbox: {
      id: 'digest',
      jobs: [{ id: job.id, signature: 'sig' }],
      attempts: 1,
      retryAt: 40,
    },
  };

  const store = new WorkItemStore(path);
  await store.load();
  store.data = structuredClone(state);
  await store.save();
  const loaded = new WorkItemStore(path);
  await loaded.load();
  expect(loaded.data).toEqual(state);

  loaded.data.jobs[0]!.replyDraft = 'durable draft';
  loaded.data.jobs[0]!.updatedAt = 50;
  await loaded.save();
  const restored = new WorkItemStore(path);
  await restored.load();
  expect(restored.data).toEqual(loaded.data);
});

it('fails closed on an unknown database state version', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'work-item-store-version-'));
  const path = join(folder, 'state.sqlite');
  const seed = new WorkItemStore(path);
  await seed.load();
  const db = new Database(path);
  try {
    db.prepare("UPDATE metadata SET value = '99' WHERE key = 'state_version'").run();
  } finally {
    db.close();
  }
  await expect(new WorkItemStore(path).load()).rejects.toThrow(
    'unsupported work-item database state version: 99',
  );
});

it('fails closed on an unknown database schema version', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'work-item-store-schema-'));
  const path = join(folder, 'state.sqlite');
  const seed = new WorkItemStore(path);
  await seed.load();
  const db = new Database(path);
  try {
    db.prepare("UPDATE metadata SET value = '1' WHERE key = 'schema_version'").run();
  } finally {
    db.close();
  }
  await expect(new WorkItemStore(path).load()).rejects.toThrow(
    'unsupported work-item database schema version: 1',
  );
});

it('preserves scheduler order independently from job updates', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'work-item-store-order-'));
  const path = join(folder, 'state.sqlite');
  const store = new WorkItemStore(path);
  await store.load();
  store.data.jobs = [
    { ...job, id: 'second', updatedAt: 3 },
    { ...job, id: 'first', updatedAt: 2 },
  ];
  await store.save();
  store.data.jobs.reverse();
  await store.save();

  const restored = new WorkItemStore(path);
  await restored.load();
  expect(restored.data.jobs.map(item => item.id)).toEqual(['first', 'second']);
});

it('persists collector state and reads it back without a lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'work-item-collector-'));
  const path = join(root, 'inbox', 'sources', 'gitlab-ci', 'scope-a', 'state.sqlite');
  const store = new WorkItemStore(path); await store.load();
  expect(readCollectorState(path)).toBeUndefined();
  store.data.collector = { version: 1, repositories: { a: { since: 1, cursor: 2 } } }; await store.save();
  const reloaded = new WorkItemStore(path); await reloaded.load();
  expect(reloaded.data.collector).toEqual(store.data.collector);
  expect(await collectorStates(join(root, 'config.json'), 'gitlab-ci')).toEqual([{ partition: 'scope-a', state: store.data.collector }]);
  expect(await collectorStates(join(root, 'config.json'), 'storage-monitor')).toEqual([]);
  expect(readCollectorState(join(root, 'missing.sqlite'))).toBeUndefined();
  store.data.collector = undefined; await store.save();
  expect(readCollectorState(path)).toBeUndefined();
});
