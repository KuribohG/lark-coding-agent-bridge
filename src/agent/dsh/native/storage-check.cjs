'use strict';
const { silentTrace } = require('./utilities.cjs');
const { algorithm, extend, digestEvents } = require('./event-digest.cjs');
const fs = require('node:fs/promises');
const foreign = cause => Object.assign(new Error('Native storage differs from this owner\'s committed events or is unreadable. Execution is fenced; the log was not repaired.'), { code: 'harness-foreign-modified', reason: 'unknown', cause });

async function createNativeStorageChecks({ ctx, load, trace = silentTrace }) {
  const { sessionFormatCatalog: codec } = await load('@deepseek-ai/dsh-session-format-catalog');
  const stats = { checks: 0, fullChecks: 0, admissionChecks: 0, bytes: 0, milliseconds: 0, encodedEvents: 0 };
  const committed = new Map(), pending = new Map(), locations = new Map(), physical = new Map();
  const revision = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs].map(String).join(':');
  async function rememberLocation(nativeId, header) {
    const location = ctx.sessionPersistence.locate(header).path, real = await fs.realpath(location);
    const prior = locations.get(nativeId);
    if (prior && (prior.location !== location || prior.real !== real)) throw foreign(new Error('Native log path changed.'));
    const value = { location, real }; locations.set(nativeId, value); return value;
  }
  async function acknowledge(nativeId, expected) {
    try {
      const file = locations.get(nativeId);
      if (!file || await fs.realpath(file.location) !== file.real) throw Error('Native log path changed.');
      const stat = await fs.stat(file.location, { bigint: true }), prior = physical.get(nativeId);
      if (prior && (prior.dev !== stat.dev || prior.ino !== stat.ino)) throw Error('Native file object changed.');
      // Metadata is a detector only. Expected count/hash/length still derive
      // solely from this live owner's flush-confirmed events, never file bytes.
      physical.set(nativeId, { count: expected.count, prefixHash: expected.prefixHash, dev: stat.dev, ino: stat.ino, revision: revision(stat) });
    } catch (cause) { throw foreign(cause); }
  }
  ctx.on('session/event', (session, event) => {
    const events = pending.get(session.id) || []; events.push(event); pending.set(session.id, events);
  });
  async function ownCheckpoint(nativeId, liveSession) {
    if (committed.has(nativeId)) {
      const started = trace.begin(), previous = committed.get(nativeId);
      const events = (pending.get(nativeId) || []).filter(event => event.seq >= previous.count);
      const next = { ...previous };
      for (const event of events) {
        if (event.seq !== next.count) throw foreign(new Error('Owned native event stream has a gap.'));
        next.prefixHash = extend(next.prefixHash, event);
        next.byteLength += Buffer.byteLength(JSON.stringify(codec.encodeCurrentEvent(event)) + '\n');
        next.count++; stats.encodedEvents++;
      }
      if (liveSession.seq !== next.count) throw foreign(new Error('Owned native event stream is incomplete.'));
      committed.set(nativeId, next); pending.delete(nativeId);
      trace.end('native.own.total', started, { nativeId, incremental: true, events: events.length });
      return { ...next };
    }
    const started = trace.begin(), observeStarted = trace.begin();
    const cut = await ctx.sessionQuery.observeSession(nativeId, { projectionMode: 'none' });
    trace.end('native.own.observe', observeStarted, { nativeId });
    try {
      if (cut.source !== 'live') throw foreign(new Error('An owned checkpoint requires the live writer.'));
      await rememberLocation(nativeId, cut.header);
      // Only the live Agent's own acknowledged events establish trust. The
      // public physical codec computes size without absorbing any disk events.
      const encodeStarted = trace.begin();
      let byteLength = Buffer.byteLength(JSON.stringify(codec.encodeCurrentHeader({ ...cut.header, delegationDepth: cut.header.delegationDepth ?? 0 }, cut.inheritedEventCount)) + '\n');
      for (const event of cut.events) byteLength += Buffer.byteLength(JSON.stringify(codec.encodeCurrentEvent(event)) + '\n');
      stats.encodedEvents += cut.events.length;
      trace.end('native.own.encode', encodeStarted, { nativeId, bytes: byteLength, events: cut.events.length });
      const digestStarted = trace.begin(), prefixHash = digestEvents(cut.events, algorithm);
      trace.end('native.own.digest', digestStarted, { nativeId, events: cut.events.length });
      const next = { count: cut.events.length, prefixHash, byteLength, digestAlgorithm: algorithm };
      committed.set(nativeId, next); pending.set(nativeId, (pending.get(nativeId) || []).filter(event => event.seq >= next.count));
      return { ...next };
    } finally { cut[Symbol.dispose](); trace.end('native.own.total', started, { nativeId }); }
  }
  async function verify(nativeId, expected, { admission = false } = {}) {
    const start = performance.now(); let reader;
    let mode = 'full';
    try {
      if (!expected || !Number.isSafeInteger(expected.byteLength)) throw new Error('No compatible owned physical checkpoint.');
      if (admission && physical.has(nativeId)) {
        try {
          const file = locations.get(nativeId), prior = physical.get(nativeId), phase = trace.begin();
          const real = await fs.realpath(file.location), stat = await fs.stat(file.location, { bigint: true });
          trace.end('native.verify.physical-stat', phase, { nativeId });
          if (real === file.real && stat.size === BigInt(expected.byteLength) && prior.count === expected.count
              && prior.prefixHash === expected.prefixHash && prior.revision === revision(stat)) {
            mode = 'own-length-and-physical-revision'; stats.admissionChecks++; return true;
          }
        } catch { /* Any discrepancy or inaccessible metadata requires full verification. */ }
      }
      // Persistence read bypasses sessionQuery's live-preferred projection.
      // A read handle cannot append, publish migrations, or repair a torn log.
      let phase = trace.begin(); const before = await ctx.sessionPersistence.stat(nativeId); trace.end('native.verify.stat-before', phase, { nativeId });
      if (!before || before.sizeBytes !== expected.byteLength) throw new Error('Native byte length changed.');
      phase = trace.begin(); reader = await ctx.sessionPersistence.open(nativeId, 'read'); trace.end('native.verify.open', phase, { nativeId });
      phase = trace.begin(); const result = await reader.read(); trace.end('native.verify.read', phase, { nativeId, bytes: before.sizeBytes });
      phase = trace.begin(); const after = await ctx.sessionPersistence.stat(nativeId); trace.end('native.verify.stat-after', phase, { nativeId });
      phase = trace.begin(); const prefixHash = digestEvents(result.events, expected.digestAlgorithm); trace.end('native.verify.digest', phase, { nativeId, events: result.events.length });
      if (!after || before.revision !== after.revision || result.events.length !== expected.count || prefixHash !== expected.prefixHash)
        throw new Error('Native event prefix changed.');
      await rememberLocation(nativeId, reader.header); await acknowledge(nativeId, expected);
      stats.bytes += before.sizeBytes;
      stats.fullChecks++;
      return true;
    } catch (cause) { throw foreign(cause); }
    finally { await reader?.close(); stats.checks++; stats.milliseconds += performance.now() - start;
      trace.end('native.verify.total', start, { nativeId, mode }); }
  }
  return { ownCheckpoint, verify, acknowledge, release(nativeId) { committed.delete(nativeId); pending.delete(nativeId); locations.delete(nativeId); physical.delete(nativeId); }, stats: () => ({ ...stats }) };
}
module.exports = { createNativeStorageChecks };
