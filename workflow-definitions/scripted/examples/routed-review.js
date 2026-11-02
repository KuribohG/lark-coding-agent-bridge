// args: items [{key,title,input,resources?}], developers/reviewers [{name,harness?,model?,reasoningEffort?}].
for (const item of args.items) {
  const created = await enqueueWork({...item, queue:'implementation'});
  await enqueueWork({key:'review/'+item.key, title:'Verify '+item.title, queue:'review',
    dependsOn:[item.key], input:{implementationItemId:created.itemId}});
}
await closeWorkQueue({key:'implementation-closed',queue:'implementation'});
await closeWorkQueue({key:'review-closed',queue:'review'});
return await parallel([
  () => consumeWork({key:'developers',queue:'implementation',members:args.developers,maxConcurrent:2,
    prompt:'Implement the authorized change and test it. Save work progress and complete with evidence and artifact paths.'}),
  () => consumeWork({key:'reviewers',queue:'review',members:args.reviewers,maxConcurrent:1,
    prompt:'Read the implementationItemId with work_status. Independently verify the implementation and report evidence and unresolved issues.'}),
]);
