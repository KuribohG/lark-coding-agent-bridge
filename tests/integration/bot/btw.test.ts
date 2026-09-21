import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BtwManager } from '../../../src/bot/btw';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { commandSessionCatalogIdentity } from '../../../src/bot/session-catalog-identity';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { BtwStore } from '../../../src/session/btw-store';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import type { AgentEvent, AgentRun } from '../../../src/agent/types';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const answer = (value: string): AgentEvent[] => [
  { type: 'system', sessionId: 'side-child', threadId: 'side-child' },
  { type: 'text', delta: 'intermediate' },
  { type: 'final_text', content: value },
  { type: 'done', terminationReason: 'normal', sessionId: 'side-child', threadId: 'side-child' },
];

describe('/btw', () => {
  it.each(['claude', 'codex'] as const)('serializes side Q&A without changing the %s parent', async kind => {
    const h = await harness(kind, [answer('first answer'), answer('second answer')]);
    const first = h.manager.enqueue('first question', h.ctx);
    const second = h.manager.enqueue('follow up', h.next('q2'));
    await Promise.all([first, second]);
    expect(h.agent.runOptions).toHaveLength(2);
    expect(h.agent.runOptions[0]?.forkSession).toBe(true);
    expect(h.agent.runOptions[1]?.prompt).toContain('first question');
    expect(h.agent.runOptions[1]?.prompt).toContain('first answer');
    expect(h.agent.runOptions[1]?.prompt).not.toContain('intermediate');
    for (const opts of h.agent.runOptions) expect(opts[kind === 'claude' ? 'sessionId' : 'threadId']).toBe('parent');
    expect(h.catalog.activeFor(h.ctx.sessionCatalogIdentity!)?.[kind === 'claude' ? 'sessionId' : 'threadId']).toBe('parent');
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({ options: { replyTo: 'q2', replyInThread: true } });
  });

  it('keeps history across a bridge restart and drops it after a parent switch', async () => {
    const h = await harness('claude', [answer('remember me'), answer('next'), answer('new parent answer')]);
    await h.manager.enqueue('original', h.ctx);
    await h.manager.close();
    const store = new BtwStore(h.path);
    await store.load();
    const manager = new BtwManager(store);
    cleanups.push(() => manager.close());
    await manager.enqueue('later', h.next('q2'));
    expect(h.agent.runOptions[1]?.prompt).toContain('remember me');
    h.seed('other-parent');
    await manager.enqueue('new context', h.next('q3'));
    expect(h.agent.runOptions[2]?.sessionId).toBe('other-parent');
    expect(h.agent.runOptions[2]?.prompt).not.toContain('remember me');
  });

  it('does not replay failed answers, and refuses a missing parent or denied user', async () => {
    const h = await harness('claude', [
      [{ type: 'text', delta: 'failed secret' }, { type: 'error', message: 'bad', terminationReason: 'failed' }],
      answer('ok'),
    ]);
    await h.manager.enqueue('failure', h.ctx);
    await h.manager.enqueue('retry', h.next('q2'));
    expect(h.agent.runOptions[1]?.prompt).not.toContain('failed secret');
    const other = h.next('q3');
    other.scope = 'chat:other-topic'; other.msg = { ...other.msg, threadId: 'other-topic' };
    await h.manager.enqueue('missing parent', other);
    const denied = h.next('q4'); denied.msg = { ...denied.msg, senderId: 'outsider' };
    h.ctx.controls.profileConfig.access.allowedChats = [];
    await h.manager.enqueue('denied', denied);
    expect(h.agent.runOptions).toHaveLength(2);
    expect(h.sent).toHaveLength(4);
  });

  it('can run while the main scope is active and never interrupts it', async () => {
    const h = await harness('claude', [answer('side answer')]);
    const main: AgentRun = { runId: 'main', events: (async function* () {})(), stop: vi.fn(async () => {}), waitForExit: async () => true };
    h.ctx.activeRuns.register(h.ctx.scope, main);
    await h.manager.enqueue('while busy', h.ctx);
    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.ctx.activeRuns.get(h.ctx.scope)?.run).toBe(main);
    expect(main.stop).not.toHaveBeenCalled();
  });

  it('cancels side questions waiting for capacity, including queued followups', async () => {
    const h = await harness('claude', [answer('must not run')]);
    const release = h.pool.tryAcquire()!;
    const first = h.manager.enqueue('waiting', h.ctx);
    const second = h.manager.enqueue('queued', h.next('q2'));
    await new Promise(resolve => setTimeout(resolve, 30));
    h.manager.cancel(h.ctx.scope);
    await Promise.all([first, second]);
    release();
    expect(h.agent.runOptions).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it('stops an active side process on disconnect without binding its child session', async () => {
    const h = await harness('claude', []);
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const stop = vi.fn(async () => finish());
    vi.spyOn(h.agent, 'run').mockImplementation(opts => ({
      runId: opts.runId, stop, waitForExit: async () => true,
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'system', sessionId: 'side-child' };
        await gate;
        yield { type: 'done', terminationReason: 'interrupted' };
      })(),
    }));
    const pending = h.manager.enqueue('long side question', h.ctx);
    await vi.waitFor(() => expect(h.ctx.activeRuns.scopes()).toContain(`btw:${h.ctx.scope}`));
    await h.manager.close();
    await pending;
    expect(stop).toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
    expect(h.ctx.sessions.getRaw(h.ctx.scope)?.sessionId).toBe('parent');
    expect(h.ctx.activeRuns.scopes()).toEqual([]);
  });

  it('only registers /btw, preserves multiline questions and clears history on /new', async () => {
    const h = await harness('claude', [answer('remember'), answer('fresh')]);
    expect(await tryHandleCommand({ ...h.ctx, msg: { ...h.ctx.msg, content: '/side hi' } })).toBe(false);
    expect(await tryHandleCommand({ ...h.ctx, msg: { ...h.ctx.msg, content: '/btw line1\nline2' } })).toBe(true);
    expect(h.agent.runOptions[0]?.prompt).toContain('line1');
    const before = h.sent.length;
    await h.manager.enqueue('duplicate', h.ctx);
    expect(h.sent).toHaveLength(before);
    await tryHandleCommand({ ...h.next('new'), msg: { ...h.ctx.msg, content: '/new', messageId: 'new' } });
    h.seed('parent');
    await h.manager.enqueue('fresh question', h.next('q3'));
    expect(h.agent.runOptions[1]?.prompt).not.toContain('remember');
    expect(h.manager.excludes(h.ctx.scope, { messageId: 'q1', senderId: 'user', content: 'old text', createdAt: '', rawContentType: 'text' })).toBe(true);
  });
});

