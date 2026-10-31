import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun } from '../../../src/agent/types';
import { capabilityForBackend } from '../../../src/agent/capability';
import { ActiveRuns } from '../../../src/runtime/active-runs';
import { trackRunSession } from '../../../src/runtime/session-progress';
import type { RunExecution, RunResult } from '../../../src/runtime/run-executor';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function harness() {
  const tmp = await createTmpProfile('session-progress-');
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'catalog.json'));
  cleanup.push(async () => { await Promise.all([sessions.flush(), catalog.flush()]); await tmp.cleanup(); });
  const activeRuns = new ActiveRuns();
  const identity = { scopeId: 'scope', agentId: 'codex' as const, cwdRealpath: tmp.workspace, policyFingerprint: 'policy' };
  catalog.upsertActive({ ...identity, threadId: 'thread-one' });
  catalog.markCompleted({ ...identity, sourceMessageId: 'om_old_input', topicContextThrough: 100, topicContextSeenMessageIds: ['om_old_input'] });
  let end!: () => void;
  const gate = new Promise<void>(resolve => { end = resolve; });
  let result!: (state: RunResult) => void;
  const events: AgentEvent[] = [{ type: 'system', threadId: 'thread-one' }];
  const run: AgentRun = { runId: 'run-one', events: { async *[Symbol.asyncIterator]() {
    yield events[0]!; await gate;
    for (const event of events.slice(1)) yield event;
  } }, stop: async () => {}, waitForExit: async () => true };
  const handle = activeRuns.register('scope', run);
  const execution: RunExecution = { run, handle, runId: run.runId, scopeId: 'scope',
    subscribe: () => run.events, stop: async () => {}, result: new Promise(resolve => { result = resolve; }) };
  const track = (source: Parameters<typeof trackRunSession>[0]['source']) => trackRunSession({ ...identity,
    sessions, sessionCatalog: catalog, activeRuns, execution, source, capability: capabilityForBackend('codex'),
    policy: { ok: true, prompt: '', requestedCwd: tmp.workspace, cwdRealpath: tmp.workspace, accessMode: 'full',
      sandbox: 'danger-full-access', permissionMode: 'bypassPermissions', access: { ok: true, reason: 'allowed-user' },
      attachments: [], policyFingerprint: 'policy', expiresAt: Date.now() + 10000 } });
  return { catalog, activeRuns, execution, events, track, identity, entry: () => catalog.activeFor(identity)!,
    finish(state: RunResult) { activeRuns.unregister('scope', run); result(state); end(); } };
}

it('records native state and commits delivered history without an output renderer', async () => {
  const h = await harness();
  h.execution.handle.inputMessageIds.add('om_follow_up');
  h.events.push({ type: 'usage', inputTokens: 50, contextWindowTokens: 1000 });
  const done = h.track({ kind: 'message', messageId: 'om_new_input', history: { seenMessageIds: ['om_new_input', 'om_context'], completeThrough: 200 } });
  await vi.waitFor(() => expect(h.execution.handle.sessionIdentity?.threadId).toBe('thread-one'));
  h.finish('completed'); await done;
  expect(h.entry()).toMatchObject({ sourceMessageId: 'om_new_input', topicContextThrough: 200,
    topicContextSeenMessageIds: ['om_old_input', 'om_new_input', 'om_context', 'om_follow_up'], contextUsage: { inputTokens: 50 } });
});

it.each(['failed', 'stopped'] as const)('does not consume message history on %s', async state => {
  const h = await harness();
  const done = h.track({ kind: 'message', messageId: 'om_new_input', history: { seenMessageIds: ['om_context'], completeThrough: 200 } });
  h.finish(state); await done;
  expect(h.entry()).toMatchObject({ sourceMessageId: 'om_old_input', topicContextThrough: 100, topicContextSeenMessageIds: ['om_old_input'] });
});

it('keeps the cursor at the last complete fetch when context is partial', async () => {
  const h = await harness();
  const done = h.track({ kind: 'message', messageId: 'om_new_input', history: { seenMessageIds: ['om_available_context'] } });
  h.finish('completed'); await done;
  expect(h.entry()).toMatchObject({ topicContextThrough: 100, topicContextSeenMessageIds: ['om_old_input', 'om_available_context'] });
});

it.each([false, true])('only real input during an internal wake may change history: %s', async followup => {
  const h = await harness();
  if (followup) h.execution.handle.inputMessageIds.add('om_real_follow_up');
  const done = h.track({ kind: 'internal' });
  h.finish('completed'); await done;
  expect(h.entry()).toMatchObject({ topicContextThrough: 100, sourceMessageId: followup ? 'om_real_follow_up' : 'om_old_input',
    topicContextSeenMessageIds: followup ? ['om_old_input', 'om_real_follow_up'] : ['om_old_input'] });
});

it('rejects late events even after a newer run has already unregistered', async () => {
  const h = await harness();
  const done = h.track({ kind: 'message', messageId: 'om_late_input' });
  await vi.waitFor(() => expect(h.execution.handle.sessionIdentity?.threadId).toBe('thread-one'));
  h.activeRuns.unregister('scope', h.execution.run);
  const newer = { ...h.execution.run, runId: 'run-two' };
  h.activeRuns.register('scope', newer);
  h.activeRuns.unregister('scope', newer);
  h.catalog.upsertActive({ ...h.identity, threadId: 'thread-two' });
  h.events.push({ type: 'system', threadId: 'thread-one' });
  h.finish('completed'); await done;
  expect(h.entry().threadId).toBe('thread-two');
  expect(h.entry().sourceMessageId).not.toBe('om_late_input');
});

it('does not commit old completion onto a newly selected session', async () => {
  const h = await harness();
  const done = h.track({ kind: 'message', messageId: 'om_late_input' });
  await vi.waitFor(() => expect(h.execution.handle.sessionIdentity?.threadId).toBe('thread-one'));
  h.catalog.upsertActive({ ...h.identity, threadId: 'thread-two' });
  h.finish('completed'); await done;
  expect(h.entry().sourceMessageId).not.toBe('om_late_input');
});
