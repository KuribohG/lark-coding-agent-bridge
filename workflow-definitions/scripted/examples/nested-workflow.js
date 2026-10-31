// args.task is the original authorized task. The coordinator may write a complete
// child workflow and enable workflowTool independently for each of its workers.
const result = await agent(args.task, {
  key: 'coordinator', member: 'coordinator', workflowTool: true,
});
return await agent('Review this result against the original task.\n'
  + JSON.stringify({task: args.task, result}), {
  key: 'final-review', workflowTool: false,
});
