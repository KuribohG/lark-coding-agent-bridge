import { describe, expect, it, vi } from 'vitest';
import { runScriptProgram, WorkflowAgentFailure } from '../src/engine/script-vm';

const source = 'return await speculativeAgent("Implement the spec",{key:"impl",gate:{prompt:"Full model check of spec v1 passes",model:"gate-model"},repair:{prompt:"Repair the spec",member:"spec/author"},worker:{model:"worker-model"},...args});';
const pass = { ok: true, reason: 'All cases pass', evidence: ['run.sh exited 0'] };
const reject = { ok: false, reason: 'Invariant RLEN violated', evidence: ['FAIL_S counterexample'] };

type Call = Record<string, unknown>;
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

/** Agent and control hosts whose results the test releases in a chosen order. */
function host() {
  const events: string[] = [];
  const results = new Map<string, ReturnType<typeof deferred<unknown>>>();
  const result = (key: string) => { if (!results.has(key)) results.set(key, deferred()); return results.get(key)!; };
  const tasks = new Map<string, string>();
  const agentCalls: Call[] = [];
  const controlCalls: Call[] = [];
  const agent = vi.fn(async (input: unknown) => {
    const call = input as Call;
    agentCalls.push(call);
    events.push('agent ' + String(call.key));
    return result(String(call.key)).promise;
  });
  const control = vi.fn(async (input: unknown) => {
    const call = input as Call;
    controlCalls.push(call);
    if (call.kind === 'start') {
      const taskId = 'task-' + String(call.key);
      tasks.set(taskId, String(call.key));
      events.push('start ' + String(call.key));
      return { taskId, output: 'json' };
    }
    const key = tasks.get(String(call.taskId))!;
    if (call.kind === 'cancel') {
      events.push('cancel ' + key);
      result(key).reject(new Error('Agent ' + key + ' is cancelled'));
      return { kind: 'cancel', taskId: call.taskId };
    }
    const value = await result(key).promise;
    events.push('joined ' + key);
    return value;
  });
  const progress = vi.fn();
  const run = (args: unknown = {}, program = source) => runScriptProgram({ source: program, args, signal: AbortSignal.timeout(5000), agent, control, progress });
  const settle = (key: string, value: unknown) => result(key).resolve(value);
  const fail = (key: string, message: string) => result(key).reject(new WorkflowAgentFailure(message));
  const started = (key: string) => vi.waitFor(() => expect(events).toContain(key), { timeout: 2000, interval: 5 });
  return { events, agentCalls, controlCalls, agent, control, progress, run, settle, fail, started };
}

