// Multi-agent discussion: members argue through the durable mailbox until they agree, fall quiet or use up their turns.
// args: {question, members: [{name, role?, harness?, model?, reasoningEffort?}], maxTurns?, summary?}
if (typeof args.question !== 'string' || !args.question.trim()) throw new Error('Provide the question to discuss');
if (!Array.isArray(args.members) || args.members.length < 2) throw new Error('Provide at least two members');

const result = await discuss(args.question, {
  key: 'debate',
  members: args.members,
  maxTurns: args.maxTurns ?? 12,
  summary: args.summary ?? true,
});
if (result.summary && (typeof result.summary.conclusion !== 'string' || !Array.isArray(result.summary.disagreements))) {
  throw new Error('Invalid discussion summary');
}
log('Discussion stopped by ' + result.stop + ' after ' + result.turns + ' turns');
return result;
