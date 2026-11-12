// args: items [{key,title,input,resources?,maxAttempts?}], members [{name,harness?,model?,reasoningEffort?}],
// consumerPrompt, and optional keepOpen (main must close_work_queue after adding work) and maxTurns.
for (const item of args.items) await enqueueWork(item);
if (!args.keepOpen) await closeWorkQueue({key:'queue-closed'});
return await swarm(args.consumerPrompt, {
  key:'consumers',members:args.members.map(member => ({...member, queue:'default'})),
  maxTurns:args.maxTurns === undefined ? 24 : args.maxTurns,
});
