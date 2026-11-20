'use strict';
const { digestEvents } = require('./event-digest.cjs');
const foreign = message => Object.assign(new Error(message), { code: 'harness-foreign-modified', reason: 'unknown' });
const ownedInsideTurn = new Set(['request/header', 'request/context', 'system/message', 'developer/message', 'assistant/message', 'assistant/attempt',
  'session-log-deepseek/delivery-accepted', 'tool/call', 'tool/result', 'compaction/start', 'compaction/end', 'compaction/prune', 'compaction/summary', 'llm/retry', 'llm/retry-started']);

// An observation never becomes a trusted checkpoint here. Ownership is proved
// against core-durable followup IDs; only a subsequent controlled native resume,
// cancellation of old inbox work and live flush may establish a new checkpoint.
function auditOwnedEvents(events, base, turnIds) {
  if (!base || events.length < base.count || digestEvents(events.slice(0, base.count), base.digestAlgorithm) !== base.prefixHash) throw foreign('Native committed prefix changed; recovery is fenced.');
  const allowed = new Set(turnIds), used = new Set(); let pendingOwned = false, activeTurn = null;
  for (const event of events.slice(base.count)) {
    const data = event.data || {};
    if (event.type === 'session/end-seed' && Object.keys(data).length === 0) continue;
    if (event.type === 'agent/inbox/spliced') {
      for (const message of data.inserted || []) {
        if (message.role !== 'user' || message.source?.kind !== 'user' || !allowed.has(message.id)) throw foreign('Native inbox contains input not owned by a durable core turn.');
        used.add(message.id); pendingOwned = true;
      }
      if (!used.size && (data.removedCount || 0) > 0) throw foreign('Native inbox changed without an owned turn.');
      continue;
    }
    if (event.type === 'turn/start') {
      if (!pendingOwned || activeTurn !== null) throw foreign('Native turn has no owned followup origin.');
      activeTurn = data.turn; pendingOwned = false; continue;
    }
    if (event.type === 'user/message') {
      if (activeTurn === null || !allowed.has(data.id)) throw foreign('Native user message is outside durable turn ownership.');
      used.add(data.id); continue;
    }
    if (event.type === 'step/start' || event.type === 'step/end' || event.type === 'turn/end') {
      if (activeTurn === null || data.turn !== activeTurn) throw foreign('Native step/turn marker is outside the owned turn.');
      if (event.type === 'turn/end') activeTurn = null;
      continue;
    }
    if (!ownedInsideTurn.has(event.type) || activeTurn === null || data.turn !== undefined && data.turn !== activeTurn)
      throw foreign(`Native event ${event.type} cannot be attributed to a durable core turn.`);
  }
  return { turnIds: [...used], suffixEvents: events.length - base.count };
}

async function observeOwnedRecovery({ ctx, nativeSessionId, highWater, scope, turnIds, workspace }) {
  const before = await ctx.sessionPersistence.stat(nativeSessionId);
  const reader = await ctx.sessionPersistence.open(nativeSessionId, 'read');
  try {
    const read = await reader.read(), after = await ctx.sessionPersistence.stat(nativeSessionId);
    if (!before || !after || before.revision !== after.revision || before.sizeBytes !== after.sizeBytes || reader.header.cwd !== workspace)
      throw foreign('Native storage or workspace changed during recovery observation.');
    const audit = auditOwnedEvents(read.events, highWater, turnIds);
    return { ...audit, scope, observation: { count: read.events.length, prefixHash: digestEvents(read.events, highWater.digestAlgorithm),
      digestAlgorithm: highWater.digestAlgorithm, byteLength: after.sizeBytes } };
  } catch (error) { if (error.code === 'harness-foreign-modified') throw error; throw foreign('Native recovery log is unreadable; original bytes were preserved.'); }
  finally { await reader.close(); }
}
module.exports = { auditOwnedEvents, observeOwnedRecovery };
