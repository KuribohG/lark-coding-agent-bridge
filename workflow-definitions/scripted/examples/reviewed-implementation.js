// args: task, criteria, implementer {harness,model,reasoningEffort}, verifier {harness,model,reasoningEffort}.
// Include concrete test commands and artifact requirements in criteria.
return await reviewedAgent(args.task, {
  key: 'implementation', criteria: args.criteria,
  worker: args.implementer, reviewer: args.verifier, maxRounds: 2,
});
