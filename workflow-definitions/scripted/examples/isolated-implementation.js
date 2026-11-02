// args.changes: [{task, criteria}], args.implementer / args.verifier: explicit
// {harness, model, reasoningEffort}; args.checks: [{argv, timeoutMs?}].
const results = await parallel(args.changes.map((change, index) => async () => {
  const key = 'change-' + index;
  const workspace = await createWorkspace({key: key + '/workspace'});
  return await reviewedAgent(change.task, {
    key, criteria: change.criteria, maxRounds: 2,
    worker: {...args.implementer, workspace: workspace.id},
    reviewer: args.verifier,
  });
}));
const integration = await integrateChanges({
  key: 'integration', approvals: results.map(result => result.approval.id),
});
// The supervisor can arrange a bounded repair/review round in this workspace,
// then integrate the repair approval followed by integration.remaining.
if (integration.status === 'conflict') return integration;
const checks = await checkWorkspace({
  key: 'checks', workspace: integration.workspace.id, commands: args.checks,
});
if (!checks.passed) return {status: 'checks_failed', integration, checks};
return await acceptIntegration({
  key: 'accept', workspace: integration.workspace.id, checks: checks.id,
});
