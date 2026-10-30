// Pass { subject: "..." } as args. Configure each selected harness beforehand.
phase('Independent proposals');
const proposals = await parallel([
  () => agent(`Propose a design for: ${args.subject}`, { key: 'proposal-pi', harness: 'pi' }),
  () => agent(`Propose a design for: ${args.subject}`, { key: 'proposal-claude', harness: 'claude' }),
]);
phase('Review');
const review = await agent(
  `Review these proposals. Return JSON with needsRevision (boolean) and rationale (string): ${JSON.stringify(proposals)}`,
  { key: 'review', harness: 'codex', output: 'json' },
);
if (typeof review.needsRevision !== 'boolean' || typeof review.rationale !== 'string') {
  throw new Error('Review did not match the requested schema');
}
if (review.needsRevision) {
  phase('Revision');
  const revised = await agent(
    `Revise these proposals using the review: ${JSON.stringify({ proposals, review })}`,
    { key: 'revision', harness: 'pi' },
  );
  return { proposals, review, revised };
}
return { proposals, review };
