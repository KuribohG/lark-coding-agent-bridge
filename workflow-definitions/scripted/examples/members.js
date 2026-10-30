// All members inherit this workflow's configured harness/model unless overridden.
const proposal = await agent('Propose a design for: ' + args.subject + '. Save decisions with checkpoint.', {
  key: 'proposal', member: 'designer',
});
return await parallel([
  async () => {
    await receive('designer', { key: 'feedback' });
    return await agent('Revise your proposal using the review in your inbox.', {
      key: 'revision', member: 'designer',
    });
  },
  async () => {
    const review = await agent('Review this proposal in at most 4000 characters: ' + proposal, {
      key: 'review', member: 'reviewer',
    });
    await send('designer', review, { key: 'deliver-review' });
    return review;
  },
]);
