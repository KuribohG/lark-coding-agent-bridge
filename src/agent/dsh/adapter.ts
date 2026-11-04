import { createRequire } from 'node:module';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions, NativeTurnBinding, PreparedAgentRun, StopSettlement } from '../types';
import { classifyAgentFailure } from '../execution';
import { preparedRun } from '../prepared-run';
import { RunExecutor, type RunExecution } from '../../runtime/run-executor';
import { ActiveRuns } from '../../runtime/active-runs';
import { ProcessPool } from '../../runtime/process-pool';

// Built as an ESM library once. The native assets are copied verbatim beside
// this entry, retaining __dirname and the existing DSH profile/handle identity.
const requireNative = createRequire(import.meta.url);
const native = requireNative('./dsh/index.cjs');
export const dshProfile = requireNative('./dsh/profile.cjs');
export const dshLease = requireNative('./dsh/lease.cjs');
export const dshStorageChecks = requireNative('./dsh/storage-check.cjs');
export const dshRecovery = requireNative('./dsh/recovery.cjs');
export const dshEventDigest = requireNative('./dsh/event-digest.cjs');
export const nativeSession = requireNative('./dsh/session.cjs');
const { canonicalJson } = requireNative('./dsh/utilities.cjs');
export const { publicText, usageOf } = native;

