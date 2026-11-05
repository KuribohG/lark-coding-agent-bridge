// Pass { subject, piModel, claudeModel, codexModel } as args with configured model IDs.
phase('Independent proposals');
// A failed worker resolves to null; continue with the proposals that succeeded.
const proposals = (await parallel([
  () => agent(`Propose a design for: ${args.subject}`, { key: 'proposal-pi', harness: 'pi', model: args.piModel }),
  () => agent(`Propose a design for: ${args.subject}`, { key: 'proposal-claude', harness: 'claude', model: args.claudeModel }),
])).filter(Boolean);
if (!proposals.length) throw new Error('No proposal succeeded');
phase('Review');
// The schema is validated by the bridge; a non-conforming answer is restated in the same session before failing.
const review = await agent(`Review these proposals: ${JSON.stringify(proposals)}`, {
  key: 'review', harness: 'codex', model: args.codexModel, onError: 'throw',
  schema: {
    type: 'object',
    properties: { needsRevision: { type: 'boolean' }, rationale: { type: 'string', minLength: 1 } },
    required: ['needsRevision', 'rationale'],
  },
});
if (review.needsRevision) {
  phase('Revision');
  const revised = await agent(
    `Revise these proposals using the review: ${JSON.stringify({ proposals, review })}`,
    { key: 'revision', harness: 'pi', model: args.piModel },
  );
  return { proposals, review, revised };
}
return { proposals, review };
