import { describe, expect, it, vi } from 'vitest';
import { runScriptProgram } from '../../../src/workflows/engine/script-vm';

const source = 'return await reviewedAgent("Fix the parser",{key:"parser",criteria:"Regression test passes",worker:{harness:"codex",model:"worker-model"},reviewer:{harness:"codex",model:"review-model"},...args});';
const run = (agent: (input: unknown) => Promise<unknown>, args: unknown = {}, program = source) => runScriptProgram({
  source: program, args, signal: AbortSignal.timeout(5000), agent, progress: () => {},
});

describe('reviewed agent composition', () => {
  it('feeds an independent rejection back to the same worker and only returns accepted work', async () => {
    const results: unknown[] = ['candidate-v1', {ok:false,reason:'Boundary case fails',evidence:['case empty-input failed']},
      'candidate-v2', {ok:true,reason:'The fix satisfies the criteria',evidence:['case empty-input passed']}];
    const agent=vi.fn(async (_:unknown)=>results.shift());
    expect(JSON.parse(await run(agent))).toMatchObject({value:'candidate-v2',rounds:2,review:{ok:true}});
    const calls=agent.mock.calls.map(([input])=>input as Record<string,unknown>);
    expect(calls.map(call=>call.key)).toEqual(['parser/work/1','parser/review/1','parser/work/2','parser/review/2']);
    expect(calls[0]).toMatchObject({member:'parser/worker',model:'worker-model'});
    expect(calls[2]).toMatchObject({member:'parser/worker',model:'worker-model'});
    expect(String(calls[2]!.prompt)).toContain('Boundary case fails');
    expect(calls[1]).toMatchObject({model:'review-model',output:'json'});
    expect(calls[1]).not.toHaveProperty('member');expect(calls[3]).not.toHaveProperty('member');
  });

  it.each([{ok:true,reason:'Looks fine',evidence:[]},{ok:'yes',reason:'Fine',evidence:['test']},
    {ok:false,reason:'',evidence:[]},null])('fails closed for an invalid review decision: %j', async decision => {
    let count=0;
    await expect(run(async ()=>++count===1?'candidate':decision)).rejects.toThrow('Invalid independent review decision');
    expect(count).toBe(2);
  });

  it('bounds rework and propagates reviewer execution failures', async () => {
    let count=0;
    await expect(run(async ()=>++count%2?'candidate':{ok:false,reason:'Test failed',evidence:['failure']} ,{maxRounds:2}))
      .rejects.toThrow('did not pass after 2 rounds');
    expect(count).toBe(4);
    count=0;
    await expect(run(async ()=>{if(++count===2)throw new Error('Reviewer unavailable');return 'candidate';}))
      .rejects.toThrow('Reviewer unavailable');
    expect(count).toBe(2);
  });

  it('rejects invalid policies before creating workers and permits independent pairs in parallel', async () => {
    const agent=vi.fn(async (input:unknown)=>(input as {output?:string}).output==='json'
      ? {ok:true,reason:'Verified',evidence:['test passed']}:'candidate');
    for(const args of [{maxRounds:5},{reviewer:{member:'same-worker'}},{criteria:''}]) await expect(run(agent,args)).rejects.toThrow();
    expect(agent).not.toHaveBeenCalled();
    const result=await run(agent,{},'return await parallel(["a","b"].map(key=>()=>reviewedAgent(key,{key,criteria:"Check evidence"})));');
    expect(JSON.parse(result)).toHaveLength(2);expect(agent).toHaveBeenCalledTimes(4);
  });
});
