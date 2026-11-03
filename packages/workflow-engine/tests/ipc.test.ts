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
});
