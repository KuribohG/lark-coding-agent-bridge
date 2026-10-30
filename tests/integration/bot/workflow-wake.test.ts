import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgentBatch } from '../../../src/channels/lark/channel';
import { presentRunOutput } from '../../../src/runtime/run-output';
import { createLarkRunOutput } from '../../../src/channels/lark/run-output';
import { fetchTopicContext } from '../../../src/bot/quote';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { ActiveRuns } from '../../../src/runtime/active-runs';
import { ProcessPool } from '../../../src/runtime/process-pool';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { resolveRunFlowContext } from '../../../src/runtime/run-flow';
import { capabilityForProfile } from '../../../src/agent/backends';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile } from '../../helpers/tmp-profile';

vi.mock('../../../src/runtime/model-settings', () => ({ resolveRunModelSettings: vi.fn(async () => ({})) }));
vi.mock('../../../src/bot/quote', () => ({ fetchQuotedContext: vi.fn(), fetchTopicContext: vi.fn(), LARK_CONTEXT_MAX_CHARS: 10000 }));
vi.mock('../../../src/channels/lark/run-output', () => ({ createLarkRunOutput: vi.fn(() => ({ id: 'test', render: async () => {} })) }));
vi.mock('../../../src/runtime/run-output', () => ({ presentRunOutput: vi.fn(async (execution, _output, options) => {
  for await (const event of execution.subscribe()) options.recordSession(event);
  await execution.result;
}) }));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.clearAllMocks(); });

describe('workflow main-session wake', () => {
  it.each([false, true])('resumes the root with only real follow-ups changing IM history (follow-up=%s)', async realFollowup => {
    const tmp = await createTmpProfile('workflow-wake-');
    const profile = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex' }, accounts: { app: { id: 'test', secret: 'test', tenant: 'feishu' } } });
    profile.workspaces.default = tmp.workspace;
    const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
    const catalog = new SessionCatalog(join(tmp.profile, 'catalog.json'));
    const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
    const scopeId = 'chat:topic';
    const scope = { source: 'im' as const, chatId: 'chat', threadId: 'topic', actorId: 'user' };
    const context = await resolveRunFlowContext({ scopeId, scope, prompt: '', attachments: [], access: { ok: true, reason: 'allowed-user' },
      capability: capabilityForProfile(profile), profileConfig: profile, sessions, sessionCatalog: catalog, workspaces, now: Date.now() });
    if (!context.ok) throw new Error('fixture context rejected');
    const identity = { scopeId, agentId: 'codex' as const, cwdRealpath: context.workspace.cwdRealpath, policyFingerprint: context.policy.policyFingerprint };
    catalog.upsertActive({ ...identity, threadId: 'root-thread' });
    catalog.markCompleted({ ...identity, topicContextThrough: 100, topicContextSeenMessageIds: ['om_old_input'], sourceMessageId: 'om_old_input' });
    cleanup.push(async () => { await Promise.all([sessions.flush(), catalog.flush(), workspaces.flush()]); await tmp.cleanup(); });
    const agent = new FakeAgentAdapter({ id: 'codex', events: [
      { type: 'system', threadId: 'root-thread' }, { type: 'final_text', content: 'reviewed' }, { type: 'done', terminationReason: 'normal' },
    ] });
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 3), activeRuns });
    const release = vi.fn(); const markNotified = vi.fn();
    const bindMain = vi.fn(() => ({ instructions: 'INTERNAL RESULT EVENT', env: { LARK_WORKFLOW_TOKEN: 'test' }, eventIds: ['event-1'], release }));
    const deps = {
      executor, activeRuns, sessions, sessionCatalog: catalog, workspaces, scope: scopeId, agentKind: 'codex', mode: 'topic', entry: { kind: 'workflow', trigger: 'event' },
      channel: { send: vi.fn(), botIdentity: { openId: 'bot' } },
      media: { resolve: vi.fn(async () => []) },
      controls: { profile: 'default', cfg: { accounts: profile.accounts }, profileConfig: profile, botOwnerId: 'user', ownerRefreshState: 'ok' },
      batch: [{ chatId: 'chat', threadId: 'topic', senderId: 'user', chatType: 'group', messageId: 'original-user-input', content: 'DO NOT REPLAY THIS USER MESSAGE', createTime: 500, resources: [], agentEntry: { kind: 'workflow', trigger: 'command' } }],
      workflows: { bindMain, kernel: { markNotified } },
      activePolicyFingerprints: new Map(), lastRunModelByScope: new Map(), userQuestions: { publish: vi.fn() }, cotClient: {},
    } as unknown as Parameters<typeof runAgentBatch>[0];
    if (realFollowup) vi.mocked(presentRunOutput).mockImplementationOnce(async (execution, _output, options) => {
      execution.handle.inputMessageIds.add('om_real_followup');
      for await (const event of execution.subscribe()) options?.recordSession?.(event);
      await execution.result;
    });
    await runAgentBatch(deps);
    expect(agent.runOptions[0]?.threadId).toBe('root-thread');
    expect(bindMain).toHaveBeenCalledWith(scopeId, 'continue');
    expect(agent.runOptions[0]?.prompt).toContain('<workflow_events source="bridge">');
    expect(agent.runOptions[0]?.prompt).not.toContain('DO NOT REPLAY');
    expect(fetchTopicContext).not.toHaveBeenCalled();
    expect(catalog.activeFor(identity)).toMatchObject({ topicContextThrough: 100,
      topicContextSeenMessageIds: realFollowup ? ['om_old_input', 'om_real_followup'] : ['om_old_input'],
      sourceMessageId: realFollowup ? 'om_real_followup' : 'om_old_input' });
    expect(createLarkRunOutput).toHaveBeenCalledWith(expect.objectContaining({ sendOpts: { replyTo: 'original-user-input', replyInThread: true } }));
    expect(presentRunOutput).toHaveBeenCalledOnce();
    expect(markNotified).toHaveBeenCalledWith(scopeId, ['event-1']);
    expect(release).toHaveBeenCalledOnce();
  });
});