class Events {
  private items: AgentEvent[] = [];
  private wake?: () => void;
  private ended = false;
  push(event: AgentEvent): void { this.items.push(event); this.wake?.(); }
  close(): void { this.ended = true; this.wake?.(); }
  async *stream(): AsyncGenerator<AgentEvent> {
    while (!this.ended || this.items.length) {
      if (this.items.length) yield this.items.shift()!;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}

export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh';
  readonly displayName = 'DSH';
  readonly capabilities = { finalAnswer: 'separate-event', input: 'unsupported', lifecycle: 'session' } as const;
  async isAvailable(): Promise<boolean> { return true; }
  async prepareRun(options: AgentRunOptions): Promise<PreparedAgentRun> {
    if (!options.nativeTurn?.session) throw new Error('DSH requires a trusted host native-session binding');
    return preparedRun({ model: options.model, reasoningEffort: options.reasoningEffort }, () => this.start(options, options.nativeTurn!));
  }
  private start(options: AgentRunOptions, binding: NativeTurnBinding): AgentRun {
    const events = new Events();
    const session = binding.session;
    let terminal = false;
    const end = () => { terminal = true; unsubscribe(); events.close(); };
    const unsubscribe = session.subscribe((event: any) => {
      if (event.turnId !== binding.turnId || terminal) return;
      if (event.type === 'accepted') events.push({ type: 'system', sessionId: session.handle()?.nativeSessionId, model: options.model });
      else if (event.type === 'output-delta') events.push({ type: 'text', delta: event.text });
      else if (event.type === 'tool-request') {
        let input; try { input = JSON.parse(event.call.function.arguments); } catch { input = {}; }
        events.push({ type: 'tool_use', id: event.call.id, name: event.call.function.name, input });
      } else if (event.type === 'tool-result') events.push({ type: 'tool_result', id: event.call.id, output: JSON.stringify(event.result), isError: false });
      else if (event.type === 'completed') {
        events.push({ type: 'final_text', content: event.result?.content || '' });
        const usage = event.result?.usage;
        if (usage) events.push({ type: 'usage', inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, cachedInputTokens: usage.cacheHitTokens });
        events.push({ type: 'done', sessionId: session.handle()?.nativeSessionId, terminationReason: 'normal' }); end();
      } else if (event.type === 'cancelled') { events.push({ type: 'done', terminationReason: 'interrupted' }); end(); }
      else if (event.type === 'failed' || event.type === 'connection-lost') {
        events.push({ type: 'error', message: event.error?.message || 'Native result is unavailable', terminationReason: 'failed',
          failureKind: event.type === 'connection-lost' || event.error?.reason === 'unknown' ? 'delivery_unknown' : classifyAgentFailure(event.error?.message || '') }); end();
      }
    });
    void session.submit({ turnId: binding.turnId, input: binding.input, invocation: binding.invocation, signal: binding.signal }).catch((error: any) => {
      if (terminal) return;
      events.push({ type: 'error', message: String(error.message || error), terminationReason: 'failed',
        failureKind: error.reason === 'unknown' ? 'delivery_unknown' : classifyAgentFailure(String(error.message || error)) }); end();
    });
    return { runId: options.runId, capabilities: this.capabilities, events: events.stream(),
      async stop() { await session.cancel({ turnId: binding.turnId }); return { state: 'requested' }; },
      waitForQuiescence: timeoutMs => session.waitForQuiescence(timeoutMs),
      // A warm, drained session is deliberately not reported as an exited process.
      async waitForExit() { return session.state() === 'closed'; },
    };
  }
}

export function createExecutionHost(options: { maxConcurrentRuns?: number; stopTimeoutMs?: number } = {}) {
  const pool = new ProcessPool(() => options.maxConcurrentRuns ?? 32);
  const activeRuns = new ActiveRuns();
  const executor = new RunExecutor({ resolveAgent: () => { throw new Error('An exact backend is required'); }, pool, activeRuns,
    postDoneExitGraceMs: options.stopTimeoutMs ?? 5000 });
  return { pool, activeRuns, executor };
}
let defaultHost: ReturnType<typeof createExecutionHost> | undefined;

/** Compatibility protocol; all native turns still pass through RunExecutor. */
export function createDshHarness(options: any) {
  const backend = native.createDshHarness(options);
  const host = options.executionHost ?? (defaultHost ??= createExecutionHost());
  const adapter = new DshAdapter();
  const sessions = new Set<any>();
  async function wrap(settings: any, persisted?: any) {
    const session = persisted ? await backend.resume(persisted, settings) : await backend.open(settings);
    const lifecycle = new AbortController();
    const listeners = new Set<(event: any) => void>();
    type ExecutionRecord = { execution?: RunExecution; admission?: Promise<RunExecution>; relay?: Promise<void>; terminal?: any; published?: boolean };
    const executions = new Map<string, ExecutionRecord>();
    const publish = (event: any) => { for (const listener of listeners) { try { listener(event); } catch { /* observer isolation */ } } };
    const unsubscribe = session.subscribe((event: any) => {
      const record = executions.get(event.turnId);
      if (record && ['completed', 'failed', 'cancelled', 'connection-lost'].includes(event.type)) { record.terminal = event; return; }
      if (event.type === 'resource-released') void wrapped.reconcile().catch(() => { /* the durable unknown receipt remains fenced */ });
      publish(event);
    });
    const wrapped = {
      handle: session.handle, state: session.state, waitForQuiescence: session.waitForQuiescence,
      ...(session.storageChecks ? { storageChecks: session.storageChecks } : {}),
      ...(session.inspectTools ? { inspectTools: session.inspectTools } : {}),
      subscribe(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async submit(request: any) {
        const { turnId, input, invocation } = request;
        const signal = request.signal ? AbortSignal.any([request.signal, lifecycle.signal]) : lifecycle.signal;
        if (!turnId) throw new Error('A host-durable turn identity is required');
        if (executions.has(turnId)) return { accepted: true, turnId, duplicate: true };
        const record: ExecutionRecord = {};
        executions.set(turnId, record);
        try {
          record.admission = host.executor.submit({ agent: adapter, executionId: invocation?.executionId || turnId,
            attemptId: invocation?.attemptId, retryPolicy: 'none', quiescenceTimeoutMs: options.stopTimeoutMs || 5000, scopeId: canonicalJson(settings.scope),
            signal, model: settings.model, reasoningEffort: settings.effort,
            nativeTurn: { session, turnId, input, invocation, signal, onEvent() {} },
            validateBeforeRun: async () => { signal?.throwIfAborted(); await invocation?.validateLease?.(); },
            // This envelope admits only the already registered host tool set.
            // Every effect still validates its trusted per-turn host lease.
            policy: { ok: true, prompt: input.text || '', requestedCwd: options.workspace, cwdRealpath: options.workspace,
              accessMode: 'full', sandbox: 'danger-full-access', permissionMode: 'bypassPermissions',
              access: { ok: true } as any, attachments: [], policyFingerprint: invocation?.authority?.policyRevision || 'registered-host-tools',
              expiresAt: invocation?.authority?.expiresAt ?? Number.MAX_SAFE_INTEGER },
          });
          const execution = await record.admission;
          record.execution = execution;
          record.relay = (async () => {
            for await (const _event of execution.subscribe()) { /* native public facts use the legacy protocol */ }
            const result = await execution.result;
            record.published = true;
            publish(result === 'unknown' ? { type: 'connection-lost', turnId, scope: settings.scope, error: { code: 'harness-quarantined', reason: 'unknown', message: 'Native settlement is unknown; execution resources remain quarantined.' } }
              : record.terminal ?? { type: 'failed', turnId, scope: settings.scope, error: { code: 'harness-connection-lost', reason: 'unknown', message: 'Native terminal receipt is missing.' } });
          })().catch((error: any) => publish({ type: 'connection-lost', turnId, scope: settings.scope, error: { code: 'harness-connection-lost', reason: 'unknown', message: String(error.message || error) } }));
          return { accepted: true, turnId };
        } catch (error) { executions.delete(turnId); throw error; }
      },
      cancel: session.cancel,
      async reconcile(): Promise<StopSettlement> {
        const results = await Promise.all([...executions.values()].map(row => row.execution?.reconcile()));
        return { state: results.some(row => row?.state !== 'quiescent') ? 'unknown' : 'quiescent' };
      },
      async close() {
        lifecycle.abort();
        const result = await session.close();
        if (result?.state !== 'unknown') {
          await Promise.allSettled([...executions.values()].map(row => row.admission));
          await Promise.all([...executions.values()].map(row => row.relay));
          await wrapped.reconcile(); unsubscribe(); sessions.delete(wrapped); listeners.clear();
        }
        return result;
      },
    };
    sessions.add(wrapped); return wrapped;
  }
  return { ...backend, executionHost: host,
    sessionProvider: { version: 1, allocate: backend.allocate, acquire: wrap, resume: (handle: any, settings: any) => wrap(settings, handle),
      inspect: backend.inspect, reconcile: backend.reconcile, release: (session: any) => session.close() },
    open: (settings: any) => wrap(settings), resume: (handle: any, settings: any) => wrap(settings, handle),
    async close() {
      const results = await Promise.all([...sessions].map(session => session.close()));
      if (results.some(result => result?.state === 'unknown')) return { state: 'unknown', hardStop: 'host-lifecycle-required' };
      return backend.close();
    },
  };
}
