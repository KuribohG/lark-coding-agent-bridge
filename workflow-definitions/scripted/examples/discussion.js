// args: subject, designerHarness, reviewerHarness, designerModel?, reviewerModel?,
// reviewId (stable across replay), waitForStart? (pause at B's inbox for an external message).
const designer = { member: 'A', harness: args.designerHarness, model: args.designerModel };
const reviewer = { member: 'B', harness: args.reviewerHarness, model: args.reviewerModel };
const reviewId = args.reviewId;
if (typeof args.subject !== 'string' || typeof reviewId !== 'string') {
  throw new Error('Provide subject and a stable reviewId');
}

phase('A proposes; B joins the discussion');
const proposal = await agent(
  `Propose a concise design for: ${args.subject}. Do not use tools. Return JSON with version: 1 and proposal (string).`,
  { ...designer, key: 'proposal', output: 'json' },
);
if (proposal.version !== 1 || typeof proposal.proposal !== 'string') {
  throw new Error('Invalid proposal');
}
await agent('You are the reviewer. A proposal will follow. Do not use tools. Reply exactly READY.', {
  ...reviewer, key: 'reviewer-ready',
});

phase('B reviews; A waits for feedback');
const [revised, review] = await parallel([
  async () => {
    await receive('A', { key: 'review-inbox' });
    const revision = await agent(
      'Revise your earlier design using the review in your inbox. Do not use tools. Return JSON with version: 2, '
        + 'review_id (copy from the review), proposal (string), and addressed (explain how you addressed required_change).',
      { ...designer, key: 'revision', output: 'json' },
    );
    if (revision.version !== 2 || revision.review_id !== reviewId
      || typeof revision.proposal !== 'string' || typeof revision.addressed !== 'string' || !revision.addressed) {
      throw new Error('Revision did not address the expected review');
    }
    return revision;
  },
  async () => {
    if (args.waitForStart) await receive('B', { key: 'start-review' });
    const feedback = await agent(
      `Review this proposal for: ${args.subject}. Require one concrete improvement. Do not use tools. `
        + `Return JSON in at most 2000 characters with critique (string), required_change (string), review_id: ${JSON.stringify(reviewId)}. `
        + `Proposal: ${JSON.stringify(proposal)}`,
      { ...reviewer, key: 'review', output: 'json' },
    );
    if (feedback.review_id !== reviewId || typeof feedback.critique !== 'string'
      || typeof feedback.required_change !== 'string' || !feedback.required_change) {
      throw new Error('Invalid review');
    }
    await send('A', JSON.stringify(feedback), { key: 'deliver-review' });
    return feedback;
  },
]);
return { proposal, review, revised };
