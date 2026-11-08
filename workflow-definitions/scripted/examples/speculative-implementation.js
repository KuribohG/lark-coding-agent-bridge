// args: task, gate (the slow check of the premise, e.g. a full model-checking run), repair (how to fix a rejected premise),
// implementer {harness,model,reasoningEffort}, checker {harness,model,reasoningEffort}.
// Run the quick checks first; speculate only past the slow one.
return await speculativeAgent(args.task, {
  key: 'implementation',
  gate: { prompt: args.gate, ...args.checker },
  worker: args.implementer,
  repair: { prompt: args.repair, member: 'premise/author' },
  maxRounds: 3,
});
