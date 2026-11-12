// Members each claim one item, fix it in their own worktree and land it themselves.
// args: { items: [{key, title, input}], members?: number, checks: [{argv, timeoutMs?}], strict?: boolean, prompt?: string, model?: string }
const count = Math.min(args.members ?? 8, args.items.length);
const landing = await configureLanding({ key: 'landing', checks: args.checks, strict: args.strict ?? true });
const workspaces = await parallel(Array.from({ length: count }, (_, index) => () => createWorkspace({ key: `worktree-${index}` })));
if (workspaces.some(workspace => !workspace)) throw new Error('Could not create every worktree');

const fixing = swarm(args.prompt ?? 'Claim one work item at a time. Fix it in your worktree, commit, then call submit_work with the claim. '
  + 'If the landing is rejected, repair your worktree and submit again; release the claim if you cannot fix it. '
  + 'Rebase onto the landing branch before you claim the next item.', {
  key: 'fixers', maxTurns: 16,
  members: workspaces.map((workspace, index) => ({ name: `fixer-${index}`, queue: 'default', workspace: workspace.id, ...(args.model ? { model: args.model } : {}) })),
});
for (const item of args.items) await enqueueWork({ key: item.key, title: item.title, input: item.input ?? null });
await closeWorkQueue({ key: 'all-enqueued' });
const result = await fixing;
return { branch: landing.targetRef.replace('refs/heads/', ''), stop: result?.stop, queues: result?.queues };
