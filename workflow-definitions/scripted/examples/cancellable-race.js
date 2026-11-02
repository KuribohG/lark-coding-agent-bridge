// args: approaches [{key,prompt,harness?,model?,reasoningEffort?}], timeoutMs.
if (!Array.isArray(args.approaches) || !args.approaches.length || args.approaches.length > 15) throw new Error('Provide 1–15 approaches plus a timeout');
const tasks = await parallel(args.approaches.map(({prompt,...options}) => () => startAgent(prompt,options)));
const choice = await waitFor({key:'result-or-timeout',any:[
  ...tasks.map(task=>({kind:'task',taskId:task.taskId})),
  {kind:'timer',afterMs:args.timeoutMs},
]});
await parallel(tasks.map((task,index)=>async()=>{
  if (choice.kind === 'timer' || index !== choice.index) await cancelTask(task,{key:'cancel/'+index});
}));
if (choice.kind === 'timer') return {timedOut:true};
return {timedOut:false,index:choice.index,result:await joinTask(tasks[choice.index])};
