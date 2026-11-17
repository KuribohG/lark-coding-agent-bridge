import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkflowRuntime, callWorkflow, type WorkerRunSpec, type WorkflowRoot } from '../src';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
it.each([
 {hostTools:true,producer:'dsh',reviewer:'agy'},
 {hostTools:false,producer:'agy',reviewer:'dsh'},
] as const)('hands complete input to $reviewer after $producer with workflow hostTools=$hostTools, using the actual worker prompt and authority',async config=>{
 const root:WorkflowRoot={scopeId:'mixed',profile:'test',agentKind:config.producer,cwdRealpath:'/repo',policyFingerprint:'policy',catalogBinding:'root',modelSettings:{model:'fixture'}};
 const text='evidence line 世界 '.repeat(1500)+'TAIL-ONLY-7f481';
 const specs:WorkerRunSpec[]=[];
 let read:any,cliEnv:Record<string,string>={};
 const workerTools=vi.fn((execution:{agentKind:string})=>execution.agentKind==='dsh'?'host' as const:'cli' as const);
 const runtime=new WorkflowRuntime({path:':memory:',hostTools:config.hostTools,workerTools,
  resolveRoot:async()=>root,resolveWorker:async(current,selection)=>({agentKind:selection.agentKind,profile:current.profile,modelSettings:{model:'fixture'},configurationFingerprint:selection.agentKind,policyFingerprint:'policy'}),wakeMain:async()=>{},
  runner:{async start(spec){await spec.validateBeforeRun();specs.push(spec);
   const reviewer=specs.length===2,hostTools=spec.execution.agentKind==='dsh';
   expect(spec.execution.agentKind).toBe(reviewer?config.reviewer:config.producer);
   if(hostTools){expect(spec.workflowTools).toBeDefined();expect(spec.env.AGENT_WORKFLOW_TOKEN).toBeUndefined();}
   else{expect(spec.workflowTools).toBeUndefined();expect(spec.env.AGENT_WORKFLOW_TOKEN).toBeTruthy();cliEnv=spec.env;}
   if(reviewer){expect(spec.prompt).not.toContain('TAIL-ONLY-7f481');
    const ref=spec.prompt.match(/artifact:[0-9a-f-]+/)![0];
    const readArtifact=(input:string)=>hostTools?spec.workflowTools!.call('read_artifact',{ref:input}):callWorkflow('read_artifact',{ref:input},spec.env);
    read=await readArtifact(ref);
    expect(read.text).toBe(text);expect(read.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(readArtifact('artifact:outside')).rejects.toThrow();
   }
   return {runId:spec.executionId,result:Promise.resolve('completed' as const),stop:async()=>{},stopReason:()=>undefined,waitForExit:async()=>true,
    async *events(){yield {type:'session' as const,nativeSessionId:hostTools?'dsh-native':'agy-native'};yield {type:'final_text' as const,text:reviewer?JSON.stringify({tail:read.text.slice(-15),ref:read.ref,digest:read.digest}):text};yield {type:'done' as const,normal:true};}};
  }}});
 await runtime.start();cleanup.push(()=>runtime.close());
 await runtime.call({kind:'main',scopeId:root.scopeId,allowStart:true},'run_script',{operationId:randomUUID(),goal:'mixed artifact',plan:'Produce a long result then review its complete tail through the actual worker transport.',
  script:`await agent("produce",{key:"a",member:"producer",harness:"${config.producer}",onError:"throw"});return await agent("review assigned input",{key:"b",member:"reviewer",harness:"${config.reviewer}",inputs:["a"],onError:"throw"});`});
 await vi.waitFor(async()=>{await runtime.tick();expect(runtime.kernel.state(root.scopeId)?.script?.status).toBe('result_ready');},{timeout:10000});
 expect(specs).toHaveLength(2);expect(workerTools).toHaveBeenCalledTimes(2);expect(read.text.endsWith('TAIL-ONLY-7f481')).toBe(true);
 const reviewer=specs[1]!,hostTools=Boolean(reviewer.workflowTools);
 const hostHint='workflow_call({method:"read_artifact"',cliHint='node "$AGENT_WORKFLOW_CLI" workflow read_artifact';
 expect(reviewer.prompt).toContain(hostTools?hostHint:cliHint);
 expect(reviewer.prompt).not.toContain(hostTools?cliHint:hostHint);
 await expect(callWorkflow('read_artifact',{ref:read.ref},cliEnv)).rejects.toThrow(/revoked|missing/);
});
