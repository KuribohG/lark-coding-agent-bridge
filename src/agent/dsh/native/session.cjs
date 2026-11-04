'use strict';

const { randomUUID } = require('node:crypto');
const failure = (message, code) => Object.assign(new Error(message), { code });

// Common admission, cancellation and terminal-event rules. The adapter owns the
// individual Agent execution; the collaboration core never drives its tool loop.
function createAgentSession({ scope, execute, dispose = async () => {}, handle = () => null, stopTimeoutMs = 5000 }) {
  const listeners = new Set(), turns = new Map();
  let active = null, closed = false, sequence = 0, closing, disposing, disposed = false;
  function publish(type, data = {}, turnId = active?.id) {
    const event = { ...data, type, scope, turnId, sequence: ++sequence };
    for (const listener of listeners) { try { listener(event); } catch { /* isolated observer */ } }
  }
  function terminal(turn, type, data) {
    if (turn.terminal) return;
    turn.terminal = true;
    turn.outcome = { type, data };
    publish(type, data, turn.id);
    if (active === turn && turn.settled) active = null;
  }
  function disposeOnce() {
    if (disposing) return disposing;
    disposing = (async () => {
      try { await dispose(); disposed = true; }
      catch (error) { if (error.resourceReleased) disposed = true; throw error; }
      finally { if (disposed) { publish('resource-released', { state: 'released' }); listeners.clear(); } }
    })();
    return disposing;
  }
  async function submit({ turnId = randomUUID(), input, signal, invocation } = {}) {
    if (closed) throw failure('Harness session is closed.', 'harness-closed');
    if (turns.has(turnId)) {
      const prior = turns.get(turnId);
      if (prior.outcome) publish(prior.outcome.type, { ...prior.outcome.data, replayed: true }, turnId);
      return { accepted: true, turnId, duplicate: true };
    }
    if (active) throw failure('Harness Agent is already running.', 'harness-busy');
    const turn = { id: turnId, controller: new AbortController(), terminal: false, state: 'running' };
    turn.drained = new Promise(resolve => { turn.resolveDrained = resolve; });
    active = turn; turns.set(turnId, turn);
    if (turns.size > 512) turns.delete(turns.keys().next().value);
    const aborted = () => {
      if (turn.controller.signal.aborted || turn.settled) return;
      turn.state = 'cancel-requested'; turn.controller.abort();
      publish('cancel-requested', { state: 'requested' }, turnId);
      turn.timer = setTimeout(() => {
        if (turn.settled) return;
        turn.state = 'quarantined';
        terminal(turn, 'connection-lost', { state: 'unknown', error: { message: 'Native quiescence was not confirmed. This Agent is quarantined.', code: 'harness-quarantined', reason: 'unknown' } });
      }, stopTimeoutMs);
      turn.timer.unref?.();
    };
    turn.abort = aborted;
    signal?.addEventListener('abort', aborted, { once: true });
    publish('accepted', {}, turnId);
    if (signal?.aborted) aborted();
    queueMicrotask(async () => {
      try {
        turn.controller.signal.throwIfAborted();
        const result = await execute({ input, turnId, invocation, signal: turn.controller.signal,
          publish: (type, data) => { if (!turn.terminal) publish(type, data, turnId); } });
        turn.settled = true;
        if (!turn.controller.signal.aborted) terminal(turn, 'completed', { result });
        else terminal(turn, 'cancelled', { state: 'stopped' });
      } catch (error) {
        turn.settled = true;
        terminal(turn, turn.controller.signal.aborted ? 'cancelled' : 'failed', {
          state: turn.controller.signal.aborted ? 'stopped' : 'failed', error: { message: String(error.message || error), code: error.code, reason: error.reason } });
      } finally {
        clearTimeout(turn.timer); signal?.removeEventListener('abort', aborted);
        if (active === turn) active = null;
        if (turn.state === 'quarantined') { turn.state = 'revoked-idle'; publish('revoked-idle', { state: 'revoked-idle' }, turnId); }
        else turn.state = turn.controller.signal.aborted ? 'stopped' : 'completed';
        turn.done?.();
        turn.resolveDrained();
      }
    });
    return { accepted: true, turnId };
  }
  return {
    submit,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async cancel({ turnId } = {}) {
      const turn = turns.get(turnId || active?.id);
      if (!turn) return { state: 'unknown' };
      if (turn.settled) return { state: 'stopped' };
      if (turn.state === 'quarantined') return { state: 'unknown' };
      turn.abort();
      return { state: 'requested' };
    },
    handle,
    async waitForQuiescence(timeoutMs) {
      const turn = active;
      if (!turn || turn.settled) return { state: 'quiescent' };
      let timer;
      const drained = await Promise.race([turn.drained.then(() => true), new Promise(resolve => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      })]);
      clearTimeout(timer);
      return { state: drained ? 'quiescent' : 'unknown' };
    },
    state: () => disposed ? 'closed' : active?.state || 'idle',
    close() {
      if (disposed) return Promise.resolve({ state: 'stopped' });
      if (closing) return closing;
      closing = (async () => {
        closed = true;
        const turn = active;
        if (turn) {
          const settled = new Promise(resolve => { turn.done = resolve; });
          turn.abort();
          let timer;
          const drained = await Promise.race([settled.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), stopTimeoutMs); })]);
          clearTimeout(timer);
          if (!drained) {
            settled.then(disposeOnce).catch(() => {});
            return { state: 'unknown', hardStop: 'host-lifecycle-required' };
          }
        }
        await disposeOnce(); return { state: 'stopped' };
      })();
      return closing;
    },
  };
}

async function runTurn(session, { turnId = randomUUID(), input, signal, invocation, onEvent = () => {} }) {
  let unsubscribe;
  const result = new Promise((resolve, reject) => {
    unsubscribe = session.subscribe(event => {
      if (event.turnId !== turnId) return;
      try { onEvent(event); } catch (error) { reject(error); return; }
      if (event.type === 'completed') resolve(event.result);
      if (['failed', 'connection-lost', 'cancelled'].includes(event.type)) reject(Object.assign(
        new Error(event.error?.message || (event.type === 'cancelled' ? 'Assistant task cancelled.' : 'Harness connection lost.')),
        { ...event.error, reason: event.type === 'cancelled' ? 'cancelled' : event.error?.reason }));
    });
  });
  // Install the rejection handler before submit: synchronous cancellation is valid.
  result.catch(() => {});
  try { await session.submit({ turnId, input, signal, invocation }); return await result; }
  finally { unsubscribe?.(); }
}

function validateHarness(harness) {
  if (!harness || typeof harness.open !== 'function' || typeof harness.describe !== 'function')
    throw failure('A Harness with describe/open is required.', 'harness-contract');
  const capabilities = harness.describe();
  if (!capabilities.id || !capabilities.tools?.registeredOnly || !capabilities.isolation)
    throw failure('Harness cannot enforce isolated registered tools.', 'harness-unsafe');
  return harness;
}

module.exports = { createAgentSession, runTurn, validateHarness };
