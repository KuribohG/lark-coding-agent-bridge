// args: items [{key,title,input,resources?,maxAttempts?}], members [{name,harness?,model?}],
// and consumerPrompt (instructions for handling the work, within the original goal).
if (!Array.isArray(args.items) || !Array.isArray(args.members) || !args.members.length
  || typeof args.consumerPrompt !== 'string') throw new Error('Provide items, members, and consumerPrompt');
for (const item of args.items) await enqueueWork(item);

let members = args.members;
for (let round = 0; round < 8; round++) {
  phase(`Queue consumption round ${round + 1}`);
  const outcomes = await parallel(members.map(member => async () => {
    try {
      const answer = await agent(
        args.consumerPrompt + '\nUse claim_work to pick work. Read item.progress before acting, save work progress, '
          + 'renew the lease before it expires, then complete_work or fail_work. Continue with a new operationId for '
          + 'each claim until claim_work returns null; then finish this turn. Do not poll or sleep waiting for work. '
          + 'Honor the declared resource/worktree ownership. Only the original authorized task may be performed.',
        { key: `consumer-${member.name}-${round}`, member: member.name, harness: member.harness, model: member.model },
      );
      return { member, answer, ok: true };
    } catch (error) {
      return { member, error: String(error), ok: false };
    }
  }));
  const status = await workStatus();
  if (status.failed) throw new Error(`${status.failed} work items failed; inspect /workflow work before retrying`);
  if (status.pending === 0 && status.claimed === 0) return { status, outcomes };
  // A failed member's original turn can be retried only by explicit workflow replay.
  // Successful members can take a fresh turn and adopt released work immediately.
  members = outcomes.filter(outcome => outcome.ok).map(outcome => outcome.member);
  if (!members.length) throw new Error('No consumers remain; explicitly replay after resolving the failures');
}
throw new Error('Queue round limit reached with unfinished work');
