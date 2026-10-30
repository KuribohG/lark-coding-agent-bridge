import { getQuickJS, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten';
import { SCRIPT_MAX_TASKS, SCRIPT_MAX_TEXT } from './script-contract';

export interface ScriptProgramInput {
  source: string;
  args: unknown;
  signal: AbortSignal;
  agent(call: unknown): Promise<unknown>;
  mailbox?(call: unknown): Promise<unknown>;
  work?(call: unknown): Promise<unknown>;
  progress(kind: 'phase' | 'log', text: string): void;
}

const PRELUDE = `(() => {
  'use strict';
  const invoke = __bridgeAgent;
  const mail = __bridgeMailbox;
  const work = __bridgeWork;
  const progress = __bridgeProgress;
  delete globalThis.__bridgeAgent;
  delete globalThis.__bridgeMailbox;
  delete globalThis.__bridgeWork;
  delete globalThis.__bridgeProgress;
  globalThis.agent = (prompt, options = {}) => {
    if (typeof prompt !== 'string' || !options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('agent(prompt, options) expected');
    return invoke(JSON.stringify({...options, prompt})).then(JSON.parse);
  };
  globalThis.send = (member, text, options = {}) => mail(JSON.stringify({...options, kind: 'send', member, text})).then(JSON.parse);
  globalThis.receive = (member, options = {}) => mail(JSON.stringify({...options, kind: 'receive', member})).then(JSON.parse);
  globalThis.enqueueWork = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('enqueueWork(item) expected');
    return work(JSON.stringify({...item, kind: 'enqueue'})).then(JSON.parse);
  };
  globalThis.workStatus = (options = {}) => work(JSON.stringify({...options, kind: 'status'})).then(JSON.parse);
  globalThis.parallel = tasks => {
    if (!Array.isArray(tasks) || tasks.length > ${SCRIPT_MAX_TASKS} || tasks.some(task => typeof task !== 'function')) throw new TypeError('parallel expects a bounded array of functions');
    return Promise.all(tasks.map(task => task()));
  };
  globalThis.pipeline = (items, ...stages) => {
    if (!Array.isArray(items) || items.length > ${SCRIPT_MAX_TASKS} || stages.length === 0 || stages.some(stage => typeof stage !== 'function')) throw new TypeError('pipeline expects items and stage functions');
    return Promise.all(items.map(async (item, index) => {
      let value = item;
      for (const stage of stages) value = await stage(value, index);
      return value;
    }));
  };
  globalThis.phase = text => progress('phase', String(text));
  globalThis.log = text => progress('log', String(text));
  globalThis.Date = undefined;
  Math.random = () => { throw new Error('Pass randomness through args for reproducible replay'); };
  Object.freeze(Math);
})();`;

/** A guest interpreter with JSON-only host calls; no host objects or module loader. */
export async function runScriptProgram(input: ScriptProgramInput): Promise<string> {
  input.signal.throwIfAborted();
  const quickjs = await getQuickJS();
  input.signal.throwIfAborted();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const context = runtime.newContext();
  let disposed = false;
  let sliceDeadline = 0;
  let cpuMs = 0;
  let calls = 0;
  let mailboxCalls = 0;
  let workCalls = 0;
  let progressCount = 0;
  let pending = 0;
  let hostError: unknown;
  let jobCount = 0;
  let wake: (() => void) | undefined;
  let promise: QuickJSHandle | undefined;
  const deferreds = new Set<QuickJSDeferredPromise>();
  runtime.setInterruptHandler(() => input.signal.aborted || performance.now() >= sliceDeadline || cpuMs > 2000);
  const guest = <T>(action: () => T): T => {
    if (cpuMs > 2000) throw new Error('Script CPU budget reached');
    const start = performance.now();
    sliceDeadline = start + 100;
    try { return action(); } finally { cpuMs += performance.now() - start; }
  };
  const onAbort = () => wake?.();
  input.signal.addEventListener('abort', onAbort, { once: true });
  const install = (name: string, fn: Parameters<typeof context.newFunction>[1]) => {
    const handle = context.newFunction(name, fn);
    context.setProp(context.global, name, handle);
    handle.dispose();
  };
  try {
    const installAsync = (name: string, invoke: (call: unknown) => Promise<unknown>) => install(name, payload => {
      const count = name === '__bridgeAgent' ? ++calls : name === '__bridgeMailbox' ? ++mailboxCalls : ++workCalls;
      if (count > SCRIPT_MAX_TASKS) throw new Error('Script call limit reached');
      const text = context.getString(payload);
      if (text.length > SCRIPT_MAX_TEXT + 2000) throw new Error('agent input exceeds size limit');
      const call: unknown = JSON.parse(text);
      const deferred = context.newPromise();
      deferreds.add(deferred);
      pending++;
      const settle = (value: unknown, failed: boolean) => {
        pending--;
        if (disposed) return;
        let encoded: string;
        try {
          encoded = failed ? String(value) : JSON.stringify(value ?? null);
          if (encoded.length > SCRIPT_MAX_TEXT) throw new Error('Agent output exceeds size limit');
        } catch (error) { failed = true; encoded = String(error); }
        try {
          const handle = failed ? context.newError(encoded.slice(0, 2000)) : context.newString(encoded);
          try { if (failed) deferred.reject(handle); else deferred.resolve(handle); }
          finally { handle.dispose(); }
        } finally { wake?.(); }
      };
      void Promise.resolve().then(() => { input.signal.throwIfAborted(); return invoke(call); }).then(
        value => settle(value, false),
        error => settle(error instanceof Error ? error.message : String(error), true),
      ).catch(error => { hostError = error; wake?.(); });
      return deferred.handle;
    });
    installAsync('__bridgeAgent', input.agent);
    installAsync('__bridgeMailbox', call => {
      if (!input.mailbox) throw new Error('Mailbox host is unavailable');
      return input.mailbox(call);
    });
    installAsync('__bridgeWork', call => {
      if (!input.work) throw new Error('Work queue host is unavailable');
      return input.work(call);
    });
    install('__bridgeProgress', (kind, value) => {
      if (++progressCount > 100) throw new Error('Script progress limit reached');
      const name = context.getString(kind);
      if (name !== 'phase' && name !== 'log') throw new Error('Invalid progress kind');
      input.progress(name, context.getString(value).slice(0, 1000));
    });
    const initialized = guest(() => context.evalCode(PRELUDE));
    context.unwrapResult(initialized).dispose();
    const args = guest(() => context.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(input.args ?? null))})`));
    const argsHandle = context.unwrapResult(args);
    context.setProp(context.global, 'args', argsHandle);
    argsHandle.dispose();
    promise = context.unwrapResult(guest(() => context.evalCode(`(async () => { 'use strict';\n${input.source}\n})().then(value => JSON.stringify(value === undefined ? null : value))`, 'workflow.js')));
    for (;;) {
      input.signal.throwIfAborted();
      if (hostError) throw hostError;
      const jobs = guest(() => runtime.executePendingJobs(128));
      if (jobs.error) {
        let message;
        try { message = guest(() => context.dump(jobs.error!)); }
        finally { jobs.dispose(); }
        throw new Error(`Script execution failed: ${message?.message ?? String(message)}`);
      }
      jobCount += jobs.value;
      jobs.dispose();
      if (jobCount > 100_000) throw new Error('Script job budget reached');
      const state = context.getPromiseState(promise);
      if (state.type === 'fulfilled') {
        try {
          if (pending) throw new Error('Script returned before all agent(), mailbox or work queue calls finished; await every call');
          if (context.typeof(state.value) !== 'string') throw new Error('Script result is not JSON serializable');
          const result = context.getString(state.value);
          if (!result || result.length > SCRIPT_MAX_TEXT) throw new Error('Script result exceeds size limit or is not JSON serializable');
          JSON.parse(result);
          return result;
        } finally { state.value.dispose(); }
      }
      if (state.type === 'rejected') {
        try {
          const error = guest(() => context.dump(state.error));
          throw new Error(`Script failed: ${error?.message ?? error}`);
        }
        finally { state.error.dispose(); }
      }
      await new Promise<void>(resolve => {
        wake = resolve;
        if (input.signal.aborted || runtime.hasPendingJob()) setImmediate(resolve);
      });
      wake = undefined;
    }
  } finally {
    disposed = true;
    input.signal.removeEventListener('abort', onAbort);
    for (const deferred of deferreds) deferred.dispose();
    promise?.dispose();
    context.dispose();
    runtime.dispose();
  }
}
