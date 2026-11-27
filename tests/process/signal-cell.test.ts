import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnWithDeadline } from '../../src/agent/deadline';
import { signalCellLauncher as launcher, signalCellSupport } from '../helpers/signal-cells';

const supported = signalCellSupport();
let serial = 0;
const cellId = (label: string) => `test:${process.pid}:${label}:${++serial}`;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)?.[0] !== 'Z'; } catch { return false; }
}

function parentOf(pid: number): { pid: number; name: string } {
  const parent = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[1]);
  return { pid: parent, name: readFileSync(`/proc/${parent}/comm`, 'utf8').trim() };
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** Runs a shell script in a cell and returns what it printed. */
function inCell(cell: string, script: string, options: { env?: Record<string, string>; log?: string; input?: string } = {}) {
  return spawnSync(launcher, ['--cell', cell, ...(options.log ? ['--log', options.log] : []), '--', 'bash', '-c', script], {
    encoding: 'utf8', env: { ...process.env, ...options.env }, ...(options.input !== undefined ? { input: options.input } : {}),
  });
}

describe.skipIf(supported !== 'ok')('signal-cell', () => {
  const outside: ChildProcess[] = [];
  const leftovers: number[] = [];
  /** A process of this test, as another workflow member's would be: outside every cell, leading its own group. */
  const bystander = (): number => {
    const child = spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
    outside.push(child);
    return child.pid!;
  };
  afterEach(() => {
    for (const child of outside.splice(0)) child.kill('SIGKILL');
    for (const pid of leftovers.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  });

  it('ends the way its command did and leaves the standard streams alone', () => {
    const copied = inCell(cellId('io'), 'cat; echo to-stderr >&2; exit 7', { input: 'through' });
    expect(copied.status).toBe(7);
    expect(copied.stdout).toBe('through');
    expect(copied.stderr).toContain('to-stderr\n');
    expect(inCell(cellId('signal'), 'kill -TERM $$').signal).toBe('SIGTERM');
    expect(spawnSync(launcher, ['--cell', cellId('missing'), '--', '/nonexistent/command']).status).toBe(127);
  });

  it('lets a process signal the cell it is in and nothing outside it', () => {
    const victim = bystander();
    const log = join(mkdtempSync(join(tmpdir(), 'signal-cell-')), 'denied.log');
    try {
      const result = inCell(cellId('deny'), `
        sleep 300 & own=$!
        kill $own; wait $own; echo own=$?
        kill -9 $VICTIM 2>/dev/null; echo process=$?
        kill -9 -- -$VICTIM 2>/dev/null; echo group=$?
        kill -9 -- -1 2>/dev/null; echo everyone=$?
        kill -0 $VICTIM; echo probe=$?
        # A group whose leader has exited is still the cell's own.
        setsid bash -c 'sleep 300 & sleep 0.1' & leader=$!
        wait $leader; kill -- -$leader; echo leaderless=$?
        sleep 300 & sleep 300 &
        kill -TERM 0; echo unreachable
      `, { env: { VICTIM: String(victim) }, log });
      expect(result.stdout.trim().split('\n')).toEqual(['own=143', 'process=1', 'group=1', 'everyone=1', 'probe=0', 'leaderless=0']);
      // `kill 0` reached the shell's own group, the shell included, and nobody else.
      expect(result.signal).toBe('SIGTERM');
      expect(alive(victim)).toBe(true);
      const denied = readFileSync(log, 'utf8').trim().split('\n');
      expect(denied).toHaveLength(3);
      expect(denied[0]).toMatch(new RegExp(`cell=test:\\S+ denied pid=\\d+ \\(bash\\) kill target=${victim} \\(sleep\\) signal=9$`));
    } finally {
      rmSync(join(log, '..'), { recursive: true, force: true });
    }
  });

  it('keeps a detached job in the cell, for a later run of the same cell to stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signal-cell-'));
    const cell = cellId('member');
    try {
      // The subshell exits at once, which leaves the job an orphan, as `setsid nohup job &` does in an agent's shell.
      const started = inCell(cell, `(setsid bash -c 'echo $$ > ${dir}/pid; exec sleep 300' >/dev/null 2>&1 &)
        while [ ! -s ${dir}/pid ]; do sleep 0.02; done`);
      expect(started.status).toBe(0);
      const job = Number(readFileSync(join(dir, 'pid'), 'utf8'));
      leftovers.push(job);
      expect(alive(job)).toBe(true);
      const supervisor = parentOf(job);
      expect(supervisor.name).toBe('cell-supervisor');

      const stranger = inCell(cellId('other'), `kill ${job} 2>/dev/null; echo job=$?; kill ${supervisor.pid} 2>/dev/null; echo supervisor=$?`);
      expect(stranger.stdout).toBe('job=1\nsupervisor=1\n');
      expect(alive(job)).toBe(true);

      // Its own member may stop the job, and never the supervisor that holds the cell together.
      const later = inCell(cell, `kill ${supervisor.pid} 2>/dev/null; echo supervisor=$?; kill ${job}; echo job=$?`);
      expect(later.stdout).toBe('supervisor=1\njob=0\n');
      await until(() => !alive(job));
      // With nothing left in the cell, its supervisor goes too.
      await until(() => !alive(supervisor.pid));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes a signal sent to it on to the command', async () => {
    const child = spawn(launcher, ['--cell', cellId('forward'), '--', 'bash', '-c',
      'trap "echo stopping; exit 5" TERM; echo ready; while :; do sleep 0.05; done'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    await until(() => output.includes('ready'));
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    expect(code).toBe(5);
    expect(output).toContain('stopping');
  });

  it('ends the command when the process that was holding the run is killed', async () => {
    const child = spawn(launcher, ['--cell', cellId('orphaned'), '--', 'bash', '-c', 'echo $$; exec sleep 300'],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    const [chunk] = await once(child.stdout, 'data') as [Buffer];
    const command = Number(String(chunk).trim());
    leftovers.push(command);
    expect(alive(command)).toBe(true);
    child.kill('SIGKILL');
    await until(() => !alive(command));
  });

  it('ends the command when whoever started the run is gone', async () => {
    // The shell stands for a run host that is killed: nobody is left to stop the run it was holding.
    const holder = spawn('bash', ['-c', `${launcher} --cell ${cellId('unheld')} -- bash -c 'echo $$; exec sleep 300' & wait`],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    const [chunk] = await once(holder.stdout, 'data') as [Buffer];
    const command = Number(String(chunk).trim());
    leftovers.push(command);
    expect(alive(command)).toBe(true);
    holder.kill('SIGKILL');
    await until(() => !alive(command));
  });

  it('applies the outer cell to a cell started inside it', () => {
    const victim = bystander();
    const nested = inCell(cellId('outer'), `${launcher} --check; echo check=$?
      ${launcher} --cell ${cellId('inner')} -- bash -c 'sleep 300 & kill $!; wait $!; echo own=$?; kill -9 ${victim} 2>/dev/null; echo outside=$?'`);
    expect(nested.stdout).toBe('nested\ncheck=3\nown=143\noutside=1\n');
    expect(alive(victim)).toBe(true);
  });

  it('holds the deadline watchdog and the agent it guards in one cell', async () => {
    const victim = bystander();
    const dir = mkdtempSync(join(tmpdir(), 'signal-cell-'));
    // An agent with a tool still running and a job it detached; it then tries to stop someone else's process.
    const agent = `
      setsid bash -c 'echo $$ > ${dir}/tool; exec sleep 300' &
      (setsid bash -c 'echo $$ > ${dir}/job; exec sleep 300' >/dev/null 2>&1 &)
      while [ ! -s ${dir}/tool ] || [ ! -s ${dir}/job ]; do sleep 0.02; done
      kill -9 ${victim} 2>/dev/null; echo denied=$?
      sleep 300`;
    const child = spawnWithDeadline('bash', ['-c', agent], { stdio: ['pipe', 'pipe', 'pipe'] }, Date.now() + 60_000,
      { signalCell: { id: cellId('guarded') } });
    try {
      const [chunk] = await once(child.stdout!, 'data') as [Buffer];
      expect(String(chunk)).toBe('denied=1\n');
      const tool = Number(readFileSync(join(dir, 'tool'), 'utf8')), job = Number(readFileSync(join(dir, 'job'), 'utf8'));
      leftovers.push(tool, job);
      // Long enough for the watchdog to have seen the tool among the agent's descendants.
      await new Promise(resolve => setTimeout(resolve, 1500));
      const closed = once(child, 'close');
      process.kill(-child.pid!, 'SIGTERM');
      await closed;
      // The watchdog ends what was still attached to the agent; the detached job is the cell's to keep.
      await until(() => !alive(tool));
      expect(alive(job)).toBe(true);
      expect(parentOf(job).name).toBe('cell-supervisor');
      expect(alive(victim)).toBe(true);
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== 'linux')('signal-cell --check', () => {
  it('says whether this kernel can confine signals', () => {
    expect(['ok', 'nested', 'unsupported']).toContain(supported);
  });
});
