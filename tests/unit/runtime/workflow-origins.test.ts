import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowOrigins } from '../../../src/runtime/workflow-origins';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const message = (id: string) => ({ chatId: 'oc_chat', messageId: id, threadId: 'omt_topic', chatType: 'group', senderId: 'ou_user' });

describe('workflow origins', () => {
  it('survives a restart so workflows can be addressed before new messages arrive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-origins-')); dirs.push(dir);
    const path = join(dir, 'state', 'workflow-origins.json');
    const origins = new WorkflowOrigins<ReturnType<typeof message>>(path);
    await origins.load();
    origins.set('scope-a', message('om_1')).set('scope-b', message('om_2')).set('scope-a', message('om_3'));
    await origins.flush();
    const restored = new WorkflowOrigins<ReturnType<typeof message>>(path);
    await restored.load();
    expect([...restored.keys()]).toEqual(['scope-b', 'scope-a']);
    expect(restored.get('scope-a')?.messageId).toBe('om_3');
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1);
  });

  it('keeps the most recent scopes and ignores unreadable files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-origins-')); dirs.push(dir);
    const path = join(dir, 'workflow-origins.json');
    const origins = new WorkflowOrigins<ReturnType<typeof message>>(path);
    for (let i = 0; i < 520; i++) origins.set('scope-' + i, message('om_' + i));
    await origins.flush();
    const restored = new WorkflowOrigins<ReturnType<typeof message>>(path);
    await restored.load();
    expect(restored.size).toBe(512);
    expect(restored.has('scope-7')).toBe(false);
    expect(restored.has('scope-519')).toBe(true);
    await writeFile(path, JSON.stringify({ version: 1, origins: [['kept', message('om_1')], ['dropped', { messageId: 'om_2' }], ['null', null]] }));
    const filtered = new WorkflowOrigins<ReturnType<typeof message>>(path, origin => typeof (origin as { chatId?: unknown }).chatId === 'string');
    await filtered.load();
    expect([...filtered.keys()]).toEqual(['kept']);
    await writeFile(path, '{not json');
    const broken = new WorkflowOrigins<ReturnType<typeof message>>(path);
    await broken.load();
    expect(broken.size).toBe(0);
  }, 30_000);
});
