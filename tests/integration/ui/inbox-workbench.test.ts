import { createWorkItemSource } from '../../../src/host/work-item-runtime';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { InboxService } from '../../../src/inbox/service';
import { InboxStore } from '../../../src/inbox/store';
import { normalizeInbox } from '../../../src/inbox/config';
import { executeInboxCommand } from '../../../src/inbox/workbench';
import { guiJobs } from '../../../src/inbox/presentation';
import { startUiServer } from '../../../src/ui/server';
import type { UiServerHandle, UiSupervisor } from '../../../src/ui/types';
import { InboxManager } from '../../../src/monitoring/sources/lark/manager';
import type { InboxLark } from '../../../src/inbox/lark';
import type { InboxIO, InboxJob } from '../../../src/inbox/types';

let server: UiServerHandle | undefined, service: InboxService | undefined;
afterEach(async () => { await server?.close(); await service?.close(); });

it('serves local jobs and persists version-checked reviews through authenticated HTTP without a cloud connector', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'local-inbox-'));
  const store = new InboxStore(join(rootDir, 'state.json'));
  const config = normalizeInbox({ enabled: false, executorProfile: 'codex', ownerOpenId: 'ou_owner' });
  store.data.jobs = [{ id: randomUUID(), profile: 'codex', ownerOpenId: 'ou_owner', source: { chatId: 'oc_source', name: 'Example', type: 'p2p' },
    destination: config.destination, messages: [{ id: 'om_input', chatId: 'oc_source', chatName: 'Example', chatType: 'p2p', senderId: 'ou_other', senderName: 'Colleague', bot: false, time: Date.now(), text: 'Please review', mentions: [] }], state: 'done', handlingState: 'open', automatic: false, alert: false,
    createdAt: Date.now(), updatedAt: Date.now(), revision: 1, replyDraft: 'old', analysis: 'evidence' } satisfies InboxJob];
  await store.save();
  const checkOwner = vi.fn();
  service = new InboxService(store, config, { checkOwner } as unknown as InboxIO);
  await service.start();
  const manager = { workbench: async () => ({ running: false, jobs: guiJobs(service!.list()), config }),
    workbenchCommand: (input: unknown) => executeInboxCommand(service!, {} as InboxLark, input) } as unknown as InboxManager;
  const shutdown = vi.fn();
  const sup = { inbox: manager, list: () => [] } as unknown as UiSupervisor;
  server = await startUiServer({ rootDir, supervisor: sup, version: 'test', requestShutdown: shutdown });
  const url = `http://127.0.0.1:${server.port}`;
  const command = (target: unknown, token = server!.token, action = 'review') => fetch(`${url}/api/inbox/command`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ui-token': token },
    body: JSON.stringify({ id: randomUUID(), action, target: JSON.stringify(target) }),
  });
  const patch = { id: store.data.jobs[0]!.id, revision: 1, replyDraft: 'edited by owner' };
  expect((await command(patch, 'bad')).status).toBe(401);
  expect((await fetch(`${url}/api/inbox/workbench`, { headers: { 'x-ui-token': server.token, origin: 'https://evil.example' } })).status).toBe(403);
  expect((await fetch(`${url}/api/inbox/workbench`, { headers: { 'x-ui-token': server.token } })).status).toBe(200);
  expect((await command(patch)).status).toBe(200);
  const stale = await command({ ...patch, replyDraft: 'stale tab' });
  expect(stale.status).toBe(400); expect(await stale.text()).toContain('已更新');
  expect(store.data.jobs[0]!.replyDraft).toBe('edited by owner');
  expect((await command(patch, server.token, 'send')).status).toBe(400);
  expect(checkOwner).not.toHaveBeenCalled(); // paused: no collection or external calls
  const reloaded = new InboxStore(store.path); await reloaded.load();
  expect(reloaded.data.jobs[0]!.replyDraft).toBe('edited by owner');
  expect((await fetch(`${url}/api/shutdown`, { method: 'POST' })).status).toBe(401);
  expect(shutdown).not.toHaveBeenCalled();
  expect((await fetch(`${url}/api/shutdown`, { method: 'POST', headers: { 'x-ui-token': server.token } })).status).toBe(200);
  await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
});

it('shows and reviews CI source jobs in the same authenticated workbench with chat intake unconfigured', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'local-source-workbench-'));
  const manager = new InboxManager(join(rootDir, 'config.json'), () => undefined, rootDir);
  try {
    const source = await manager.sources.connect(createWorkItemSource({ id: 'gitlab-ci', label: 'GitLab CI', profile: 'codex', enabled: false,
      executor: () => undefined, driver: { accepts: () => true, prepare: vi.fn() } }, join(rootDir, 'config.json')));
    const job = await source.submit({ key: 'pipeline-1', title: 'repo CI #1', reason: 'CI failed', url: 'https://gitlab.test/pipelines/1',
      time: Date.now(), data: {}, initial: { state: 'done', replyDraft: 'CI draft', analysis: 'CI evidence' } });
    server = await startUiServer({ rootDir, supervisor: { inbox: manager, list: () => [] } as unknown as UiSupervisor, version: 'test' });
    const url = `http://127.0.0.1:${server.port}`;
    const headers = { 'content-type': 'application/json', 'x-ui-token': server.token };
    const response = await fetch(`${url}/api/inbox/workbench`, { headers });
    expect(response.status).toBe(200); const view = await response.text();
    expect(view).toContain('gitlab-ci'); expect(view).toContain('CI draft');
    const review = await fetch(`${url}/api/inbox/command`, { method: 'POST', headers,
      body: JSON.stringify({ id: randomUUID(), action: 'review', target: JSON.stringify({ id: job.id, revision: job.revision, handlingState: 'handled' }) }) });
    expect(review.status).toBe(200); expect(manager.sources.list()[0]?.handlingState).toBe('handled');
  } finally { await manager.close(); }
});
