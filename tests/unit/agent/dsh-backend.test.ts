import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_KINDS,
  isAgentKind,
  isRegisteredAgentKind,
  REGISTERED_AGENT_KINDS,
  sessionIdFieldForAgent,
} from '../../../src/agent/backend-spec';
import { AGENT_OPTIONS, detectedAgentCandidates, executionCapabilitiesForProfile, backendFor } from '../../../src/agent/backends';
import { DshAdapter } from '../../../src/agent/dsh/adapter';
import { parseEffort } from '../../../src/agent/model-settings';
import { supportedModels } from '../../../src/agent/models';
import type { AgentEvent, AgentRunOptions, NativeTurnBinding } from '../../../src/agent/types';
import { ProfileExecutionController } from '../../../src/runtime/execution-controller';
import { ScopeExecutionStore } from '../../../src/session/scope-execution';

const permissions = { defaultAccess: 'full', maxAccess: 'full' } as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

function nativeSession() {
  const listeners = new Set<(event: unknown) => void>();
  return {
    emit(event: unknown) { for (const listener of [...listeners]) listener(event); },
    session: {
      subscribe(listener: (event: unknown) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      submit: vi.fn(async () => ({ accepted: true })),
      cancel: vi.fn(async () => {}),
      handle: () => ({ nativeSessionId: 'native' }),
      state: () => 'idle',
      waitForQuiescence: vi.fn(async () => ({ state: 'quiescent' })),
    },
  };
}

async function startTurn(native: ReturnType<typeof nativeSession>) {
  const binding: NativeTurnBinding = { session: native.session, turnId: 'turn', input: { text: 'hello' }, invocation: {}, onEvent() {} };
  const prepared = await new DshAdapter().prepareRun({ runId: 'run', prompt: 'hello', cwd: '.', nativeTurn: binding } as AgentRunOptions);
  return prepared.start();
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('dsh host-supplied backend', () => {
  it('is registered without becoming selectable by profiles, flags or channel options', () => {
    expect(REGISTERED_AGENT_KINDS).toContain('dsh');
    expect(isRegisteredAgentKind('dsh')).toBe(true);
    expect(isRegisteredAgentKind('claude')).toBe(true);
    expect(isRegisteredAgentKind('gemini')).toBe(false);
    expect(AGENT_KINDS).not.toContain('dsh');
    expect(isAgentKind('dsh')).toBe(false);
    expect(AGENT_OPTIONS.map((option) => option.value)).not.toContain('dsh');
    expect(detectedAgentCandidates().map((candidate) => candidate.kind)).not.toContain('dsh');
  });

  it('describes its session, catalog and native reasoning values', () => {
    expect(sessionIdFieldForAgent('dsh')).toBe('sessionId');
    expect(backendFor('dsh').displayName).toBe('DeepSeek Harness');
    expect(supportedModels('dsh').map((model) => model.value)).toEqual(['default']);
    expect(parseEffort('off', 'dsh')).toBe('off');
    expect(() => parseEffort('off', 'claude')).toThrow();
    expect(executionCapabilitiesForProfile({ agentKind: 'dsh', permissions })).toMatchObject({ finalAnswer: 'separate-event', lifecycle: 'session' });
  });

  it('refuses a run without a trusted host session', async () => {
    await expect(new DshAdapter().prepareRun({ runId: 'run', prompt: 'hello', cwd: '.' } as AgentRunOptions))
      .rejects.toThrow('trusted host native-session binding');
  });

  it('lets the host supply the adapter and keeps the selection across a restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-backend-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'scope-execution.json');
    const scopeExecution = new ScopeExecutionStore(path);
    await scopeExecution.load();
    const supplied = new DshAdapter();
    const execution = new ProfileExecutionController({
      profileConfig: { agentKind: 'claude', permissions }, scopeExecution,
      appPaths: { profileDir: directory }, hostAdapters: { dsh: () => supplied },
    });
    await execution.setScopeKind('scope', 'dsh');
    expect(execution.kindFor('scope')).toBe('dsh');
    expect(execution.get('scope')).toBe(supplied);

    const reloaded = new ScopeExecutionStore(path);
    await reloaded.load();
    expect(reloaded.get('scope')).toBe('dsh');
  });

  it('maps only its own native turn to agent events and reports a warm session as not exited', async () => {
    const native = nativeSession();
    const run = await startTurn(native);
    expect(native.session.submit).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'turn' }));
    native.emit({ turnId: 'other', type: 'output-delta', text: 'foreign' });
    native.emit({ turnId: 'turn', type: 'accepted' });
    native.emit({ turnId: 'turn', type: 'output-delta', text: 'partial' });
    native.emit({ turnId: 'turn', type: 'completed', result: { content: 'answer', usage: { promptTokens: 2, completionTokens: 3, cacheHitTokens: 1 } } });
    const events = await collect(run.events);
    expect(events.map((event) => event.type)).toEqual(['system', 'text', 'final_text', 'usage', 'done']);
    expect(events).toContainEqual({ type: 'final_text', content: 'answer' });
    expect(await run.waitForExit(1)).toBe(false);
    expect(await run.waitForQuiescence!(1)).toEqual({ state: 'quiescent' });
  });

  it('reports a refused submission to the host with its exact code', async () => {
    const native = nativeSession();
    native.session.submit.mockRejectedValueOnce(Object.assign(new Error('Foreign change'), { code: 'harness-foreign-modified', reason: 'unknown' }));
    const reported: unknown[] = [];
    const binding: NativeTurnBinding = { session: native.session, turnId: 'turn', input: { text: 'hello' }, invocation: {}, onEvent: event => reported.push(event) };
    const prepared = await new DshAdapter().prepareRun({ runId: 'run', prompt: 'hello', cwd: '.', nativeTurn: binding } as AgentRunOptions);
    const events = await collect(prepared.start().events);
    expect(events).toEqual([expect.objectContaining({ type: 'error', failureKind: 'delivery_unknown' })]);
    expect(reported).toEqual([{ type: 'connection-lost', turnId: 'turn',
      error: { code: 'harness-foreign-modified', reason: 'unknown', message: 'Foreign change' } }]);
  });

  it('reports a lost native result as delivery unknown and cancels only its own turn', async () => {
    const native = nativeSession();
    const run = await startTurn(native);
    await run.stop('cancelled');
    expect(native.session.cancel).toHaveBeenCalledWith({ turnId: 'turn' });
    native.emit({ turnId: 'turn', type: 'connection-lost', error: { message: 'Native result is unavailable' } });
    expect(await collect(run.events)).toEqual([expect.objectContaining({ type: 'error', failureKind: 'delivery_unknown' })]);
  });
});
