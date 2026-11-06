import { createRequire } from 'node:module';
import type { StopSettlement } from '../types';
import { RunExecutor, type GovernedRunExecution } from '../../runtime/run-executor';
import { ActiveRuns } from '../../runtime/active-runs';
import { ProcessPool } from '../../runtime/process-pool';
import { DshAdapter } from './adapter';

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
    type ExecutionRecord = { execution?: GovernedRunExecution; relay?: Promise<void>; terminal?: any; published?: boolean; admission?: Promise<GovernedRunExecution> };
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
          const admission: Promise<GovernedRunExecution> = host.executor.submit({ agent: adapter, executionId: invocation?.executionId || turnId,
            attemptId: invocation?.attemptId, governed: true, quiescenceTimeoutMs: options.stopTimeoutMs || 5000, scopeId: canonicalJson(settings.scope),
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
          record.admission = admission;
          const execution = await admission;
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