async function harness(kind: 'claude' | 'codex', events: AgentEvent[][]) {
  const tmp = await createTmpProfile('btw-');
  cleanups.push(() => tmp.cleanup());
  const profile = createDefaultProfileConfig({ agentKind: kind,
    ...(kind === 'codex' ? { codex: { binaryPath: 'codex', inheritCodexHome: true } } : {}),
    accounts: { app: { id: 'cli_test', secret: 'test', tenant: 'feishu' } },
    access: { allowedChats: ['chat'], allowedUsers: ['user'] },
  });
  profile.workspaces.default = await realpath(tmp.workspace);
  const controls: Controls = { profile: 'test', profileConfig: profile, cfg: profile,
    configPath: join(tmp.root, 'config.json'), processId: 'test', ownerRefreshState: 'unknown',
    refreshOwner: async () => {}, restart: async () => {}, exit: async () => {},
  };
  const sent: Array<{ content: unknown; options: unknown }> = [];
  const channel = { botIdentity: { openId: 'bot' }, send: async (_chat: string, content: unknown, options: unknown) => {
    sent.push({ content, options }); return { messageId: `reply-${sent.length}` };
  } } as unknown as LarkChannel;
  const agent = new FakeAgentAdapter({ id: kind, events });
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'catalog.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 1);
  const executor = new RunExecutor({ agent, pool, activeRuns });
  const path = join(tmp.profile, 'btw.json');
  const manager = new BtwManager(new BtwStore(path));
  controls.btw = manager;
  const ctx: CommandContext = { channel, scope: 'chat:topic', chatMode: 'topic', agent, sessions,
    sessionCatalog: catalog, workspaces, activeRuns, runExecutor: executor, controls,
    msg: { chatId: 'chat', chatType: 'group', senderId: 'user', threadId: 'topic', messageId: 'q1', content: '', resources: [], mentions: [] } as unknown as NormalizedMessage,
  };
  ctx.sessionCatalogIdentity = await commandSessionCatalogIdentity({ ...ctx, mode: 'topic', access: { ok: true, reason: 'allowed-user' } });
  const seed = (id: string) => {
    const identity = ctx.sessionCatalogIdentity!;
    if (kind === 'claude') { catalog.upsertActive({ ...identity, agentId: 'claude', sessionId: id }); sessions.set(ctx.scope, id, identity.cwdRealpath); }
    else catalog.upsertActive({ ...identity, agentId: 'codex', threadId: id });
  };
  seed('parent');
  cleanups.push(async () => { await manager.close(); await Promise.all([sessions.flush(), catalog.flush(), workspaces.flush()]); });
  return { ctx, agent, sent, manager, path, catalog, pool, seed,
    next: (id: string) => ({ ...ctx, msg: { ...ctx.msg, messageId: id } }),
  };
}
