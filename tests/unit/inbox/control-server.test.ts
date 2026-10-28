import { access, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startInboxControl, type InboxControlHandle, type InboxControlSidecar } from '../../../src/inbox/control-server';
import { inboxWorkbenchUrl, normalizeInbox, validateInbox } from '../../../src/inbox/config';
import { workItemTarget } from '../../../src/inbox/lark-target';
import { HttpError } from '../../../src/ui/http';

const handles: InboxControlHandle[] = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.close();
});

async function setup(command = vi.fn(async (input: unknown) => ({ accepted: input }))) {
  const root = await mkdtemp(join(tmpdir(), 'inbox-control-'));
  const path = join(root, 'inbox-control.json');
  const handle = await startInboxControl(path, { profile: 'codex', ownerOpenId: 'ou_owner' }, command);
  handles.push(handle);
  const sidecar = JSON.parse(await readFile(path, 'utf8')) as InboxControlSidecar;
  return { root, path, handle, sidecar, command };
}

it('writes a private sidecar and authenticates loopback requests', async () => {
  const s = await setup();
  expect(s.sidecar).toMatchObject({
    version: 1,
    url: s.handle.url,
    profile: 'codex',
    ownerOpenId: 'ou_owner',
    pid: process.pid,
  });
  if (process.platform !== 'win32') expect((await stat(s.path)).mode & 0o777).toBe(0o600);

  const denied = await fetch(`${s.sidecar.url}/health`);
  expect(denied.status).toBe(401);

  const health = await fetch(`${s.sidecar.url}/health`, {
    headers: { authorization: `Bearer ${s.sidecar.token}` },
  });
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ ok: true, profile: 'codex', ownerOpenId: 'ou_owner' });
});

it('forwards the workbench command body and returns its result', async () => {
  const s = await setup();
  const command = {
    id: '01234567-0123-4123-8123-123456789abc',
    action: 'claim',
    target: 'item-id',
  };
  const response = await fetch(`${s.sidecar.url}/command`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.sidecar.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, result: { accepted: command } });
  expect(s.command).toHaveBeenCalledWith(command);
});

it('returns command errors without changing the control protocol', async () => {
  const s = await setup(vi.fn(async () => { throw new HttpError(409, '事项已更新'); }));
  const response = await fetch(`${s.sidecar.url}/command`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.sidecar.token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({ error: '事项已更新' });
});

it('removes only its own sidecar on close', async () => {
  const s = await setup();
  await s.handle.close();
  handles.splice(handles.indexOf(s.handle), 1);
  await expect(access(s.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('uses the dedicated workbench URL ahead of legacy GUI and H5 links', () => {
  const config = normalizeInbox({
    enabled: true,
    executorProfile: 'codex',
    recipientKey: 'ou_owner',
    target: workItemTarget({ chatId: 'oc_target', threadId: 'omt_topic', replyTo: 'om_anchor' }),
    workbenchUrl: 'https://jupyter.example/custom/inbox/index.html',
    gui: { publicUrl: 'https://miaoda.example/app', apiKeyFile: '/key' },
    h5: { publicUrl: 'https://h5.example/assistant/', port: 19182 },
  });
  expect(inboxWorkbenchUrl(config)).toBe('https://jupyter.example/custom/inbox/index.html');
  expect(() => validateInbox({ ...config, workbenchUrl: 'http://insecure.example/' })).toThrow('HTTPS');
  expect(() => validateInbox({ ...config, workbenchUrl: 'https://jupyter.example/index.html#job=old' })).toThrow('锚点');
});
