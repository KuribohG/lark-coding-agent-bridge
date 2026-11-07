import { mkdir, realpath } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConversationRuntime,
  type ConversationRuntime,
  type ConversationRuntimeOptions,
} from '../../../src/runtime/conversation';
import type { RunOutputPlugin } from '../../../src/runtime/run-output';
import type { AgentEvent } from '../../../src/agent/types';
import type { RunProfileConfig } from '../../../src/config/profile-schema';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile } from '../../helpers/tmp-profile';
import { FixedExecutionController } from '../../helpers/fixed-execution';

// A host embedding conversations never initializes the Lark SDK.
vi.mock('@larksuite/channel', () => { throw new Error('Host conversations imported the Lark SDK'); });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function config(workspace: string): RunProfileConfig {
  return {
    agentKind: 'claude', preferences: { maxConcurrentRuns: 1 },
    workspaces: { default: workspace }, permissions: { defaultAccess: 'read-only', maxAccess: 'workspace' },
    access: { allowedUsers: [], allowedChats: [], admins: [], requireMentionInGroup: false },
    attachments: { maxCount: 0, maxBytes: 0, maxFileBytes: 0, imageMaxBytes: 0, cacheTtlMs: 0, cacheMaxBytes: 0 },
  };
}
const alice = { actorId: 'host', conversationId: 'alice' };
const bob = { actorId: 'host', conversationId: 'bob' };
const answered = (sessionId: string): AgentEvent[] => [
  { type: 'system', sessionId }, { type: 'final_text', content: 'ok' }, { type: 'done', terminationReason: 'normal' },
];
const drain: RunOutputPlugin = { id: 'drain', async render(context) { for await (const _event of context.events) { /* consume */ } } };

async function harness(extra: Partial<ConversationRuntimeOptions> = {}, events: AgentEvent[][] = []) {
  const tmp = await createTmpProfile('bridge-conversation-host-'); cleanups.push(tmp.cleanup);
  const agent = new FakeAgentAdapter({ id: 'claude', events });
  const base = config(tmp.workspace);
  const options: ConversationRuntimeOptions = { execution: new FixedExecutionController(agent, base), config: base,
    namespace: 'assistant', channelId: 'dashboard', stateDir: tmp.profile, authorize: async () => true, ...extra };
  const runtime = await createConversationRuntime(options); cleanups.push(() => runtime.close());
  return { tmp, agent, runtime, base };
}
async function run(runtime: ConversationRuntime, who = alice) {
  const result = await runtime.start({ ...who, prompt: 'hello' }, drain);
  if (!result.ok) throw new Error(result.rejectReason.code);
  await result.done; await result.execution.result;
}

describe('host-owned conversations', () => {
  it('resolves run settings for each conversation', async () => {
    const tmp = await createTmpProfile('bridge-conversation-settings-'); cleanups.push(tmp.cleanup);
    const first = join(tmp.root, 'first'), second = join(tmp.root, 'second');
    await Promise.all([mkdir(first), mkdir(second)]);
    const configForAgent = vi.fn((kind: RunProfileConfig['agentKind'], who: { conversationId: string }): RunProfileConfig =>
      ({ ...config(who.conversationId === 'alice' ? first : second), agentKind: kind }));
    const h = await harness({ configForAgent });
    await run(h.runtime, alice);
    await run(h.runtime, bob);
    expect(configForAgent).toHaveBeenCalledWith('claude', alice);
    expect(h.agent.runOptions.map(options => options.cwd)).toEqual([await realpath(first), await realpath(second)]);
  });

  it('selects a validated working directory per conversation and returns to the default', async () => {
    const h = await harness();
    const selected = join(h.tmp.root, 'worktree');
    await mkdir(selected);
    expect(await h.runtime.setWorkingDirectory(alice, selected)).toBe(await realpath(selected));
    expect(await h.runtime.workingDirectory(alice)).toBe(await realpath(selected));
    await run(h.runtime, alice);
    await run(h.runtime, bob);
    await expect(h.runtime.setWorkingDirectory(alice, parse(h.tmp.root).root)).rejects.toThrow();
    expect(await h.runtime.setWorkingDirectory(alice, undefined)).toBeUndefined();
    await run(h.runtime, alice);
    const workspace = await realpath(h.tmp.workspace);
    expect(h.agent.runOptions.map(options => options.cwd)).toEqual([await realpath(selected), workspace, workspace]);
  });

  it('lists native sessions of the same engine, directory and policy, and resumes only a listed one', async () => {
    const claude = vi.fn(async () => [{ sessionId: 'earlier', mtime: 1, preview: 'earlier work', lineCount: 3 }]);
    const h = await harness({ history: { claude } }, [answered('first'), answered('earlier')]);
    await run(h.runtime, alice);
    const listed = await h.runtime.nativeSessions(alice);
    expect(listed).toMatchObject({ agentKind: 'claude', cwd: await realpath(h.tmp.workspace), current: 'first' });
    expect(listed.candidates.map(item => [item.id, item.current])).toEqual([['first', true], ['earlier', false]]);
    expect(claude).toHaveBeenCalledWith(await realpath(h.tmp.workspace), 10, undefined);
    expect((await h.runtime.nativeSessions(bob)).current).toBeUndefined();
    expect(await h.runtime.resume(alice, 'never-listed')).toBe(false);
    expect(await h.runtime.resume(alice, 'earlier')).toBe(true);
    await run(h.runtime, alice);
    expect(h.agent.runOptions[1]?.sessionId).toBe('earlier');
  });

  it('asks blocking questions only when the host opts in, and answers nothing without that run', async () => {
    const h = await harness({ userQuestions: true }, [answered('first')]);
    await run(h.runtime, alice);
    expect(h.agent.runOptions[0]?.userQuestions).toBe(true);
    expect(await h.runtime.answerQuestion(alice, 'ended-run', 'question', { answers: [['yes']] })).toBe('inactive');
    const plain = await harness({}, [answered('second')]);
    await run(plain.runtime, alice);
    expect(plain.agent.runOptions[0]?.userQuestions).toBeUndefined();
  });
});
