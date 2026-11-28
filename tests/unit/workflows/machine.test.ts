import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWorkflowTable, workerSignalCell, workflowTable } from '../../../src/workflows/machine';

describe('the [workflow] table', () => {
  it('reads and writes what it is told about the machine', () => {
    const table = { train_directory: '/tmp/trains', wsfs_state_directory: '~/state', signal_isolation: false };
    const settings = parseWorkflowTable(table);
    expect(settings).toEqual({ trainDirectory: '/tmp/trains', wsfsStateDirectory: '~/state', signalIsolation: false });
    expect(workflowTable(settings)).toEqual(table);
    expect(workflowTable(parseWorkflowTable({}))).toEqual({});
    expect(() => parseWorkflowTable({ signal_isolation: 1 })).toThrow('workflow.signal_isolation: expected boolean');
    expect(() => parseWorkflowTable({ isolate_signals: true })).toThrow('workflow.isolate_signals: unknown setting');
  });

  it('reads the sandbox of the workers as a profile\'s is read', () => {
    const table = { worker_sandbox: { enabled: true, require_landlock: true, allow_tcp: true, read_write: ['/shared/pool', '~/cache'], read_only: [] } };
    const settings = parseWorkflowTable(table);
    expect(settings.workerSandbox).toEqual({ enabled: true, requireLandlock: true, allowTcp: true, readWrite: ['/shared/pool', '~/cache'], readOnly: [] });
    expect(workflowTable(settings)).toEqual(table);
    // What is left out is what a profile's table leaves out: off, TCP open, nothing more to write.
    expect(parseWorkflowTable({ worker_sandbox: {} }).workerSandbox).toEqual({ enabled: false, requireLandlock: false, allowTcp: true, readWrite: [], readOnly: [] });
    expect(() => parseWorkflowTable({ worker_sandbox: true })).toThrow('workflow.worker_sandbox: expected a table');
    expect(() => parseWorkflowTable({ worker_sandbox: { enable: true } })).toThrow('workflow.worker_sandbox.enable: unknown setting');
    expect(() => parseWorkflowTable({ worker_sandbox: { read_write: ['relative'] } })).toThrow(/^workflow\.worker_sandbox: .*read_write: expected an absolute or ~\/ path/);
  });
});

describe('workerSignalCell', () => {
  it('gives every worker session a cell of its own unless the table turns that off', () => {
    const cell = { id: 'workflow:w:s1', log: join('/state', 'signal-cell.log') };
    expect(workerSignalCell(undefined, 'workflow:w:s1', '/state', true)).toEqual(cell);
    expect(workerSignalCell({ trainDirectory: '/tmp/trains' }, 'workflow:w:s1', '/state', true)).toEqual(cell);
    expect(workerSignalCell({ signalIsolation: true }, 'workflow:w:s1', '/state', true)).toEqual(cell);
    expect(workerSignalCell(undefined, 'workflow:w:s2', '/state', true)?.id).toBe('workflow:w:s2');
    expect(workerSignalCell({ signalIsolation: false }, 'workflow:w:s1', '/state', true)).toBeUndefined();
  });

  it('gives none where the machine cannot make one', () => {
    expect(workerSignalCell(undefined, 'workflow:w:s1', '/state', false)).toBeUndefined();
  });
});
