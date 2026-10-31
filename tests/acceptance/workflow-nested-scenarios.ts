import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunOptions } from '../../src/agent/types';
import type { ProcessPool } from '../../src/runtime/process-pool';
import type { WorkflowRuntime } from '../../src/workflows/runtime';
import { callWorkflow } from '../../src/workflows/ipc';

interface Context {
  test: {id:string;scenario:string;backend:string;marker:string};
  phase:string;
  directory:string;
  project:string;
  runtime:WorkflowRuntime;
  processPool:ProcessPool;
  nativeRuns:AgentRunOptions[];
  observations:Array<{native?:string;resumed?:string}>;
  call(method:string,args?:Record<string,unknown>):Promise<unknown>;
  isStopping():boolean;
}
const save = (path:string, data:unknown) => writeFile(path,JSON.stringify(data,null,2),{mode:0o600});
const delay = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));

export async function runNestedScenario(ctx:Context):Promise<void> {
  const {test,phase,directory,project,runtime,processPool,call,nativeRuns,observations}=ctx;
  const hardCrash=test.scenario==='nested-crash';
  const singleParent=hardCrash || test.scenario==='nested-before-yield';
  const workspace=join(directory,'workspace');
  const helper=join(workspace,'nested-worker.mjs');
  let workflowId=runtime.kernel.state(test.id)?.workflowId;
  const state=()=>runtime.kernel.state(test.id,workflowId)!;
  const tree=()=>{
    const all=[state()];
    for (const node of all) for(const task of node.tasks) {
      const id=task.waitingWorkflowId ?? task.resumeWorkflowId;
      if(id && !all.some(node=>node.workflowId===id)) all.push(runtime.kernel.state(test.id,id)!);
    }
    return all;
  };
  const until=async(check:()=>boolean)=>{
    const deadline=Date.now()+240_000;
    while(Date.now()<deadline) {
      if(ctx.isStopping()) throw new Error('Acceptance cancelled');
      await runtime.tick();
      const failed=tree().find(node=>node.script?.status==='failed');
      if(failed) throw new Error(failed.script!.error);
      if(check()) return;
      await delay(50);
    }
    throw new Error('Nested acceptance deadline exceeded');
  };
  const instruction=(mode:string)=>`Run exactly node ${JSON.stringify(helper)} ${mode} in your foreground shell tool once this turn. Return its JSON stdout exactly, without fences. If stdout has status waiting, end this turn immediately with WAITING; the bridge will resume this same session later. Do not poll, send messages, read configuration, or do other work. A long foreground wait in leaf or parent-hold mode is intentional and will be interrupted by the test controller.`;
  if(phase==='prepare') {
    await copyFile(join(project,'tests/acceptance/workflow-nested-worker.mjs'),helper);
    if(hardCrash) runtime.kernel.onChange(test.id,()=>{
      if(state()?.tasks[0]?.status!=='waiting_workflow') return;
      // Crash only this controller after its real native turn exits. No shared
      // daemon or active native process needs to be killed for this fault model.
      assert.equal(processPool.snapshot().active,0);
      assert.equal(observations.length,1);
      assert(observations[0]!.native);
      assert.equal(tree().length,2);
      assert.equal(tree()[1]!.script!.status,'queued');
      writeFileSync(join(directory,'prepare-observations.json'),JSON.stringify(observations,null,2),{mode:0o600});
      writeFileSync(join(directory,'before.json'),JSON.stringify({pid:process.pid,fault:'SIGKILL-after-yield',
        pool:processPool.snapshot(),workflows:tree().map(node=>({workflowId:node.workflowId,sessions:node.sessions.map(session=>session.nativeSessionId)}))},null,2),{mode:0o600});
      process.kill(process.pid,'SIGKILL');
    });
    if(test.scenario==='nested-queue') {
      await save(join(workspace,'producer.json'),{operationId:'produce',key:'produce',goal:'Generate four arithmetic work items for the parent queue',
        plan:'A leaf on the current harness/model returns four integers without delegation. Enqueue each in the parent queue.',
        script:'const values=await agent("Return only [2,3,5,7] as JSON. Do not use tools.",{key:"plan",output:"json",workflowTool:false}); for(const n of values) await enqueueWork({queue:"parent",key:"item-"+n,title:"Square "+n,input:n});return {enqueued:values.length};',
        checkpoint:{stage:'delegated'},parentQueue:true});
      await call('run_script',{goal:'Native nested producer and parent queue consumption with one worker slot',
        script:'return await parallel([()=>consumeWork({key:"pool",members:[{name:"consumer",workflowTool:false}],prompt:args.consume}),async()=>{const produced=await agent(args.produce,{key:"producer",workflowTool:true,output:"json"});await closeWorkQueue({key:"close"});return produced;}]);',
        args:{produce:instruction('parent producer.json'),consume:instruction('consume')},
        plan:'One enabled producer delegates to a disabled planner. Its child enqueues four parent work items; a disabled persistent consumer completes them. The producer explicitly closes the queue. All use the configured harness/model and share one slot.',
        maxConcurrent:1,maxAgents:8,timeoutMs:600_000});
    } else if(singleParent) {
      await save(join(workspace,'middle.json'),{operationId:'child',key:'child',goal:'Return the test result after controller restart',
        plan:'Return the supplied JSON without native workers.',script:'return args;',args:{marker:test.marker,recovered:true},checkpoint:{stage:'delegated'}});
      await call('run_script',{goal:hardCrash?'Recover the isolated controller after SIGKILL immediately after the parent yields':'Restart the isolated controller after the parent commits a child but before yielding',
        script:'return await agent(args.task,{key:"parent",workflowTool:true,output:"json"});',
        args:{task:instruction((hardCrash?'parent':'parent-hold')+' middle.json')},
        plan:hardCrash?'One enabled parent on the configured harness/model commits a child and yields. SIGKILL only the isolated controller after its native turn exits, explicitly replay in a fresh process, run the pending child and resume the original parent session.':'One enabled parent on the configured harness/model commits a child and holds its native turn. Restart without a prior pause, explicitly replay, run the pending child and resume the original parent session.',
        maxConcurrent:1,maxAgents:1,timeoutMs:600_000});
    } else {
      await save(join(workspace,'leaf.json'),{operationId:'leaf',key:'leaf',goal:'Save leaf state and wait for the test interruption',
        plan:'One persistent leaf on the current harness/model, without delegation, checkpoints then waits for interruption.',
        script:'return await agent(args.task,{key:"leaf",member:"leaf",workflowTool:false,output:"json"});',
        args:{task:instruction('leaf '+test.marker)},checkpoint:{stage:'delegated'}});
      await save(join(workspace,'middle.json'),{operationId:'middle',key:'middle',goal:'Delegate to a persistent leaf and return its result',
        plan:'One middle caller on the current harness/model with delegation enabled. It yields for the leaf and resumes to return the result.',
        script:'return await agent(args.task,{key:"middle",workflowTool:true,output:"json"});',
        args:{task:instruction('parent leaf.json')},checkpoint:{stage:'delegated'}});
      await call('run_script',{goal:'Verify three native sessions across a nested interruption; run only the supplied helper within this isolated workspace',
        script:'return await agent(args.task,{key:"parent",workflowTool:true,output:"json"});',
        args:{task:instruction('parent middle.json')},
        plan:'Enabled parent delegates an enabled middle caller, which delegates a disabled persistent leaf. Use the configured harness/model and a single slot. Interrupt the leaf after checkpoint, then cancel or restart and explicitly replay.',
        maxConcurrent:1,maxAgents:3,timeoutMs:600_000});
    }
    workflowId=state().workflowId;
  } else {
    const before=JSON.parse(await readFile(join(directory,'before.json'),'utf8')) as {pid:number;workflows:Array<{workflowId:string;sessions:string[]}>};
    assert.notEqual(before.pid,process.pid,'Recovery must run in a fresh controller process');
    assert(tree().every(node=>node.status==='interrupted'));
    await runtime.tick();await delay(750);await runtime.tick();
    assert.equal(nativeRuns.length,0,'Restart must not automatically dispatch workers');
    await call('replay_script');
  }
  if(test.scenario==='nested-queue') {
    await until(()=>state().script?.status==='result_ready');
    assert.deepEqual(state().workQueue!.items.map(item=>item.result),[4,9,25,49]);
    assert(state().workQueue!.items.every(item=>item.status==='completed' && item.generation===1));
    assert.equal(state().consumerPool!.status,'drained');
    assert.equal(tree().length,2);
    assert(!tree()[1]!.workQueue,'Enqueues must belong to the parent');
    assert.equal(processPool.snapshot().active,0);
    assert.equal(state().events.length,1);
    const result=JSON.parse(state().artifacts.find(artifact=>artifact.ref===state().script!.resultRef)!.text);
    assert.deepEqual(result[1],{enqueued:4});
    await call('ack_events',{eventIds:state().events.map(event=>event.id)});
    await call('complete',{reportRef:state().script!.resultRef,openIssues:[],verificationLimits:'Native isolated nested producer/consumer test with one process slot; production runtime unchanged.'});
    await save(join(directory,'result.json'),{passed:true,scenario:test.scenario,result,workflows:tree().length,nativeTurns:observations.length,pool:processPool.snapshot()});
    return;
  }
  if(phase==='prepare') {
    if(hardCrash) {
      await until(()=>state().script?.status==='result_ready');
      throw new Error('Controller reached completion without the required SIGKILL');
    }
    if(test.scenario==='nested-before-yield') {
      await until(()=>tree().length===2 && state().tasks[0]?.status==='running' && tree()[1]?.script?.status==='queued');
      assert.equal(observations.length,1);
      await save(join(directory,'before.json'),{pid:process.pid,workflows:tree().map(node=>({workflowId:node.workflowId,sessions:node.sessions.map(session=>session.nativeSessionId)}))});
      // childPhase finally closes the controller directly, without first pausing it.
      return;
    }
    await until(()=>tree().length===3 && tree()[2]?.checkpoints?.some(checkpoint=>(checkpoint.state as {stage?:string})?.stage==='armed')===true);
    assert.equal(observations.length,3);
    const before={pid:process.pid,workflows:tree().map(node=>({workflowId:node.workflowId,sessions:node.sessions.map(session=>session.nativeSessionId)}))};
    assert(tree().slice(0,2).every(node=>node.tasks[0]?.status==='waiting_workflow'));
    const leafRun=nativeRuns.at(-1)!;
    await call(test.scenario==='nested-cancel'?'cancel':'pause');
    await until(()=>processPool.snapshot().active===0 && tree().every(node=>node.tasks.every(task=>task.status==='cancelled')));
    await assert.rejects(callWorkflow('checkpoint',{operationId:'late',expectedCheckpointVersion:1,state:{late:true}},leafRun.env),/revoked|inactive/);
    assert.equal(processPool.snapshot().waiting,0);
    assert(tree().every(node=>node.tasks.every(task=>task.resultRefs.length===0)));
    if(test.scenario==='nested-cancel') {
      assert(tree().every(node=>node.status==='cancelled'));
      await delay(750);await runtime.tick();
      assert.equal(observations.length,3,'Cancelled tree dispatched another native worker');
      assert(!runtime.kernel.hasWake(test.id),'Child cancellation must not wake the main chat');
      await save(join(directory,'result.json'),{passed:true,scenario:test.scenario,workflows:tree().length,nativeTurns:observations.length,lateSubmissionRejected:true,pool:processPool.snapshot()});
    } else {
      await save(join(directory,'before.json'),before);
    }
  } else {
    await until(()=>state().script?.status==='result_ready');
    const before=JSON.parse(await readFile(join(directory,'before.json'),'utf8')) as {workflows:Array<{workflowId:string;sessions:string[]}>};
    const nodes=tree();
    assert.equal(nodes.length,singleParent?2:3);
    for(const prior of before.workflows) {
      const after=nodes.find(node=>node.workflowId===prior.workflowId)!;
      assert.deepEqual(after.sessions.map(session=>session.nativeSessionId),prior.sessions);
      assert.equal(after.tasks.length,prior.sessions.length);
      if(after.tasks.length) assert.equal(after.tasks[0]!.attempts.length,2);
    }
    assert.equal(observations.length,singleParent?1:3);
    assert(observations.every(observation=>observation.resumed===observation.native));
    assert.equal(state().events.length,1);
    assert(nodes.slice(1).every(node=>node.events.every(event=>event.acknowledged && event.notified)));
    const result=JSON.parse(state().artifacts.find(artifact=>artifact.ref===state().script!.resultRef)!.text);
    assert.deepEqual(result,{marker:test.marker,recovered:true});
    await call('ack_events',{eventIds:state().events.map(event=>event.id)});
    await call('complete',{reportRef:state().script!.resultRef,openIssues:[],verificationLimits:hardCrash?'SIGKILL of the isolated controller after its native turn exited, then explicit replay with the original native session. Does not test killing an active native turn, daemon loss, power loss or exactly-once side effects.':'Restarted only the isolated controller. Original native sessions resumed after explicit replay. Not a machine-crash or exactly-once side-effect test.'});
    await save(join(directory,'result.json'),{passed:true,scenario:test.scenario,...(hardCrash?{fault:'SIGKILL-after-yield',recoveredPid:process.pid}:{}),result,nativeTurns:observations.length,workflows:nodes.map(node=>({workflowId:node.workflowId,nativeId:node.sessions[0]?.nativeSessionId,attempts:node.tasks[0]?.attempts.length ?? 0})),pool:processPool.snapshot()});
  }
}
