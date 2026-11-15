import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowHost, type WorkflowFrontend, type WorkflowHostDeps } from '../../../src/runtime/workflow-host';

interface WebMessage { conversationId: string; text: string }

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });

function frontend(): WorkflowFrontend<WebMessage> {
  return {
    accepts: origin => typeof (origin as Partial<WebMessage>).conversationId === 'string',
    reply: vi.fn(async () => {}),
    conversation: message => ({ scope: { source: 'channel', channelId: 'web', actorId: 'local', conversationId: message.conversationId },
      access: { ok: true, reason: 'allowed-user' } }),
    queue: vi.fn(() => true),
    dispatch: vi.fn(async () => {}),
    progress: vi.fn(),
  };
}

describe('WorkflowHost with a channel-defined origin', () => {
  it('restores only the origins its channel still accepts, and stays off without a session catalog', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'workflow-host-')); dirs.push(stateDir);
    await writeFile(join(stateDir, 'workflow-origins.json'), JSON.stringify({ version: 1, origins: [
      ['web:1', { conversationId: 'c1', text: 'go' }], ['lark:1', { chatId: 'oc_chat' }],
    ] }));
    const channel = frontend();
    const host = new WorkflowHost<WebMessage>({ frontend: channel, stateDir } as WorkflowHostDeps<WebMessage>);
    await host.start();
    expect([...host.origins.entries()]).toEqual([['web:1', { conversationId: 'c1', text: 'go' }]]);
    expect(host.current).toBeUndefined();
    expect(host.control()).toBeUndefined();
    expect(host.activity()).toEqual({ scripts: 0, tasks: 0 });
    expect(channel.progress).not.toHaveBeenCalled();
    const closed = host.close();
    await Promise.all([closed.progress, closed.runtime]);
  });
});
