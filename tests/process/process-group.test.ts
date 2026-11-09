import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { spawnWithDeadline } from '../../src/agent/deadline';
import { spawnProcess } from '../../src/platform/spawn';
import { terminateChild } from '../../src/platform/terminate';

// Prints the PID of a long-lived grandchild, like an agent with an MCP server.
const PARENT = `
const { spawn } = require('node:child_process');
const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log(tool.pid);
setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'; } catch { return true; }
}

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function grandchildOf(child: ReturnType<typeof spawnProcess>): Promise<number> {
  const [chunk] = await once(child.stdout!, 'data') as [Buffer];
  return Number(chunk.toString().trim());
}

describe.skipIf(process.platform === 'win32')('process group termination', () => {
  it('kills an agent spawned for a run together with its descendants', async () => {
    const child = spawnWithDeadline(process.execPath, ['-e', PARENT], { stdio: ['pipe', 'pipe', 'pipe'] });
    const tool = await grandchildOf(child);
    try {
      expect(alive(tool)).toBe(true);
      const closed = once(child, 'close');
      expect(terminateChild(child, 'SIGKILL')).toBe(true);
      await closed;
      await until(() => !alive(tool));
    } finally {
      try { process.kill(tool, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('signals only the child when it shares the bridge process group', async () => {
    const child = spawnProcess(process.execPath, ['-e', PARENT], { stdio: ['pipe', 'pipe', 'pipe'] });
    const tool = await grandchildOf(child);
    try {
      const closed = once(child, 'close');
      expect(terminateChild(child, 'SIGTERM')).toBe(true);
      await closed;
      expect(alive(process.pid)).toBe(true);
    } finally {
      try { process.kill(tool, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
});
