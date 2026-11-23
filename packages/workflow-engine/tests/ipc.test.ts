import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWorkflow, WorkflowIpc } from '../src/engine/ipc';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe('workflow IPC', () => {
  it('authenticates from a per-run binding, ignores forged scope args, and revokes at turn end', async () => {
    const call = vi.fn(async (caller, method, args) => ({ caller, method, args }));
    const ipc = new WorkflowIpc(call); await ipc.listen(); cleanup.push(() => ipc.close());
    const binding = ipc.bind({ kind: 'main', scopeId: 'authorized-topic' }, Date.now() + 60_000);
    const response = await callWorkflow('status', { scopeId: 'other-topic', kind: 'main' }, binding.env);
    expect(response).toMatchObject({ caller: { kind: 'main', scopeId: 'authorized-topic' } });
    binding.release();
    await expect(callWorkflow('status', {}, binding.env)).rejects.toThrow('revoked');
    expect(call).toHaveBeenCalledTimes(1);
    const expired = ipc.bind({ kind: 'main', scopeId: 'authorized-topic' }, Date.now() - 1);
    await expect(callWorkflow('status', {}, expired.env)).rejects.toThrow('expired');
  });

  it('has a caller that outlives the controller repeat its call until the next controller has bound its token again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-ipc-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const endpointFile = join(dir, 'endpoint.json');
    const first = new WorkflowIpc(async () => 'first', undefined, endpointFile); await first.listen();
    const binding = first.bind({ kind: 'worker', scopeId: 'topic', workflowId: 'w', taskId: 't', attemptId: 'a' }, Date.now() + 60_000);
    expect(await callWorkflow('read_context', {}, binding.env)).toBe('first');
    await first.close();

    const waits: string[] = [];
    const pending = callWorkflow('read_context', {}, binding.env, { onWait: reason => waits.push(reason) });
    await new Promise(resolve => setTimeout(resolve, 400));
    // The next controller listens elsewhere and knows the token only as one it has yet to bind.
    let bound = false;
    const second = new WorkflowIpc(async () => 'second', undefined, endpointFile, hash => !bound && hash === binding.tokenHash);
    await second.listen(); cleanup.push(() => second.close());
    await new Promise(resolve => setTimeout(resolve, 700));
    second.bind({ kind: 'worker', scopeId: 'topic', workflowId: 'w', taskId: 't2', attemptId: 'a2' }, Date.now() + 60_000, binding.tokenHash);
    bound = true;
    expect(await pending).toBe('second');
    expect(waits).toHaveLength(1);
    // A token nobody is going to bind is refused at once.
    await expect(callWorkflow('read_context', {}, { ...binding.env, AGENT_WORKFLOW_TOKEN: 'f'.repeat(64) })).rejects.toThrow('revoked');
  });

  it('gives up on a controller that does not come back, and does not wait for one that has no successor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-ipc-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const published = new WorkflowIpc(async () => 'ok', undefined, join(dir, 'endpoint.json')); await published.listen();
    const kept = published.bind({ kind: 'main', scopeId: 'topic' }, Date.now() + 60_000);
    await published.close();
    const started = Date.now();
    await expect(callWorkflow('status', {}, kept.env, { restartWaitMs: 600 })).rejects.toThrow();
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    const plain = new WorkflowIpc(async () => 'ok'); await plain.listen();
    const lost = plain.bind({ kind: 'main', scopeId: 'topic' }, Date.now() + 60_000);
    await plain.close();
    const again = Date.now();
    await expect(callWorkflow('status', {}, lost.env)).rejects.toThrow();
    expect(Date.now() - again).toBeLessThan(2000);
  });

  it('answers a long call it cannot finish with a request to repeat it when it closes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-ipc-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const endpointFile = join(dir, 'endpoint.json');
    let entered!: () => void; const running = new Promise<void>(resolve => { entered = resolve; });
    const first = new WorkflowIpc(() => { entered(); return new Promise(() => {}); }, undefined, endpointFile); await first.listen();
    const binding = first.bind({ kind: 'worker', scopeId: 'topic', workflowId: 'w', taskId: 't', attemptId: 'a' }, Date.now() + 60_000);
    const pending = callWorkflow('submit_work', { operationId: 'land' }, binding.env);
    await running;
    // The work never ends, and the service still closes, without waiting for the caller to drop its connection.
    const closing = Date.now();
    await first.close();
    expect(Date.now() - closing).toBeLessThan(2000);
    const second = new WorkflowIpc(async (_caller, method, args) => ({ method, args }), undefined, endpointFile); await second.listen(); cleanup.push(() => second.close());
    second.bind({ kind: 'worker', scopeId: 'topic', workflowId: 'w', taskId: 't', attemptId: 'a2' }, Date.now() + 60_000, binding.tokenHash);
    expect(await pending).toEqual({ method: 'submit_work', args: { operationId: 'land' } });
  });
});
