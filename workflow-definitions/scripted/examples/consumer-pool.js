// args: items [{key,title,input,resources?,maxAttempts?}], members [{name,harness?,model?,reasoningEffort?}],
// consumerPrompt, and optional keepOpen (main must close_work_queue after adding work).
for (const item of args.items) await enqueueWork(item);
if (!args.keepOpen) await closeWorkQueue({key:'queue-closed'});
return await consumeWork({
  key:'consumers',members:args.members,prompt:args.consumerPrompt,
  ...(args.maxTurns === undefined ? {} : {maxTurns:args.maxTurns}),
});
