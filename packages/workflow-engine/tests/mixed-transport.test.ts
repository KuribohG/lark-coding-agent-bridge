import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkflowRuntime, callWorkflow, type WorkerRunSpec, type WorkflowRoot } from '../src';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
it('hands a full long host-tool result to a CLI worker under its own task binding, then revokes the token',async()=>{
 const root:WorkflowRoot={scopeId:'mixed',profile:'test',agentKind:'dsh',cwdRealpath:'/repo',policyFingerprint:'policy',catalogBinding:'root',modelSettings:{model:'fixture'}};
 const text='evidence line 世界 '.repeat(1500)+'TAIL-ONLY-7f481';
 const specs:WorkerRunSpec[]=[];
 let read:any,cliEnv:Record<string,string>={};
 const runtime=new WorkflowRuntime({path:':memory:',hostTools:true,workerTools:execution=>execution.agentKind==='dsh'?'host':'cli',
  resolveRoot:async()=>root,resolveWorker:async(current,selection)=>({agentKind:selection.agentKind,profile:current.profile,modelSettings:{model:'fixture'},configurationFingerprint:selection.agentKind,policyFingerprint:'policy'}),wakeMain:async()=>{},
  runner:{async start(spec){await spec.validateBeforeRun();specs.push(spec);
   const reviewer=spec.execution.agentKind==='agy';
   if(reviewer){expect(spec.workflowTools).toBeUndefined();expect(spec.prompt).not.toContain('TAIL-ONLY-7f481');
    cliEnv=spec.env;const ref=spec.prompt.match(/artifact:[0-9a-f-]+/)![0];
    read=await callWorkflow('read_artifact',{ref},spec.env);
    expect(read.text).toBe(text);expect(read.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(callWorkflow('read_artifact',{ref:'artifact:outside'},spec.env)).rejects.toThrow();
   }else{expect(spec.workflowTools).toBeDefined();expect(spec.env.AGENT_WORKFLOW_TOKEN).toBeUndefined();}
   return {runId:spec.executionId,result:Promise.resolve('completed' as const),stop:async()=>{},stopReason:()=>undefined,waitForExit:async()=>true,
    async *events(){yield {type:'session' as const,nativeSessionId:reviewer?'agy-native':'dsh-native'};yield {type:'final_text' as const,text:reviewer?JSON.stringify({tail:read.text.slice(-15),ref:read.ref,digest:read.digest}):text};yield {type:'done' as const,normal:true};}};
  }}});
 await runtime.start();cleanup.push(()=>runtime.close());
 await runtime.call({kind:'main',scopeId:root.scopeId,allowStart:true},'run_script',{operationId:randomUUID(),goal:'mixed artifact',plan:'Produce a long result then review its complete tail through CLI.',
  script:'await agent("produce",{key:"a",member:"producer",harness:"dsh",onError:"throw"});return await agent("review assigned input",{key:"b",member:"reviewer",harness:"agy",inputs:["a"],onError:"throw"});'});
 await vi.waitFor(async()=>{await runtime.tick();expect(runtime.kernel.state(root.scopeId)?.script?.status).toBe('result_ready');},{timeout:10000});
 expect(specs).toHaveLength(2);expect(read.text.endsWith('TAIL-ONLY-7f481')).toBe(true);
 await expect(callWorkflow('read_artifact',{ref:read.ref},cliEnv)).rejects.toThrow(/revoked|missing/);
});