describe('speculative agent composition', () => {
  it('starts work beside the gate, repairs a rejected premise during the running turn and returns gated rework', async () => {
    const h = host();
    const result = h.run();
    await h.started('agent impl/work/1');
    expect(h.events).toEqual(['start impl/gate/1', 'agent impl/work/1']);
    h.settle('impl/gate/1', reject);
    await h.started('agent impl/repair/1');
    // The repair overlaps the speculative turn, which has not finished yet.
    expect(h.events).not.toContain('agent impl/work/2');
    h.settle('impl/repair/1', 'spec v2: RLEN fixed');
    h.settle('impl/work/1', 'impl-v1');
    await h.started('agent impl/work/2');
    h.settle('impl/work/2', 'impl-v2');
    h.settle('impl/gate/2', pass);
    expect(JSON.parse(await result)).toEqual({ value: 'impl-v2', gate: pass, rounds: 2 });

    const byKey = Object.fromEntries([...h.agentCalls, ...h.controlCalls.filter(call => call.kind === 'start')].map(call => [call.key, call]));
    expect(byKey['impl/gate/1']).toMatchObject({ model: 'gate-model', schema: { required: ['ok', 'reason', 'evidence'] } });
    expect(byKey['impl/gate/1']).not.toHaveProperty('inputs');
    expect(byKey['impl/gate/2']).toMatchObject({ inputs: ['impl/repair/1'] });
    expect(String(byKey['impl/gate/2']!.prompt)).toContain('Full model check of spec v1 passes');
    expect(byKey['impl/work/1']).toMatchObject({ member: 'impl/worker', model: 'worker-model' });
    expect(byKey['impl/work/1']).not.toHaveProperty('inputs');
    expect(String(byKey['impl/work/1']!.prompt)).toContain('Do not publish, push, merge');
    expect(byKey['impl/work/2']).toMatchObject({ member: 'impl/worker', inputs: ['impl/gate/1', 'impl/repair/1'] });
    expect(String(byKey['impl/work/2']!.prompt)).toContain('Invariant RLEN violated');
    expect(String(byKey['impl/work/2']!.prompt)).not.toContain('FAIL_S counterexample');
    expect(byKey['impl/repair/1']).toMatchObject({ member: 'spec/author', inputs: ['impl/gate/1'] });
    expect(String(byKey['impl/repair/1']!.prompt)).toContain('Repair the spec');
    expect(h.controlCalls.some(call => call.kind === 'cancel')).toBe(false);
  });

  it('waits for the speculative work when the gate passes first', async () => {
    const h = host();
    const result = h.run();
    await h.started('agent impl/work/1');
    h.settle('impl/gate/1', pass);
    await h.started('joined impl/gate/1');
    h.settle('impl/work/1', 'impl-v1');
    expect(JSON.parse(await result)).toEqual({ value: 'impl-v1', gate: pass, rounds: 1 });
    expect(h.agentCalls.map(call => call.key)).toEqual(['impl/work/1']);
  });

  it('cancels a pending gate when the worker fails', async () => {
    const h = host();
    const result = h.run({ onError: 'throw' });
    await h.started('agent impl/work/1');
    h.fail('impl/work/1', 'Build failed');
    await expect(result).rejects.toThrow('Build failed');
    expect(h.controlCalls.find(call => call.kind === 'cancel')).toMatchObject({ key: 'impl/cancel/1', taskId: 'task-impl/gate/1' });

    const soft = host();
    const value = soft.run();
    await soft.started('agent impl/work/1');
    soft.fail('impl/work/1', 'Build failed');
    expect(JSON.parse(await value)).toBeNull();
    expect(soft.progress).toHaveBeenCalledWith('log', expect.stringContaining('speculativeAgent impl failed; returning null: Build failed'));
  });

  it.each([{ ok: true, reason: 'Fine', evidence: [] }, { ok: 'yes', reason: 'Fine', evidence: ['x'] }, { ok: false, reason: ' ', evidence: [] }, null])(
    'fails closed for an invalid gate decision: %j', async decision => {
      const h = host();
      const result = h.run({ onError: 'throw' });
      await h.started('agent impl/work/1');
      h.settle('impl/gate/1', decision);
      h.settle('impl/work/1', 'impl-v1');
      await expect(result).rejects.toThrow('Invalid gate decision');
      expect(h.agentCalls.map(call => call.key)).toEqual(['impl/work/1']);
    });

  it('bounds rounds and settles every started call before failing', async () => {
    const h = host();
    const result = h.run({ maxRounds: 2, onError: 'throw' });
    await h.started('agent impl/work/1');
    h.settle('impl/gate/1', reject);
    await h.started('agent impl/repair/1');
    h.settle('impl/repair/1', 'spec v2');
    h.settle('impl/work/1', 'impl-v1');
    await h.started('agent impl/work/2');
    h.settle('impl/gate/2', { ...reject, reason: 'Still violated' });
    await h.started('joined impl/gate/2');
    // The last speculative turn is still awaited before the helper fails.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.events.at(-1)).toBe('joined impl/gate/2');
    h.settle('impl/work/2', 'impl-v2');
    await expect(result).rejects.toThrow('Gate did not pass after 2 rounds: Still violated');
    expect(h.agentCalls.map(call => call.key)).toEqual(['impl/work/1', 'impl/repair/1', 'impl/work/2']);
  });

  it('reports a failed repair only after the speculative turn settles', async () => {
    const h = host();
    const result = h.run({ onError: 'throw' });
    await h.started('agent impl/work/1');
    h.settle('impl/gate/1', reject);
    await h.started('agent impl/repair/1');
    h.fail('impl/repair/1', 'Repair could not converge');
    await new Promise(resolve => setTimeout(resolve, 20));
    h.settle('impl/work/1', 'impl-v1');
    await expect(result).rejects.toThrow('Repair could not converge');
  });

  it('rejects invalid policies before starting any work', async () => {
    const h = host();
    for (const program of [
      'return await speculativeAgent("x",{key:"impl",gate:{prompt:"check"},maxRounds:2});',
      'return await speculativeAgent("x",{key:"impl",gate:{prompt:"check"},repair:{prompt:"fix",member:"impl/worker"}});',
      'return await speculativeAgent("x",{key:"impl",gate:{prompt:""}});',
      'return await speculativeAgent("x",{key:"impl",gate:{prompt:"check",member:"gate"}});',
      'return await speculativeAgent("x",{key:"impl",gate:{prompt:"check"},repair:{prompt:"fix"},maxRounds:5});',
      'return await speculativeAgent("x",{key:"@impl",gate:{prompt:"check"}});',
      'return await speculativeAgent("x",{key:"impl",gate:{prompt:"check"},reviewer:{}});',
    ]) await expect(h.run({}, program)).rejects.toThrow();
    expect(h.agent).not.toHaveBeenCalled();
    expect(h.control).not.toHaveBeenCalled();
  });
});
