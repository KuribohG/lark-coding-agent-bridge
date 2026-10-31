import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { WorkflowKernel } from '../../../src/workflows/kernel';
import { workflowWorkerInstructions } from '../../../src/workflows/ipc';
import type { WorkflowRoot, WorkflowState, WorkflowWorkerRequest, WorkflowWorkerResult } from '../../../src/workflows/types';

const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse()) await close();});
function harness(path=':memory:') {
  let now=1_000_000;
  let root:WorkflowRoot={scopeId:'nested-test',profile:'default',agentKind:'codex',cwdRealpath:'/workspace',policyFingerprint:'policy',catalogBinding:'root',modelSettings:{}};
  const requests:WorkflowWorkerRequest[]=[];
  const finishers=new Map<string,(result:WorkflowWorkerResult)=>void>();
  const host={resolveRoot:async()=>root,wakeMain:async()=>{},execute:async(request:WorkflowWorkerRequest)=>{
    requests.push(request);request.onRun('run-'+request.attemptId);request.onSession(request.session.nativeSessionId ?? 'native-'+request.session.sessionRef);
    return new Promise<WorkflowWorkerResult>(resolve=>{finishers.set(request.attemptId,resolve);request.signal.addEventListener('abort',()=>resolve({status:'stopped'}),{once:true});});
  }};
  let kernel=new WorkflowKernel(path,host,()=>now);cleanup.push(()=>kernel.close());
  const state=(id?:string)=>kernel.state(root.scopeId,id)!;
  const call=(method:string,args:Record<string,unknown>={})=>kernel.call({kind:'main',scopeId:root.scopeId,allowStart:true},method,
    {operationId:randomUUID(),workflowId:state()?.workflowId,expectedStateVersion:state()?.stateVersion,...args});
  const send=(request:WorkflowWorkerRequest,method:string,args:Record<string,unknown>={})=>kernel.call({kind:'worker',scopeId:root.scopeId,
    workflowId:request.workflow.workflowId,taskId:request.task.taskId,attemptId:request.attemptId},method,args);
  const agent=(workflow:WorkflowState,args:Record<string,unknown>={})=>kernel.scriptAgent(root.scopeId,workflow.workflowId,workflow.script!.runId,
    {key:'parent',prompt:'Perform the authorized task',workflowTool:true,...args});
  return {get kernel(){return kernel;},state,call,send,agent,requests,
    start:async(args:Record<string,unknown>={})=>{await call('run_script',{goal:'Nested workflow test',plan:'Delegate within this workflow',script:'return null;',maxConcurrent:1,...args});kernel.beginScript(root.scopeId,state().workflowId);},
    run:async(count:number)=>{await kernel.tick();await vi.waitFor(()=>expect(requests).toHaveLength(count));},
    finish:async(request:WorkflowWorkerRequest,text='done')=>{finishers.get(request.attemptId)!({status:'completed',text});await vi.waitFor(()=>expect(['starting','running','cancelling']).not.toContain(state(request.workflow.workflowId).tasks.find(task=>task.taskId===request.task.taskId)!.status));},
    child:async(request:WorkflowWorkerRequest,args:Record<string,unknown>={})=>send(request,'run_workflow',{operationId:'child-op',key:'child',goal:'Return the answer',script:'return 42;',plan:'Return 42 without workers',...args}) as Promise<{workflowId:string;status:string;result?:unknown}>,
    begin:(id:string)=>kernel.beginScript(root.scopeId,id),
    finishScript:(id:string,result:{text:string}|{error:string})=>kernel.finishScript(root.scopeId,id,state(id).script!.runId,result),
    advance:(ms:number)=>{now+=ms;},
    changeRoot:()=>{root={...root,catalogBinding:'changed'};},
    restart:async()=>{await kernel.close();kernel=new WorkflowKernel(path,host,()=>now);},
    replay:async()=>{await call('replay_script');kernel.beginScript(root.scopeId,state().workflowId);},
  };
}

