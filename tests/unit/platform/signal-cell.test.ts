import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSignalCellCommand, signalCellsAvailable } from '../../../src/platform/signal-cell';

const scratch: string[] = [];
function fakeLauncher(): string {
  const dir = mkdtempSync(join(tmpdir(), 'signal-cell-'));
  scratch.push(dir);
  const path = join(dir, 'signal-cell');
  writeFileSync(path, '');
  return path;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('buildSignalCellCommand', () => {
  it('starts the command through the launcher, with the cell ID ahead of everything else', () => {
    const launcher = fakeLauncher();
    expect(buildSignalCellCommand('agent', ['--flag', 'value'], { cell: { id: 'workflow:w1:s1' }, platform: 'linux', launcher }))
      .toEqual({ command: launcher, args: ['--cell', 'workflow:w1:s1', '--', 'agent', '--flag', 'value'] });
    expect(buildSignalCellCommand('agent', [], { cell: { id: 'c', log: '/state/signal-cell.log' }, platform: 'linux', launcher }).args)
      .toEqual(['--cell', 'c', '--log', '/state/signal-cell.log', '--', 'agent']);
  });

  it('leaves the command as it is without a cell, off Linux, or without the launcher', () => {
    const launcher = fakeLauncher();
    const plain = { command: 'agent', args: ['x'] };
    expect(buildSignalCellCommand('agent', ['x'], { cell: undefined, platform: 'linux', launcher })).toEqual(plain);
    expect(buildSignalCellCommand('agent', ['x'], { cell: { id: 'c' }, platform: 'darwin', launcher })).toEqual(plain);
    expect(buildSignalCellCommand('agent', ['x'], { cell: { id: 'c' }, platform: 'win32', launcher })).toEqual(plain);
    expect(buildSignalCellCommand('agent', ['x'], { cell: { id: 'c' }, platform: 'linux', launcher: '/nonexistent/signal-cell' })).toEqual(plain);
  });

  it('is available on Linux once the launcher is built', () => {
    const launcher = fakeLauncher();
    expect(signalCellsAvailable({ platform: 'linux', launcher })).toBe(true);
    expect(signalCellsAvailable({ platform: 'darwin', launcher })).toBe(false);
    expect(signalCellsAvailable({ platform: 'linux', launcher: '/nonexistent/signal-cell' })).toBe(false);
  });
});
