import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { WorkItemStore } from '../../../src/work-items/store';
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

it('imports legacy JSON once, archives it, and round-trips the full durable state', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'work-item-store-'));
  const path = join(folder, 'state.json');
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
  await writeFile(path, JSON.stringify(state));

  const store = new WorkItemStore(path);
  await store.load();
  expect(store.data).toEqual(state);
  expect(store.databasePath).toBe(join(folder, 'state.sqlite'));
  expect((await readdir(folder)).some(name => name.startsWith('state.json.imported-'))).toBe(true);

  store.data.jobs[0]!.replyDraft = 'durable draft';
  store.data.jobs[0]!.updatedAt = 50;
  await store.save();
  const restored = new WorkItemStore(path);
  await restored.load();
  expect(restored.data).toEqual(store.data);
});

it('fails closed on an unknown database state version', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'work-item-store-version-'));
  const path = join(folder, 'state.json');
  const seed = new WorkItemStore(path);
  await seed.load();
  const db = new Database(seed.databasePath);
  try {
    db.prepare("UPDATE metadata SET value = '99' WHERE key = 'state_version'").run();
  } finally {
    db.close();
  }
  await expect(new WorkItemStore(path).load()).rejects.toThrow(
    'unsupported work-item database state version: 99',
  );
});

it('preserves scheduler order independently from job updates', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'work-item-store-order-'));
  const path = join(folder, 'state.json');
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
