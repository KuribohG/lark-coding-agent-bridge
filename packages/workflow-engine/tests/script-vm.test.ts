import { describe, expect, it, vi } from 'vitest';
import { runScriptProgram, WorkflowAgentFailure } from '../src/engine/script-vm';
import { SCRIPT_MAX_KEYED_CALLS } from '../src/engine/limits';

function run(source: string, options: Partial<Parameters<typeof runScriptProgram>[0]> = {}) {
  return runScriptProgram({ source, args: null, signal: AbortSignal.timeout(5000),
    agent: async input => input, progress: () => {}, ...options });
}

describe('script interpreter', () => {
  it('routes durable control calls through a hidden host and rejects unfinished waits', async () => {
    const control = vi.fn(async (input: unknown) => {
      const call = input as {kind:string;taskId?:string};
      if (call.kind === 'start') return {taskId:'task',output:'text'};
      if (call.kind === 'wait') return {index:0,kind:'timer',value:{at:10}};
      if (call.kind === 'join') return 'done';
      return {taskId:call.taskId,status:'cancelled'};
    });
    expect(JSON.parse(await run('const task=await startAgent("work",{key:"start"}); await sleep(10,{key:"delay"}); await cancelTask(task,{key:"stop"}); return typeof __bridgeControl;', {control}))).toBe('undefined');
    expect(control.mock.calls.map(([call])=>(call as {kind:string}).kind)).toEqual(['start','wait','cancel']);
    await expect(run('sleep(100,{key:"pending"});return null;', {control:()=>new Promise(()=>{})})).rejects.toThrow('await every call');
  });
  it('executes data-dependent branches, parallel calls, and pipelines', async () => {
    const agent = vi.fn(async (call: unknown) => (call as { prompt: string }).prompt.toUpperCase());
    const progress = vi.fn();
    const result = await run([
      'phase("scan"); log(args.label);',
      'const values = await parallel([',
      '  () => agent(args.label, {key:"a", harness:"pi"}),',
      '  () => agent("b", {key:"b", harness:"codex"})]);',
      'if (values[0] !== "A") throw new Error("wrong branch");',
      'return await pipeline(values, value => value + "!", (value, i) => ({value, i}));',
    ].join('\n'), { args: { label: 'a' }, agent, progress });
    expect(JSON.parse(result)).toEqual([{ value: 'A!', i: 0 }, { value: 'B!', i: 1 }]);
    expect(agent.mock.calls.map(([call]) => call)).toEqual([
      { key: 'a', harness: 'pi', prompt: 'a' }, { key: 'b', harness: 'codex', prompt: 'b' },
    ]);
    expect(progress.mock.calls).toEqual([['phase', 'scan'], ['log', 'a']]);
  });

  it('rejects parse errors before any worker can start', async () => {
    const agent = vi.fn();
    await expect(run('agent("no", {key:"a"}); return {', { agent })).rejects.toThrow();
    expect(agent).not.toHaveBeenCalled();
  });

  it('resolves worker failures to null unless the call opts into throwing', async () => {
    const agent = vi.fn(async (_call: unknown) => { throw new WorkflowAgentFailure('worker failed'); });
    const progress = vi.fn();
    expect(JSON.parse(await run('return await agent("a", {key:"a"});', { agent, progress }))).toBeNull();
    expect(progress).toHaveBeenCalledWith('log', 'agent a failed; returning null: worker failed');
    expect(agent.mock.calls[0]![0]).toEqual({ key: 'a', prompt: 'a' });
    expect(await run('try { await agent("a", {key:"a", onError:"throw"}); } catch(e) { return [e.name, e.message]; }', { agent }))
      .toBe('["WorkflowAgentFailure","worker failed"]');
    await expect(run('return await agent("a", {key:"a", onError:"ignore"});', { agent })).rejects.toThrow("onError must be 'null' or 'throw'");
  });

  it('keeps invalid calls fatal for agent() but isolates failing parallel and pipeline items', async () => {
    const agent = vi.fn(async (call: unknown) => {
      if ((call as { key: string }).key === 'bad') throw new Error('Duplicate agent key: bad');
      return (call as { prompt: string }).prompt;
    });
    await expect(run('return await agent("a", {key:"bad"});', { agent })).rejects.toThrow('Duplicate agent key');
    expect(JSON.parse(await run('return await parallel([() => agent("a",{key:"bad"}), () => agent("b",{key:"b"}), () => { throw new Error("bug"); }]);', { agent })))
      .toEqual([null, 'b', null]);
    expect(JSON.parse(await run('return await pipeline([1, 2], v => { if (v === 1) throw new Error("x"); return v; }, v => v * 10);', { agent })))
      .toEqual([null, 20]);
  });

  it('does not expose host globals or a module loader', async () => {
    const values = JSON.parse(await run('return [typeof process, typeof require, typeof fetch, typeof Date, typeof __bridgeAgent, typeof __bridgeProgress, ({}).constructor.constructor("return typeof process")()];'));
    expect(values).toEqual(Array(7).fill('undefined'));
    await expect(run('return await import("node:fs");')).rejects.toThrow();
    await expect(run('return Math.random();')).rejects.toThrow('randomness');
  });

  it.each(['for (;;) {}', 'for (;;) { await Promise.resolve(); }', 'const a=[]; for (;;) a.push("x".repeat(100000));'])('bounds runaway program: %s', async source => {
    await expect(run(source)).rejects.toThrow();
  }, 10000);

  it('aborts a script waiting forever and ignores late host completion', async () => {
    const controller = new AbortController();
    let finish: ((value: string) => void) | undefined;
    const result = run('return await agent("a", {key:"a"});', { signal: controller.signal,
      agent: () => new Promise<string>(resolve => { finish = resolve; }) });
    const rejection = expect(result).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    controller.abort(new Error('cancelled'));
    await rejection;
    finish!('late result');
    await new Promise(resolve => setImmediate(resolve));
    await expect(run('await new Promise(() => {});', { signal: AbortSignal.timeout(20) })).rejects.toThrow();
  });

  it('rejects forgotten awaits and oversized final results', async () => {
    await expect(run('agent("a", {key:"a"}); return "early";', { agent: () => new Promise(() => {}) })).rejects.toThrow('await every call');
    await expect(run('return "x".repeat(100001);')).rejects.toThrow('size limit');
    await expect(run('return () => {};')).rejects.toThrow('not JSON serializable');
    expect(await run('return undefined;')).toBe('null');
  });

  it('routes bounded work calls through a hidden JSON-only host', async () => {
    const work = vi.fn(async (call: unknown) => call);
    expect(JSON.parse(await run('await enqueueWork({key:"one",title:"One",input:7}); return await workStatus({limit:3});', { work })))
      .toEqual({ kind: 'status', limit: 3 });
    expect(work.mock.calls).toEqual([[{kind:'enqueue',key:'one',title:'One',input:7}], [{kind:'status',limit:3}]]);
    expect(await run('return typeof __bridgeWork;')).toBe('"undefined"');
    await expect(run('await enqueueWork([]);', { work })).rejects.toThrow('enqueueWork');
    await expect(run('await workStatus();')).rejects.toThrow('host is unavailable');
    await expect(run(`for(let i=0;i<${SCRIPT_MAX_KEYED_CALLS + 1};i++) await workStatus();`, { work })).rejects.toThrow('call limit');
    await expect(run('await workStatus();', { work: async () => { throw new Error('queue failure'); } })).rejects.toThrow('queue failure');
  });

  it('rejects unawaited work and aborts a pending queue call', async () => {
    await expect(run('enqueueWork({key:"a"}); return 0;', { work: () => new Promise(() => {}) })).rejects.toThrow('await every call');
    await expect(run('await workStatus();', { signal: AbortSignal.timeout(30), work: () => new Promise(() => {}) })).rejects.toThrow();
  });

  it('awaits a swarm, permits concurrent producers and cancels an idle wait', async () => {
    let drained!: (value: unknown) => void;
    const work = vi.fn(async (input: unknown) => {
      const call = input as {kind:string};
      if (call.kind === 'swarm') return new Promise(resolve => {drained=resolve;});
      if (call.kind === 'close') drained({completed:15});
      return {ok:true};
    });
    const result = await run('return await parallel([()=>swarm("task",{key:"pool"}),async()=>{await enqueueWork({key:"item"});return await closeWorkQueue({key:"closed"});}]);', {work});
    expect(JSON.parse(result)).toEqual([{completed:15},{ok:true}]);
    expect(work.mock.calls.map(([call])=>(call as {kind:string}).kind)).toEqual(['swarm','enqueue','close']);
    await expect(run('swarm("task",{key:"pool"});return 1;', {work:()=>new Promise(()=>{})})).rejects.toThrow('await every call');
    await expect(run('await swarm("task",{key:"pool",onError:"throw"});', {signal:AbortSignal.timeout(30),work:()=>new Promise(()=>{})})).rejects.toThrow();
  });
});
