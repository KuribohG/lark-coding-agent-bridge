'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { canonicalJson, silentTrace } = require('./utilities.cjs');
const { createAgentSession } = require('./session.cjs');
const { bootProfile, bootReader, profileIdentity, canonicalRoot, lock, ADAPTER_PROTOCOL } = require('./profile.cjs');
const { createNativeStorageChecks } = require('./storage-check.cjs');
const { auditOwnedEvents, observeOwnedRecovery } = require('./recovery.cjs');
const { digestEvents } = require('./event-digest.cjs');
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

const publicText = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const usageOf = usage => ({ promptTokens: usage?.inputTokens || 0, completionTokens: usage?.outputTokens || 0,
  totalTokens: usage?.totalTokens ?? ((usage?.inputTokens || 0) + (usage?.outputTokens || 0)), cacheHitTokens: usage?.cacheReadTokens || 0 });

function createDshHarness(options) {
  const trace = options.ports?.trace || silentTrace;
  const scrubText = options.ports?.redact || (value => String(value));
  const sessions = new Set(), running = new Map(), handles = new Map();
  let profilePromise, readerPromise, closed = false;
  let verifiedManifest;
  const clean = error => Object.assign(new Error(scrubText(error?.message || String(error), options.apiKey)), { code: error?.code, reason: error?.reason });
  async function profile() {
    if (closed) throw Object.assign(new Error('DSH Harness is closed.'), { code: 'harness-closed' });
    if (!profilePromise) {
      const attempt = (options.bootProfile || bootProfile)(options).then(runtime => {
      const { ctx } = runtime;
      verifiedManifest = runtime.manifest;
      ctx.on('agent/request', async ({ agent }, next) => { running.get(agent.id)?.publish('activity', { phase: 'model-start' }); return next(); });
      ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        const turn = running.get(agent.id);
        if (turn && frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
          if (!turn.characters) trace.mark('native.first-delta', { turnId: turn.turnId });
          const text = scrubText(frame.chunk.text, options.apiKey);
          turn.characters += text.length;
          turn.publish('output-delta', { text });
          turn.publish('activity', { phase: 'progress', activity: { phase: 'responding', characters: turn.characters } });
        }
      });
      ctx.on('agent/error', ({ agent, error }) => { const turn = running.get(agent.id); if (turn) { turn.error = clean(error); turn.end?.(); } });
      ctx.on('session/event', (session, event) => {
        const turn = running.get(session.id);
        if (!turn) return;
        if (event.type === 'assistant/message') {
          const usage = usageOf(event.data.usage), content = publicText(event.data.message);
          for (const key of Object.keys(turn.usage)) turn.usage[key] += usage[key];
          turn.content = content;
          turn.publish('activity', { phase: 'model-result', reply: { content, usage, finishReason: event.data.interrupted ? 'length' : 'stop' } });
        }
        if (event.type === 'turn/end') {
          trace.mark('native.turn-end', { turnId: turn.turnId });
          const reason = event.data.reason;
          turn.reason = reason; turn.end?.();
        }
      });
      return runtime;
      });
      profilePromise = attempt;
      attempt.catch(() => { if (profilePromise === attempt) profilePromise = null; });
    }
    return profilePromise;
  }
  async function observation(nativeId, previous) {
    const { ctx } = await profile();
    const cut = await ctx.sessionQuery.observeSession(nativeId, { projectionMode: 'none' });
    try {
      const suffix = previous ? cut.events.slice(previous.count) : [];
      return { count: cut.events.length, prefixHash: digestEvents(cut.events, previous?.digestAlgorithm), lastType: cut.events.at(-1)?.type || null,
        ...(previous ? { originalPrefixHash: digestEvents(cut.events.slice(0, previous.count), previous.digestAlgorithm), recoveryOnly: suffix.length === 0
          || suffix.length === 1 && suffix[0].type === 'session/end-seed' && Object.keys(suffix[0].data).length === 0 } : {}) };
    }
    finally { cut[Symbol.dispose](); }
  }
  async function readContext() {
    if (closed) throw Object.assign(new Error('DSH Harness is closed.'), { code: 'harness-closed' });
    if (profilePromise) { const active = await profilePromise.catch(() => null); if (active) return active; }
    if (!readerPromise) { const attempt = bootReader(options); readerPromise = attempt; attempt.catch(() => { if (readerPromise === attempt) readerPromise = null; }); }
    return readerPromise;
  }
  function allocate({ scope, model, effort, instructions, tools = [] }) {
    return { harness: 'dsh', version: lock.dshVersion, adapterProtocol: ADAPTER_PROTOCOL, model, effort, nativeSessionId: randomUUID(), scope, materialized: false,
      namespace: canonicalRoot(options.home), workspace: canonicalRoot(options.workspace), profileId: profileIdentity(options),
      configurationHash: digest({ model, effort, instructions, tools: tools.map(tool => tool.definition) }) };
  }
  async function openNative({ scope, model, effort, instructions, tools = [], signal, creationHandle }, persisted, attempt) {
    if (persisted && (persisted.version !== lock.dshVersion || persisted.adapterProtocol !== ADAPTER_PROTOCOL))
      throw Object.assign(new Error('Native handle protocol is incompatible. Explicitly migrate or replace this Agent; the original Session was preserved.'), { code: 'harness-incompatible' });
    if (!options.models.some(item => item.id === model) || Array.isArray(options.availableModels) && !options.availableModels.includes(model))
      throw Object.assign(new Error(`Model ${model} is unavailable. Select an available model and explicitly replace this Agent.`), { code: 'harness-model-unavailable' });
    const runtime = await profile(), { ctx } = runtime;
    const verifyRoot = () => {
      if (canonicalRoot(options.home) !== runtime.lease.root) throw Object.assign(new Error('Native root alias changed after ownership was acquired.'), { code: 'harness-foreign-modified', reason: 'unknown' });
    };
    verifyRoot();
    runtime.storageChecks ||= await createNativeStorageChecks({ ...runtime, trace });
    const checks = runtime.storageChecks;
    signal?.throwIfAborted();
    const identity = persisted || creationHandle || allocate({ scope, model, effort, instructions, tools });
    const nativeId = identity.nativeSessionId;
    if (!/^[0-9a-f-]{36}$/.test(nativeId)) throw Object.assign(new Error('Invalid native identity in mapping.'), { code: 'harness-handle-scope' });
    const sameOwner = identity.scope && ['sessionId', 'taskId', 'agentId', 'conversationId', 'generation'].every(key => identity.scope[key] === scope[key]);
    if (identity.harness !== 'dsh' || identity.version !== lock.dshVersion || !sameOwner
        || identity.namespace !== runtime.lease.root || identity.workspace !== canonicalRoot(options.workspace) || identity.profileId !== runtime.profileId
        || persisted && (!persisted.materialized || !persisted.highWater)
        || identity.configurationHash !== digest({ model, effort, instructions, tools: tools.map(tool => tool.definition) }))
      throw Object.assign(new Error('Native DSH handle belongs to another scope or runtime.'), { code: 'harness-handle-scope' });
    const allowed = new Set(tools.map(tool => tool.definition.function.name));
    let reconciled = false, checkpoint, foreignModified = false;
    if (persisted) await checks.verify(nativeId, persisted.recoveryPermit?.observation || persisted.highWater); // before resume can append native recovery markers
    const inFlight = new Set();
    if (effort && effort !== 'auto') {
      const declared = options.models.find(item => item.id === model)?.reasoningEfforts;
      if (declared === false || !declared || !Object.hasOwn(declared, effort))
        throw Object.assign(new Error(`DSH model ${model} does not advertise effort ${effort}.`), { code: 'harness-effort-unsupported' });
    }
    const nativeOptions = { signal, agentOptions: { provider: 'warp-assistant-gateway', model,
      ...(effort && effort !== 'auto' ? { reasoningEffort: effort } : {}) },
      async setup(agentCtx, agent) {
        // Installed before publication: a reconstructed persistent inbox must
        // never drive a request while ownership and the native prefix are checked.
        agentCtx.on('agent/pre-step', async ({ messages }, next) => {
          const turn = running.get(nativeId);
          trace.mark('native.pre-step', { turnId: turn?.turnId });
          if (!reconciled || !turn || turn.signal.aborted || messages.some(message => message.id !== turn.turnId)) return { kind: 'reject' };
          return next();
        });
        agentCtx.tools.restrict({ allow: [] });
        agentCtx.tools.guard(exec => { const turn = running.get(nativeId); return foreignModified || !reconciled || !allowed.has(exec.name)
          || !turn || turn.signal.aborted || turn.invocation && !turn.invocation.allowedTools.includes(exec.name) ? 'Tool is outside this turn authority.' : undefined; });
        agentCtx.systemPrompt.section({ name: 'warp-assistant-agent', order: 0, text: instructions || '', complete: true, interpolate: false });
        for (const tool of tools) agentCtx.tools.register({ ...tool.definition.function,
          output: { schema: {}, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
          async execute(args, exec) {
            const turn = running.get(nativeId);
            if (!turn || turn.signal.aborted) throw new Error('Agent capability was revoked.');
            const call = { id: exec.callId, function: { name: exec.name, arguments: JSON.stringify(args) } };
            turn.publish('tool-request', { call });
            const work = Promise.resolve().then(async () => {
              await turn.invocation?.validateLease?.(exec.name);
              if (running.get(nativeId) !== turn || turn.signal.aborted || !allowed.has(exec.name)
                  || turn.invocation && !turn.invocation.allowedTools.includes(exec.name)) throw new Error('Agent capability was revoked.');
              return tool.execute(args, { signal: turn.signal, call, invocation: turn.invocation, nativeSessionId: nativeId,
                finish(value) { turn.finished = value; exec.concludeTurn(); } });
            });
            inFlight.add(work);
            try { const result = await work; turn.signal.throwIfAborted(); turn.publish('tool-result', { call, result }); return result; }
            finally { inFlight.delete(work); }
          },
        });
        if (persisted) {
          if (persisted.recoveryPermit) {
            if (canonicalJson(persisted.recoveryPermit.scope) !== canonicalJson(scope)) throw Object.assign(new Error('Recovery permit belongs to another scope.'), { code: 'harness-handle-scope' });
            auditOwnedEvents(agent.session.snapshotEvents(0), persisted.highWater, persisted.recoveryPermit.turnIds);
            for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) if (!persisted.recoveryPermit.turnIds.includes(message.id))
              throw Object.assign(new Error('Recovery inbox contains foreign pending input.'), { code: 'harness-foreign-modified' });
            agent.inbox.clear(); // public API records cancellation; no old input is replayed
          } else {
            checkpoint = await observation(nativeId, persisted.highWater);
            if (checkpoint.count < persisted.highWater.count || checkpoint.originalPrefixHash !== persisted.highWater.prefixHash || !checkpoint.recoveryOnly)
              throw Object.assign(new Error(`Native history changed outside the recorded collaboration checkpoint (${persisted.highWater.count}/${persisted.highWater.lastType} -> ${checkpoint.count}/${checkpoint.lastType}); execution is fenced.`), { code: 'harness-foreign-modified' });
            if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length)
              throw Object.assign(new Error('Native pending inbox is not reconciled with a completed core delivery.'), { code: 'harness-foreign-modified' });
          }
        }
      },
    };
    attempt.mayExist = true; // An exception from create/resume cannot prove absence.
    const handle = persisted ? await ctx.agents.resume({ ...nativeOptions, resumeSessionId: nativeId })
      : await ctx.agents.create({ ...nativeOptions, sessionId: nativeId, meta: { cwd: identity.workspace } });
    handles.set(nativeId, handle);
    try {
      await ctx.sessions.flush(handle.agent.session);
      checkpoint = await checks.ownCheckpoint(nativeId, handle.agent.session); await checks.verify(nativeId, checkpoint); reconciled = true;
    } catch (error) {
      await handle.dispose(); handles.delete(nativeId); checks.release(nativeId); throw error;
    }
    let session;
    const { recoveryPermit: _permit, ...stableIdentity } = identity;
    session = createAgentSession({ scope,
      handle: () => ({ ...stableIdentity, namespace: runtime.lease.root, scope, materialized: true, highWater: checkpoint }),
      stopTimeoutMs: options.stopTimeoutMs || 5000,
      execute: async ({ input, signal, publish, turnId, invocation }) => {
        if (handle.agent.status !== 'idle') throw Object.assign(new Error('Native DSH Agent is busy.'), { code: 'harness-busy' });
        let cancel;
        try {
          let turn;
          const ended = new Promise(resolve => {
            turn = { end: resolve, turnId, invocation, publish, signal, content: '', characters: 0,
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0 } };
            running.set(nativeId, turn);
            cancel = () => { handle.agent.cancel({ kind: 'user' }); resolve(); };
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) { cancel(); return; }
            trace.mark('native.followup', { turnId });
            handle.agent.followup({ id: turnId, role: 'user', source: { kind: 'user' },
              content: [{ type: 'text', text: JSON.stringify({ authority: invocation?.authority?.kind || 'user',
                text: input.text ?? (input.messages || []).filter(message => message.role !== 'system').map(message => message.content).join('\n'),
                attachments: input.attachments || [], ...(input.userPreferences ? { userPreferences: input.userPreferences } : {}), ...(input.command ? { command: input.command } : {}) }) }] });
          });
          await ended;
          await handle.agent.whenIdle();
          trace.mark('native.idle', { turnId });
          await Promise.allSettled([...inFlight]);
          const flushStarted = trace.begin();
          await ctx.sessions.flush(handle.agent.session);
          trace.end('native.explicit-flush', flushStarted, { turnId });
          const committed = await checks.ownCheckpoint(nativeId, handle.agent.session); await checks.acknowledge(nativeId, committed); checkpoint = committed;
          if (turn.error) throw turn.error;
          if (turn.reason?.kind === 'error') throw clean(turn.reason.error);
          if (turn.reason?.kind === 'blocked') throw Object.assign(new Error('Native pre-step admission was blocked.'), { code: 'harness-blocked' });
          signal.throwIfAborted();
          return { content: turn.finished?.content ?? turn.content, usage: turn.usage, toolCalls: [],
            finishReason: turn.reason?.kind === 'max-tokens' ? 'length' : 'stop', nativeSessionId: nativeId };
        } catch (error) { if (error.code === 'harness-foreign-modified') { foreignModified = true; reconciled = false; } throw error; }
        finally { signal.removeEventListener('abort', cancel); running.delete(nativeId); }
      },
      async dispose() {
        handles.delete(nativeId);
        let failure;
        try { verifyRoot(); await handle.agent.whenIdle(); await Promise.allSettled([...inFlight]); await ctx.sessions.flush(handle.agent.session);
          const committed = await checks.ownCheckpoint(nativeId, handle.agent.session); await checks.verify(nativeId, committed); checkpoint = committed; }
        catch (error) { failure = error; }
        await handle.dispose(); sessions.delete(session); checks.release(nativeId);
        if (failure) { failure.resourceReleased = true; throw failure; }
      },
    });
    const submit = session.submit;
    session.submit = async request => {
      if (foreignModified) throw Object.assign(new Error('Native Agent is foreign-modified.'), { code: 'harness-foreign-modified' });
      if (session.state() !== 'idle') throw Object.assign(new Error('Native Agent is not idle.'), { code: 'harness-busy' });
      try { verifyRoot(); await checks.verify(nativeId, checkpoint, { admission: true }); }
      catch (error) { foreignModified = true; reconciled = false; throw error; }
      trace.mark('native.admission-verified', { turnId: request.turnId });
      return submit(request);
    };
    session.storageChecks = checks.stats;
    session.inspectTools = () => tools.map(tool => ({ name: tool.definition.function.name,
      registered: Boolean(handle.agent.ctx.tools.get(tool.definition.function.name)) }));
    sessions.add(session); return session;
  }
  async function open(settings, persisted) {
    const attempt = { mayExist: persisted?.materialized === true };
    try { return await openNative(settings, persisted, attempt); }
    catch (error) { error.nativeSessionMayExist = attempt.mayExist; throw error; }
  }
  return {
    workflowRoot: () => ({ cwdRealpath: canonicalRoot(options.workspace) }),
    describe: () => ({ id: 'dsh', version: lock.dshVersion, nodeVersion: lock.nodeVersion, streaming: true, cancellation: 'quiescence',
      resume: true, isolation: true, concurrency: true, tools: { registeredOnly: true, builtin: false },
      profile: verifiedManifest || { profileId: profileIdentity(options), verified: false }, readonlyNativeWeb: 'unsupported', hardStop: 'host-lifecycle-required',
      writerExclusion: { applicationOwners: 'physical-root-lock', canonicalNativeSameLogon: 'native-session-lock',
        rawNativeAliasesOrOtherLogons: 'detect-and-fence', checkpointSource: 'own-live-events', detectionBoundary: 'native-admission-and-release',
        detection: { admission: 'own-length-and-physical-revision/full-on-change', postTurn: 'own-ack-chain', release: 'full-prefix', resume: 'full-prefix-and-owned-suffix',
          limitation: 'Nonmalicious append misuse. A same-length rewrite preserving revision, or coinciding with flush/revision recording, is detected at full release or resume.' },
        deploymentScope: { supported: ['windows-same-logon-local-fixed-ntfs'], unverified: ['cross-logon', 'subst', 'network-mapped-drive', 'UNC', 'ReFS', 'POSIX'] } },
      models: options.models.map(model => ({ id: model.id, effort: model.reasoningEfforts === false ? [] : Object.keys(model.reasoningEfforts || {}),
        defaultEffort: model.reasoningEfforts === false ? null : options.defaultEffort || model.defaultEffort || 'off' })) }),
    allocate, open,
    warmup: async () => { const runtime = await profile(); return { ready: true, profile: runtime.manifest, nativeAgentsCreated: 0 }; },
    resume: (handle, settings) => open(settings, handle),
    async reconcile(identity, { scope, turnIds }) {
      if (identity.harness !== 'dsh' || identity.version !== lock.dshVersion || identity.adapterProtocol !== ADAPTER_PROTOCOL) throw Object.assign(new Error('Native recovery protocol is incompatible; replace this Agent.'), { code: 'harness-incompatible' });
      if (identity.namespace !== canonicalRoot(options.home) || identity.workspace !== canonicalRoot(options.workspace) || canonicalJson(identity.scope) !== canonicalJson(scope))
        throw Object.assign(new Error('Native recovery mapping belongs to another scope.'), { code: 'harness-handle-scope' });
      const { ctx } = await readContext();
      const permit = await observeOwnedRecovery({ ctx, nativeSessionId: identity.nativeSessionId, highWater: identity.highWater,
        scope, turnIds, workspace: identity.workspace });
      return { handle: { ...identity, recoveryPermit: permit }, observation: permit.observation, nativeResumePending: true };
    },
    inspect: async identity => {
      const { ctx } = await readContext(), reader = await ctx.sessionPersistence.open(identity.nativeSessionId, 'read');
      try { const read = await reader.read(), stat = await ctx.sessionPersistence.stat(identity.nativeSessionId);
        return { nativeSessionId: identity.nativeSessionId, observation: { count: read.events.length, prefixHash: digestEvents(read.events, identity.highWater?.digestAlgorithm),
          digestAlgorithm: identity.highWater?.digestAlgorithm, byteLength: stat?.sizeBytes },
          location: ctx.sessionPersistence.locate(reader.header), workspace: reader.header.cwd, readOnly: true }; }
      finally { await reader.close(); }
    },
    async publicHistory(nativeSessionId) {
      const { ctx, load } = await readContext();
      const observation = await ctx.sessionQuery.observeSession(nativeSessionId, { projectionMode: 'none' });
      try {
        const { Session } = await load('@deepseek-ai/dsh-session');
        const snapshot = Session.create(nativeSessionId, observation.events, observation.header, observation.inheritedEventCount);
        return snapshot.deriveMessages().filter(message => ['user', 'assistant'].includes(message.role)).map(message => ({
          id: message.id, role: message.role, content: publicText(message), source: message.source?.kind || 'harness',
        }));
      } finally { observation[Symbol.dispose](); }
    },
    async close() {
      if (closed) return;
      const results = await Promise.allSettled([...sessions].map(session => session.close()));
      if (results.some(result => result.status === 'fulfilled' && result.value?.state === 'unknown')) return { state: 'unknown', hardStop: 'host-lifecycle-required' };
      closed = true;
      results.push(...await Promise.allSettled([profilePromise, readerPromise].filter(Boolean).map(async pending => (await pending.catch(() => null))?.close())));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Native sessions were closed with recorded storage errors.');
    },
  };
}
module.exports = { createDshHarness, publicText, usageOf };