describe('nested workflow capability',()=>{
  it('is absent and denied unless explicitly enabled, including independent and persistent agents',async()=>{
    const h=harness();await h.start({maxConcurrent:2});
    await h.agent(h.state(),{key:'plain',workflowTool:false});await h.agent(h.state(),{key:'member',member:'M',workflowTool:false});await h.run(2);
    for(const request of h.requests){
      expect(workflowWorkerInstructions(request.task)).not.toContain('run_workflow');
      await expect(h.child(request)).rejects.toThrow('not enabled');
      await expect(h.child(request,{workflowTool:true})).rejects.toThrow('not enabled');
    }
    await expect(h.call('run_workflow')).rejects.toThrow('Unsupported');
    await expect(h.kernel.call({kind:'main',scopeId:'ordinary'},'run_script',{operationId:'ungranted',goal:'x',script:'return 1;',plan:'x'})).rejects.toThrow('explicit /workflow');
    expect(h.kernel.queuedScripts()).toHaveLength(0);
  });

  it('yields a one-shot parent, returns the full child result and resumes the original native conversation',async()=>{
    const h=harness();await h.start();await h.agent(h.state());await h.run(1);const parent=h.requests[0]!;
    expect(workflowWorkerInstructions(parent.task)).toContain('run_workflow');
    const input={checkpoint:{next:'use child result'}};
    const child=await h.child(parent,input);
    expect(child.status).toBe('waiting');expect(h.begin(child.workflowId)).toBeUndefined();
    expect(await h.child(parent,input)).toEqual(child);
    await expect(h.child(parent,{key:'other'})).rejects.toThrow('operationId conflict');
    await expect(h.child(parent,{script:'return 43;'})).rejects.toThrow('conflict');
    await h.finish(parent,'yielding, not the final task result');
    expect(h.state().tasks[0]).toMatchObject({status:'waiting_workflow',resultRefs:[]});
    expect(h.begin(child.workflowId)).toBeDefined();h.finishScript(child.workflowId,{text:'42'});
    expect(h.state(child.workflowId).status).toBe('completed');
    expect(h.state().events).toHaveLength(0);
    await expect(h.kernel.call({kind:'main',scopeId:'nested-test',workflowId:h.state().workflowId},'read_artifact',
      {ref:h.state(child.workflowId).script!.planRef})).resolves.toMatchObject({text:'Return 42 without workers'});
    await expect(h.kernel.call({kind:'main',scopeId:'other-scope'},'read_artifact',
      {workflowId:h.state().workflowId,ref:h.state(child.workflowId).script!.planRef})).rejects.toThrow();
    await h.run(2);const resumed=h.requests[1]!;
    expect(resumed.task.taskId).toBe(parent.task.taskId);
    expect(resumed.session.nativeSessionId).toBe('native-'+parent.session.sessionRef);
    expect(resumed.prompt).toContain('use child result');
    await expect(h.send(resumed,'read_context')).resolves.toMatchObject({workflows:{call:{ok:true,result:42}}});
    await expect(h.child(parent,input)).rejects.toThrow('inactive');
    expect(await h.child(resumed,input)).toMatchObject({status:'completed',result:42});
    await h.finish(resumed,'Final answer 42');
    expect(h.state().tasks[0]!.resultRefs).toHaveLength(1);
    h.finishScript(h.state().workflowId,{text:'"Final answer 42"'});
    expect(h.state().events.map(event=>event.kind)).toEqual(['script_result_ready']);
  });

  it('allows each nested caller to enable or omit the tool for the next level and enforces depth',async()=>{
    const h=harness();await h.start({maxAgents:12});await h.agent(h.state());await h.run(1);
    let parent=h.requests[0]!;
    for(let depth=1;depth<=3;depth++){
      const child=await h.child(parent);await h.finish(parent);h.begin(child.workflowId);
      expect(h.state(child.workflowId).parent!.depth).toBe(depth);
      await h.agent(h.state(child.workflowId),{key:'disabled',workflowTool:false});await h.run(h.requests.length+1);
      const disabled=h.requests.at(-1)!;await expect(h.child(disabled)).rejects.toThrow('not enabled');await h.finish(disabled);
      await h.agent(h.state(child.workflowId),{key:'enabled'});await h.run(h.requests.length+1);parent=h.requests.at(-1)!;
    }
    await expect(h.child(parent)).rejects.toThrow('depth limit');
    await h.call('cancel');
    for(const request of h.requests) expect(h.state(request.workflow.workflowId).status).toBe('cancelled');
  });

  it('shares root task budgets and propagates a child failure without publishing it as a root event',async()=>{
    const h=harness();await h.start({maxAgents:1});await h.agent(h.state());await h.run(1);
    const child=await h.child(h.requests[0]!);await h.finish(h.requests[0]!);h.begin(child.workflowId);
    await expect(h.agent(h.state(child.workflowId))).rejects.toThrow('tree task budget');
    h.finishScript(child.workflowId,{error:'No budget for child agent'});await h.run(2);
    await expect(h.send(h.requests[1]!,'read_context')).resolves.toMatchObject({workflows:{call:{ok:false,error:'No budget for child agent'}}});
    expect(h.state().events).toHaveLength(0);
  });

  it.each([false,true])('requires explicit permission to enqueue into the parent queue: %s',async granted=>{
    const h=harness();await h.start();await h.agent(h.state());await h.run(1);
    const child=await h.child(h.requests[0]!,{parentQueue:granted});await h.finish(h.requests[0]!);h.begin(child.workflowId);
    const enqueue=()=>h.kernel.scriptWork('nested-test',child.workflowId,h.state(child.workflowId).script!.runId,{kind:'enqueue',queue:'parent',key:'from-child',title:'Fix the discovered issue',input:{issue:1}});
    if(granted){await enqueue();expect(h.state().workQueue!.items).toHaveLength(1);expect(h.state(child.workflowId).workQueue).toBeUndefined();}
    else {await expect(enqueue()).rejects.toThrow('not granted');expect(h.state().workQueue).toBeUndefined();}
    await expect(h.kernel.scriptWork('nested-test',child.workflowId,h.state(child.workflowId).script!.runId,{kind:'close',queue:'parent',key:'close'})).rejects.toThrow('Only enqueueWork');
  });

  it('requires explicit root replay after restart and continues the suspended child before resuming the parent',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'nested-recovery-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
    const h=harness(join(dir,'state.db'));await h.start();await h.agent(h.state());await h.run(1);
    const parent=h.requests[0]!;const child=await h.child(parent,{checkpoint:'saved parent progress'});await h.finish(parent);
    h.begin(child.workflowId);await h.agent(h.state(child.workflowId),{member:'child',workflowTool:false});await h.run(2);
    const native=h.state().sessions[0]!.nativeSessionId;
    await h.restart();await h.kernel.tick();expect(h.requests).toHaveLength(2);expect(h.kernel.queuedScripts()).toHaveLength(0);
    await h.replay();await h.agent(h.state());await h.kernel.tick();
    expect(h.requests).toHaveLength(2);expect(h.state().tasks[0]!.status).toBe('waiting_workflow');
    h.begin(child.workflowId);await h.agent(h.state(child.workflowId),{member:'child',workflowTool:false});await h.run(3);
    await h.finish(h.requests[2]!);h.finishScript(child.workflowId,{text:'"child recovered"'});await h.run(4);
    expect(h.requests[3]!.session.nativeSessionId).toBe(native);expect(h.requests[3]!.prompt).toContain('saved parent progress');
    expect(h.requests[3]!.prompt).toContain('child recovered');
  });

  it('bounds child timeouts and prevents dispatch after a root binding change',async()=>{
    const h=harness();await h.start();await h.agent(h.state());await h.run(1);
    const child=await h.child(h.requests[0]!,{timeoutMs:1000});await h.finish(h.requests[0]!);h.advance(1001);await h.run(2);
    expect(h.state(child.workflowId).script!.error).toContain('deadline');
    await h.child(h.requests[1]!,{key:'second',operationId:'second'});await h.finish(h.requests[1]!);
    h.changeRoot();await h.kernel.tick();expect(h.state().status).toBe('binding_attention');
    expect(h.kernel.queuedScripts()).toHaveLength(0);expect(h.requests).toHaveLength(2);
  });

  it.each(['before-yield','result-committed'])('recovers across the %s persistence boundary without duplicating the child',async boundary=>{
    const dir=await mkdtemp(join(tmpdir(),'nested-boundary-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
    const h=harness(join(dir,'state.db'));await h.start();await h.agent(h.state());await h.run(1);
    const parent=h.requests[0]!;
    const child=await h.child(parent,{checkpoint:{boundary}});
    if(boundary==='result-committed') {
      await h.finish(parent);h.begin(child.workflowId);h.finishScript(child.workflowId,{text:'42'});
    }
    const native=h.state().sessions[0]!.nativeSessionId;
    await h.restart();await h.replay();await h.agent(h.state());
    if(boundary==='before-yield') {
      await h.kernel.tick();expect(h.requests).toHaveLength(1);
      expect(h.state().tasks[0]?.status).toBe('waiting_workflow');
      h.begin(child.workflowId);h.finishScript(child.workflowId,{text:'42'});
    }
    await h.run(2);
    expect(h.requests[1]!.session.nativeSessionId).toBe(native);
    await expect(h.send(h.requests[1]!,'read_context')).resolves.toMatchObject({workflows:{checkpoint:{boundary},call:{result:42}}});
    const summary=await h.call('status') as {children:unknown[]};
    expect(summary.children).toHaveLength(1);
    expect(h.state(child.workflowId).script?.revision).toBe(boundary==='before-yield'?1:0);
  });

  it('can disable and re-enable delegation on successive turns of the same native member',async()=>{
    const h=harness();await h.start();
    const nativeIds=[];
    for(const [index,enabled] of [true,false,true].entries()) {
      await h.agent(h.state(),{key:'turn-'+index,member:'M',workflowTool:enabled});await h.run(index+1);
      const request=h.requests[index]!;nativeIds.push(h.state().sessions[0]?.nativeSessionId);
      expect(workflowWorkerInstructions(request.task).includes('run_workflow')).toBe(enabled);
      if(!enabled) await expect(h.child(request)).rejects.toThrow('not enabled');
      await h.finish(request);
    }
    expect(new Set(nativeIds).size).toBe(1);
    await expect(h.child(h.requests[0]!)).rejects.toThrow('inactive');
  });

  it('returns a saved child failure under its original key and only retries under a new key',async()=>{
    const h=harness();await h.start();await h.agent(h.state());await h.run(1);
    const first=await h.child(h.requests[0]!);await h.finish(h.requests[0]!);h.begin(first.workflowId);
    h.finishScript(first.workflowId,{error:'intentional child failure'});await h.run(2);
    const resumed=h.requests[1]!;
    await expect(h.child(resumed)).resolves.toMatchObject({workflowId:first.workflowId,status:'failed',error:'intentional child failure'});
    await expect(h.child(resumed,{operationId:'changed',script:'return 43;'})).rejects.toThrow('key conflict');
    const second=await h.child(resumed,{key:'retry',operationId:'retry'});
    expect(second.workflowId).not.toBe(first.workflowId);
    await h.finish(resumed);h.begin(second.workflowId);h.finishScript(second.workflowId,{text:'42'});await h.run(3);
    await expect(h.send(h.requests[2]!,'read_context')).resolves.toMatchObject({workflows:{call:{workflowId:second.workflowId,result:42}}});
  });

  it('rolls back every descendant when a later child rejects root replay',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'nested-atomic-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
    const path=join(dir,'state.db');const h=harness(path);await h.start({maxConcurrent:2});
    await h.agent(h.state(),{key:'A'});await h.agent(h.state(),{key:'B'});await h.run(2);
    const children=[];
    for(const request of h.requests) {children.push(await h.child(request));await h.finish(request);}
    await h.call('pause');
    // Force the second branch to hit its existing replay limit after the first is prepared.
    const second=h.state(children[1]!.workflowId);second.script!.revision=8;
    const db=new Database(path);
    db.prepare('UPDATE workflows SET data=? WHERE id=?').run(JSON.stringify(second),second.workflowId);db.close();
    const before=[h.state(),...children.map(child=>h.state(child.workflowId))];
    await expect(h.call('replay_script')).rejects.toThrow('replay limit');
    for(const snapshot of before) expect(h.state(snapshot.workflowId)).toEqual(snapshot);
    expect(h.kernel.queuedScripts()).toHaveLength(0);
  });
});
