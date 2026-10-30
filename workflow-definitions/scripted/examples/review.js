// Pass { subject, piModel, claudeModel, codexModel } as args with configured model IDs.
phase('Independent proposals');
const proposals = await parallel([
  () => agent(`Propose a design for: ${args.subject}`, { key: 'proposal-pi', harness: 'pi', model: args.piModel }),
  () => agent(`Propose a design for: ${args.subject}`, { key: 'proposal-claude', harness: 'claude', model: args.claudeModel }),
]);
phase('Review');
const review = await agent(
  `Review these proposals. Return JSON with needsRevision (boolean) and rationale (string): ${JSON.stringify(proposals)}`,
  { key: 'review', harness: 'codex', model: args.codexModel, output: 'json' },
);
if (typeof review.needsRevision !== 'boolean' || typeof review.rationale !== 'string') {
  throw new Error('Review did not match the requested schema');
}
if (review.needsRevision) {
  phase('Revision');
  const revised = await agent(
    `Revise these proposals using the review: ${JSON.stringify({ proposals, review })}`,
    { key: 'revision', harness: 'pi', model: args.piModel },
  );
  return { proposals, review, revised };
}
return { proposals, review };
