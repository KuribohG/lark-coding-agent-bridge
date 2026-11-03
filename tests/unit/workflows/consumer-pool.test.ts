import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowKernel } from '../../../src/workflows/engine/kernel';
import { handleWorkflowCommand } from '../../../src/workflows/chat/commands';
import type { WorkflowRoot, WorkflowWorkerRequest, WorkflowWorkerResult, WorkflowWorkItem } from '../../../src/workflows/engine/types';

type Grant = {claimId:string;generation:number;item:WorkflowWorkItem};
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const spec = { key:'consumers',prompt:'Square item.input',members:['A','B','C'].map(name=>({name})) };

function harness(path = ':memory:') {
  let now = 1_000_000;
  let root: WorkflowRoot = { scopeId:'consumer-test',profile:'default',agentKind:'codex',cwdRealpath:'/workspace',
    policyFingerprint:'policy',catalogBinding:'root',modelSettings:{} };
  const requests: WorkflowWorkerRequest[] = [];
  const finishers = new Map<string,(result:WorkflowWorkerResult)=>void>();
  const host = {resolveRoot:async()=>root,wakeMain:async()=>{},execute:async(request:WorkflowWorkerRequest)=>{
    requests.push(request); request.onRun('run-'+request.attemptId);
    request.onSession(request.session.nativeSessionId ?? 'native-'+request.session.actorId);
    return new Promise<WorkflowWorkerResult>(resolve=>{
      finishers.set(request.attemptId,resolve);
      request.signal.addEventListener('abort',()=>resolve({status:'stopped'}),{once:true});
    });
  }};
  let kernel = new WorkflowKernel(path,host,()=>now);
  cleanup.push(()=>kernel.close());
  const state = () => kernel.state(root.scopeId)!;
  const call = (method:string,args:Record<string,unknown>={}) => kernel.call({kind:'main',scopeId:root.scopeId,allowStart:true},method,
    {operationId:randomUUID(),workflowId:state()?.workflowId,expectedStateVersion:state()?.stateVersion,...args});
  const work = (kind:string,args:Record<string,unknown>={})=>kernel.scriptWork(root.scopeId,state().workflowId,state().script!.runId,{kind,...args});
  const send = (request:WorkflowWorkerRequest,method:string,args:Record<string,unknown>={}) => kernel.call({kind:'worker',scopeId:root.scopeId,
    workflowId:state().workflowId,taskId:request.task.taskId,attemptId:request.attemptId},method,{operationId:randomUUID(),...args});
  const settle = (request:WorkflowWorkerRequest)=>vi.waitFor(()=>expect(['starting','running','cancelling']).not.toContain(state().tasks.find(task=>task.taskId===request.task.taskId)!.status));
  return {get kernel(){return kernel;},state,call,work,send,requests,settle,
    start:async(args:Record<string,unknown>={})=>{await call('run_script',{goal:'Consume and recover queued work',plan:'Three consumers wait for work, consume it, and stop after close.',script:'return null;',maxConcurrent:3,...args});kernel.beginScript(root.scopeId,state().workflowId);},
    pool:(args:Record<string,unknown>={})=>work('consume',{...spec,...args}),
    enqueue:(n:number,args:Record<string,unknown>={})=>call('enqueue_work',{key:'item-'+n,title:'Square '+n,input:n,...args}),
    claim:(request:WorkflowWorkerRequest,args:Record<string,unknown>={})=>send(request,'claim_work',args) as Promise<Grant|null>,
    finish:async(request:WorkflowWorkerRequest)=>{finishers.get(request.attemptId)!({status:'completed',text:'done'});await settle(request);},
    run:async(count:number)=>{await kernel.tick();await vi.waitFor(()=>expect(requests).toHaveLength(count));},
    result:(key?:string)=>kernel.scriptConsumerResult(root.scopeId,state().workflowId,state().script!.runId,key),
    advance:(ms:number)=>{now+=ms;},
    restart:async()=>{await kernel.close();kernel=new WorkflowKernel(path,host,()=>now);},
    replay:async()=>{await call('replay_script');kernel.beginScript(root.scopeId,state().workflowId);},
    changeRoot:()=>{root={...root,catalogBinding:'changed'};},
    command:(args:string)=>handleWorkflowCommand(kernel,root.scopeId,args,()=>{throw new Error('Read-only command started a workflow');}),
  };
}

