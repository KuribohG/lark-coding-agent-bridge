// args: items [{key,title,input,resources?}], developers/reviewers [{name,harness?,model?,reasoningEffort?}].
for (const item of args.items) {
  const created = await enqueueWork({...item, queue:'implementation'});
  await enqueueWork({key:'review/'+item.key, title:'Verify '+item.title, queue:'review',
    dependsOn:[item.key], input:{implementationItemId:created.itemId}});
}
await closeWorkQueue({key:'implementation-closed',queue:'implementation'});
await closeWorkQueue({key:'review-closed',queue:'review'});
// One swarm, two kinds of members: each consumes its own queue and can still be named on the board.
return await swarm('Implement the queued changes and verify each one independently.', {key:'delivery', maxTurns:24, members:[
  ...args.developers.map(member => ({...member, queue:'implementation',
    role:'Implement the authorized change and test it. Save work progress and complete with evidence and artifact paths.'})),
  ...args.reviewers.map(member => ({...member, queue:'review',
    role:'Read the implementationItemId with work_status. Independently verify the implementation and report evidence and unresolved issues.'})),
]});