const token = (grant:Grant)=>({claimId:grant.claimId,generation:grant.generation});
async function drain(h:ReturnType<typeof harness>, workers:WorkflowWorkerRequest[]) {
  for (;;) {
    const grants = await Promise.all(workers.map(worker=>h.claim(worker)));
    if(grants.every(grant=>grant===null)) break;
    await Promise.all(grants.map((grant,i)=>grant && h.send(workers[i]!,'complete_work',{...token(grant),result:(grant.item.input as number)**2})));
  }
  for(const worker of workers) await h.finish(worker);
  await h.kernel.tick();
}

describe('queue-driven consumer pool',()=>{
  it('delivers peer feedback to an idle consumer while another consumer is still working', async () => {
    const h=harness();await h.start({maxConcurrent:2});
    await h.enqueue(1);await h.enqueue(2);
    await h.pool({wakeOnMessages:true,members:[{name:'A'},{name:'B'}]});await h.run(2);
    const [a,b]=h.requests;
    const ga=(await h.claim(a!))!,gb=(await h.claim(b!))!;
    await h.send(a!,'complete_work',{...token(ga),result:1});await h.finish(a!);
    await h.send(b!,'send_message',{member:'A',text:'Independent check found missing evidence',topic:'review'});
    await h.run(3);
    const feedback=h.requests[2]!;
    expect(feedback.task.agentId).toBe(a!.task.agentId);
    expect(feedback.task.consumerMessageTurn).toBe(true);
    expect(feedback.task.inputMessageIds).toEqual([h.state().mailbox!.messages[0]!.id]);
    expect(await h.send(feedback,'read_context')).toMatchObject({member:{messages:[{text:'Independent check found missing evidence',topic:'review'}]}});
    expect(h.state().mailbox!.messages[0]!.consumedByTurnId).toBeUndefined();
    expect(h.state().tasks.find(task=>task.taskId===b!.task.taskId)!.status).toBe('running');
    await h.send(b!,'send_message',{member:'A',text:'A second check is ready'});
    await h.kernel.tick();expect(h.requests).toHaveLength(3);
    await h.finish(feedback);await h.run(4);
    expect(h.state().mailbox!.messages[0]!.consumedByTurnId).toBe(feedback.task.taskId);
    expect(h.state().mailbox!.messages[1]!.consumedByTurnId).toBeUndefined();
    expect(h.requests[3]!.task.inputMessageIds).toEqual([h.state().mailbox!.messages[1]!.id]);
    await h.finish(h.requests[3]!);
    await h.send(b!,'complete_work',{...token(gb),result:4});await h.finish(b!);
    await h.call('close_work_queue');await h.kernel.tick();
    expect(h.result()).toMatchObject({consumers:{status:'drained',wakeOnMessages:true,turns:4}});
    for(let i=0;i<3;i++)await h.kernel.tick();expect(h.requests).toHaveLength(4);
  });

  it('recovers an interrupted feedback turn even when its work queue is closed', async () => {
    const dir=await mkdtemp(join(tmpdir(),'feedback-recovery-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
    const h=harness(join(dir,'state.db'));await h.start();await h.enqueue(1);
    const pool={wakeOnMessages:true,members:[{name:'A'}]};
    await h.pool(pool);await h.run(1);await drain(h,[h.requests[0]!]);
    await h.call('send_message',{member:'A',text:'Verify this new evidence'});await h.run(2);
    const feedback=h.requests[1]!;
    await h.call('close_work_queue');await h.restart();
    expect(h.state().mailbox!.messages[0]!.consumedByTurnId).toBeUndefined();
    await h.replay();await h.pool(pool);await h.run(3);
    const restored=h.requests[2]!;
    expect(restored.task.taskId).toBe(feedback.task.taskId);
    expect(restored.task.inputMessageIds).toEqual(feedback.task.inputMessageIds);
    await h.finish(restored);await h.kernel.tick();
    expect(h.result()).toMatchObject({consumers:{status:'drained',turns:2}});
    expect(h.state().mailbox!.messages[0]!.consumedByTurnId).toBe(restored.task.taskId);
    await h.call('pause');await h.replay();await h.pool(pool);await h.kernel.tick();expect(h.requests).toHaveLength(3);
  });

  it('does not reserve a work slot for a message-only turn or change legacy message behavior', async () => {
    const h=harness();await h.start({maxConcurrent:2});await h.enqueue(1);
    await h.pool({wakeOnMessages:true,members:[{name:'A'},{name:'B'}]});await h.run(1);await drain(h,[h.requests[0]!]);
    await h.call('send_message',{member:'A',text:'Check feedback'});await h.run(2);
    await h.enqueue(2);await h.run(3);
    expect(h.requests[2]!.task.agentId).not.toBe(h.requests[1]!.task.agentId);
    expect((await h.claim(h.requests[2]!))!.item.key).toBe('item-2');
    const legacy=harness();await legacy.start();await legacy.enqueue(1);
    await legacy.pool({members:[{name:'A'}]});await legacy.run(1);await drain(legacy,[legacy.requests[0]!]);
    await legacy.call('send_message',{member:'A',text:'Not opted in'});await legacy.kernel.tick();
    expect(legacy.requests).toHaveLength(1);
    expect(legacy.state().mailbox!.messages[0]!.receiptId).toBeUndefined();
  });

  it('bounds feedback turns and preserves the opt-in binding across replay', async () => {
    const h=harness();await h.start();await h.enqueue(1);
    const spec={wakeOnMessages:true,maxTurns:2,members:[{name:'A'}]};
    await h.pool(spec);await h.run(1);await drain(h,[h.requests[0]!]);
    await h.call('send_message',{member:'A',text:'One useful followup'});await h.run(2);await h.finish(h.requests[1]!);
    await h.call('send_message',{member:'A',text:'Over budget'});await h.kernel.tick();
    expect(()=>h.result()).toThrow('budget reached');expect(h.requests).toHaveLength(2);
    expect(h.state().mailbox!.messages[1]!.receiptId).toBeUndefined();
    await h.call('pause');await h.replay();
    await expect(h.pool({...spec,wakeOnMessages:false})).rejects.toThrow('immutable');
  });

  it('routes independent pools, honors priority and unlocks cross-queue dependencies', async () => {
    const h=harness();await h.start({maxConcurrent:2});
    await h.enqueue(1,{queue:'scan'});
    await h.enqueue(2,{queue:'scan',priority:10});
    await h.enqueue(3,{queue:'review',dependsOn:['item-2']});
    await h.pool({key:'scanners',queue:'scan',maxConcurrent:1,members:[{name:'S'},{name:'S2'}]});
    await h.pool({key:'reviewers',queue:'review',maxConcurrent:1,members:[{name:'R'}]});
    await h.work('close',{key:'close-scan',queue:'scan'});
    await h.work('close',{key:'close-review',queue:'review'});
    await h.run(1);
    const scanner=h.requests[0]!;
    await expect(h.claim(scanner,{queue:'review'})).rejects.toThrow('another pool');
    const high=(await h.claim(scanner))!;expect(high.item.key).toBe('item-2');
    await h.send(scanner,'complete_work',{...token(high),result:4});
    await h.run(2);
    const reviewer=h.requests[1]!;
    const review=(await h.claim(reviewer))!;expect(review.item.key).toBe('item-3');
    const low=(await h.claim(scanner))!;expect(low.item.key).toBe('item-1');
    await h.send(scanner,'complete_work',{...token(low),result:1});
    await h.send(reviewer,'complete_work',{...token(review),result:9});
    await h.finish(scanner);await h.finish(reviewer);await h.kernel.tick();
    expect(h.result('scanners')).toMatchObject({queue:{completed:2,closed:true}});
    expect(h.result('reviewers')).toMatchObject({queue:{completed:1,closed:true}});
    expect(await h.command('work')).toContain('队列 review');
    await h.call('pause');
    await h.replay();
    await h.pool({key:'scanners',queue:'scan',maxConcurrent:1,members:[{name:'S'},{name:'S2'}]});
    await h.pool({key:'reviewers',queue:'review',maxConcurrent:1,members:[{name:'R'}]});
    await h.kernel.tick();expect(h.requests).toHaveLength(2);
    expect(h.result('reviewers')).toMatchObject({queue:{completed:1}});
  });

  it('keeps resource exclusions global across queues and pool membership immutable', async () => {
    const h=harness();await h.start({maxConcurrent:2});
    await h.enqueue(1,{queue:'left',resources:['worktree:shared']});
    await h.enqueue(2,{queue:'right',resources:['worktree:shared']});
    await h.pool({key:'left-pool',queue:'left',members:[{name:'L'}]});
    await expect(h.pool({key:'wrong-pool',queue:'right',members:[{name:'L'}]})).rejects.toThrow('another pool');
    await h.pool({key:'right-pool',queue:'right',members:[{name:'R'}]});await h.run(2);
    const first=(await h.claim(h.requests[0]!))!;
    expect(await h.claim(h.requests[1]!)).toBeNull();
    // A resource-blocked worker exits; it must wake again when the other queue releases the resource.
    await h.finish(h.requests[1]!);await h.kernel.tick();
    expect(h.requests).toHaveLength(2);
    await h.send(h.requests[0]!,'complete_work',{...token(first),result:1});
    await h.finish(h.requests[0]!);await h.run(3);
    const second=(await h.claim(h.requests[2]!))!;
    expect(second.item.key).toBe('item-2');
    await h.send(h.requests[2]!,'complete_work',{...token(second),result:4});
    await h.finish(h.requests[2]!);
    await h.work('close',{key:'close-left',queue:'left'});
    await h.work('close',{key:'close-right',queue:'right'});await h.kernel.tick();
    expect(h.result('left-pool')).toMatchObject({queue:{completed:1},consumers:{status:'drained'}});
    expect(h.result('right-pool')).toMatchObject({queue:{completed:1},consumers:{status:'drained'}});
    await expect(h.work('enqueue',{key:'unknown-dependency',title:'invalid',dependsOn:['missing']})).rejects.toThrow('existing work keys');
    await expect(h.work('enqueue',{key:'cycle',title:'invalid',dependsOn:['cycle']})).rejects.toThrow('existing work keys');
    await expect(h.work('enqueue',{key:'bad-name',title:'invalid',queue:'constructor'})).rejects.toThrow('queue name');
  });

  it('persists multiple pool bindings and progress across a controller restart', async () => {
    const dir=await mkdtemp(join(tmpdir(),'consumer-multi-restart-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
    const h=harness(join(dir,'workflow.db'));await h.start();
    await h.enqueue(1,{queue:'one'});await h.enqueue(2,{queue:'two'});
    const pools=[{key:'one',queue:'one',members:[{name:'A'}]},{key:'two',queue:'two',members:[{name:'B'}]}];
    for(const pool of pools)await h.pool(pool);
    await h.run(2);
    const grant=(await h.claim(h.requests[1]!))!;
    await h.send(h.requests[1]!,'checkpoint_work',{...token(grant),expectedProgressVersion:0,state:{phase:'saved'}});
    await h.restart();await h.kernel.tick();expect(h.requests).toHaveLength(2);
    await h.replay();for(const pool of pools)await h.pool(pool);await h.run(4);
    const restored=(await h.claim(h.requests[3]!))!;
    expect(restored.item.progress.state).toEqual({phase:'saved'});
    expect(restored.generation).toBe(2);
    expect(h.requests[3]!.session.nativeSessionId).toBe(h.requests[1]!.session.nativeSessionId ?? 'native-'+h.requests[1]!.session.actorId);
  });

  it('consumes 10+5 items, adopts an expired claim, releases idle workers and only returns after close',async()=>{
    const h=harness();await h.start();
    for(let i=0;i<10;i++) await h.enqueue(i);
    await h.pool();await h.run(3);
    const [a,b,c]=h.requests;
    const abandoned=(await h.claim(a!,{leaseMs:1000}))!;
    await h.send(a!,'checkpoint_work',{...token(abandoned),expectedProgressVersion:0,state:{stage:'partial'}});
    h.advance(1001);await h.kernel.tick();await h.settle(a!);
    const adopted=(await h.claim(b!))!;
    expect(adopted.item.progress.state).toEqual({stage:'partial'});
    expect(adopted.generation).toBe(2);
    await h.send(b!,'complete_work',{...token(adopted),result:0});
    await expect(h.send(a!,'complete_work',{...token(abandoned),result:-1})).rejects.toThrow('inactive');
    await drain(h,[b!,c!]);
    expect(h.state().consumerPool!.status).toBe('waiting');expect(h.result()).toBeUndefined();
    const idleVersion=h.state().stateVersion;
    for(let i=0;i<5;i++) await h.kernel.tick();
    expect(h.requests).toHaveLength(3);expect(h.state().stateVersion).toBe(idleVersion);
    expect(h.state().consumerPool!.members[0]!.disabled).toContain('lease expired');
    for(let i=10;i<15;i++) await h.enqueue(i);
    await h.run(5);
    expect(h.requests[3]!.session.nativeSessionId).toBe(b!.session.nativeSessionId ?? 'native-'+b!.session.actorId);
    await drain(h,h.requests.slice(3));
    expect(h.result()).toBeUndefined();
    await h.call('close_work_queue');await h.kernel.tick();
    expect(h.result()).toMatchObject({queue:{total:15,completed:15,closed:true},consumers:{status:'drained',turns:5}});
    expect(h.state().workQueue!.items.map(item=>item.result)).toEqual(Array.from({length:15},(_,i)=>i*i));
    expect(h.state().workQueue!.claims.filter(claim=>claim.status==='completed')).toHaveLength(15);
  });

  it('persists an empty wait without starting a member and drains an empty closed queue',async()=>{
    const h=harness();await h.start();await h.pool();
    for(let i=0;i<3;i++) await h.kernel.tick();
    expect(h.requests).toHaveLength(0);expect(h.state().consumerPool!.status).toBe('waiting');
    expect(h.state().agents ?? []).toHaveLength(0);
    await h.work('close',{key:'closed'});await h.kernel.tick();
    expect(h.result()).toMatchObject({queue:{closed:true,total:0}});
    await expect(h.enqueue(1)).rejects.toThrow('closed');
  });

  it('limits dispatch to available resource keys and fails a no-progress consumer without a polling loop',async()=>{
    const h=harness();await h.start();
    await h.enqueue(1,{resources:['worktree:shared']});await h.enqueue(2,{resources:['worktree:shared']});
    await h.pool();await h.run(1);
    const grant=(await h.claim(h.requests[0]!))!;
    await h.kernel.tick();expect(h.requests).toHaveLength(1);
    await h.send(h.requests[0]!,'complete_work',{...token(grant),result:1});
    await h.finish(h.requests[0]!);await h.run(2);
    // Each idle member may be tried once for the same available work; none can spin forever.
    await h.finish(h.requests[1]!);await h.run(3);
    await h.finish(h.requests[2]!);await h.run(4);
    await h.finish(h.requests[3]!);await h.kernel.tick();
    expect(()=>h.result()).toThrow('No consumer made progress');
    for(let i=0;i<4;i++) await h.kernel.tick();
    expect(h.requests).toHaveLength(4);
  });

  it.each(['idle','inflight'] as const)('requires explicit replay after an %s controller restart and preserves the native history',async mode=>{
    const dir=await mkdtemp(join(tmpdir(),'consumer-restart-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
    const h=harness(join(dir,'workflow.db'));await h.start();await h.enqueue(1);await h.pool({members:[{name:'A'}]});await h.run(1);
    await drain(h,[h.requests[0]!]);
    const nativeId=h.state().sessions[0]!.nativeSessionId;
    if(mode==='inflight'){
      await h.enqueue(2);await h.run(2);const grant=(await h.claim(h.requests[1]!))!;
      await h.send(h.requests[1]!,'checkpoint_work',{...token(grant),expectedProgressVersion:0,state:'saved-before-restart'});
    }
    await h.restart();const count=h.requests.length;
    expect(h.state().status).toBe('interrupted');
    await h.enqueue(3);await h.kernel.tick();expect(h.requests).toHaveLength(count);
    await h.replay();await h.pool({members:[{name:'A'}]});await h.run(count+1);
    const restored=h.requests.at(-1)!;
    expect(restored.session.nativeSessionId).toBe(nativeId);
    expect(h.state().script!.calls[0]!.cached).toBe(true);
    if(mode==='inflight'){
      expect(restored.task.taskId).toBe(h.requests[1]!.task.taskId);
      const grant=(await h.claim(restored))!;expect(grant.item.progress.state).toBe('saved-before-restart');
    }
    await drain(h,[restored]);await h.call('close_work_queue');await h.kernel.tick();
    expect(h.result()).toMatchObject({queue:{completed:mode==='idle'?2:3}});
  });

  it('replays committed pool turns and enqueue/close calls without duplicating results or processes',async()=>{
    const h=harness();await h.start();
    const item={key:'item',title:'Item',input:4};await h.work('enqueue',item);await h.work('close',{key:'close'});
    await h.pool();await h.run(1);await drain(h,[h.requests[0]!]);
    expect(h.result()).toMatchObject({queue:{completed:1}});
    h.kernel.finishScript('consumer-test',h.state().workflowId,h.state().script!.runId,{text:'"done"'});
    await h.replay();await h.work('enqueue',item);await h.work('close',{key:'close'});await h.pool();await h.kernel.tick();
    expect(h.result()).toMatchObject({queue:{completed:1}});expect(h.requests).toHaveLength(1);
    expect(h.state().workQueue!.items).toHaveLength(1);
  });

  it('respects turn budgets and permits a closed failed item to be explicitly retried',async()=>{
    const h=harness();await h.start();await h.enqueue(1);await h.call('close_work_queue');await h.pool({members:[{name:'A'}],maxTurns:2});await h.run(1);
    const grant=(await h.claim(h.requests[0]!))!;
    await h.send(h.requests[0]!,'fail_work',{...token(grant),error:'needs retry'});await h.finish(h.requests[0]!);await h.kernel.tick();
    expect(()=>h.result()).toThrow('Work items failed');
    h.kernel.finishScript('consumer-test',h.state().workflowId,h.state().script!.runId,{error:'failed work'});
    await h.call('retry_work',{itemId:grant.item.id});await h.replay();await h.pool({members:[{name:'A'}],maxTurns:2});await h.run(2);
    await drain(h,[h.requests[1]!]);expect(h.result()).toMatchObject({queue:{completed:1}});

    const limited=harness();await limited.start({maxAgents:1});await limited.enqueue(1);await limited.enqueue(2);await limited.pool({maxTurns:1});await limited.run(1);
    const first=(await limited.claim(limited.requests[0]!))!;await limited.send(limited.requests[0]!,'complete_work',{...token(first),result:1});
    await limited.finish(limited.requests[0]!);await limited.kernel.tick();expect(()=>limited.result()).toThrow('budget');
    expect(limited.requests).toHaveLength(1);
  });

  it('rejects definition changes, key collisions, external member scheduling and changed root authorization',async()=>{
    const h=harness();await h.start();
    await expect(h.pool({members:[{name:'A'},{name:'A'}]})).rejects.toThrow('unique');
    await expect(h.pool({members:[{name:'A',profile:'other'}]})).rejects.toThrow('Unsupported');
    await h.pool();await expect(h.pool()).rejects.toThrow('Duplicate');
    await expect(h.work('enqueue',{key:'consumers',title:'Collision'})).rejects.toThrow('another');
    await expect(h.kernel.scriptAgent('consumer-test',h.state().workflowId,h.state().script!.runId,{key:'external',member:'A',prompt:'Skip pool'})).rejects.toThrow('reserved');
    await h.call('pause');await h.replay();
    await expect(h.pool({prompt:'Changed history'})).rejects.toThrow('immutable');
    h.changeRoot();await expect(h.pool()).rejects.toThrow('Root');
    await h.kernel.tick();expect(h.requests).toHaveLength(0);
  });

  it('shows empty waits and accepts enqueue/close commands without implicitly resuming a paused pool',async()=>{
    const h=harness();
    expect(await h.command('enqueue {}')).toBe('当前没有工作流。');
    await h.start();await h.pool();await h.kernel.tick();
    expect(await h.command('work')).toContain('不占 worker 进程');
    expect(await h.command('status A')).toContain('等待首次队列任务');
    await h.call('pause');
    expect(await h.command('enqueue {"key":"late","title":"Late","input":5}')).toContain('已入队');
    expect(await h.command('enqueue {"key":"bad","workflowId":"other"}')).toContain('用法');
    expect(await h.command('close')).toContain('队列已关闭');
    await h.kernel.tick();expect(h.requests).toHaveLength(0);
    expect(h.state().status).toBe('paused');
    await h.replay();await h.pool();await h.run(1);await drain(h,[h.requests[0]!]);
    expect(h.result()).toMatchObject({queue:{completed:1,closed:true}});
  });
});
