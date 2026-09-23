#!/usr/bin/env node
// Separate from the bridge event loop so a stalled/restarted bridge cannot
// extend the agent's absolute deadline. No shell is used for command input.
import { readdirSync, readFileSync } from 'node:fs';
import crossSpawn from 'cross-spawn';

const [rawDeadline, command, ...args] = process.argv.slice(2);
const stopAt = Number(rawDeadline);
if (!command || !Number.isSafeInteger(stopAt) || stopAt <= Date.now()) process.exit(124);
const bridgePid = process.ppid;
let ending = false;
let exitCode;
const descendants = new Map();
const child = crossSpawn(command, args, {
  detached: process.platform !== 'win32',
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, LARK_RUN_STOP_AT: String(stopAt) },
});

function stat(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');
    return { ppid: Number(fields[1]), start: fields[19] };
  } catch { return undefined; }
}

function collectDescendants() {
  if (process.platform !== 'linux' || !child.pid) return;
  const rows = readdirSync('/proc').filter((p) => /^\d+$/.test(p)).map((p) => [Number(p), stat(p)]);
  const family = new Set([child.pid]);
  let added = true;
  while (added) {
    added = false;
    for (const [pid, info] of rows) {
      if (info && family.has(info.ppid) && !family.has(pid)) {
        family.add(pid);
        descendants.set(pid, info.start);
        added = true;
      }
    }
  }
}

function killTree() {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    crossSpawn.sync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  collectDescendants();
  // Freeze the main group first, then remove descendants that created their
  // own process groups. Check process birth times before touching cached PIDs.
  try { process.kill(-child.pid, 'SIGSTOP'); } catch {}
  for (const [pid, start] of descendants) {
    if (stat(pid)?.start === start) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}

function finish(code) {
  if (ending) return;
  ending = true;
  exitCode = code;
  killTree();
  // The child close event normally drains its pipes. Bound cleanup even when
  // a detached descendant inherited a pipe and refuses to close it.
  setTimeout(() => process.exit(code), 500);
}

process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
// budget_exceeded: LiteLLM-style gateway spend cap (HTTP 400), used by proxied Claude and Codex.
const quotaError = /\binsufficient_quota\b|\bquota_exceeded\b|\bbudget_exceeded\b|budget has been exceeded|credit balance (?:is )?too low|daily (?:quota|budget) (?:is )?(?:exhausted|exceeded)/i;
let stderrTail = '';
child.stderr.on('data', (chunk) => {
  stderrTail = (stderrTail + chunk.toString()).slice(-8192);
  if (!ending && quotaError.test(stderrTail)) {
    process.stderr.write('[bridge-quota] exhausted\n');
    finish(125);
  }
});
let stdoutLine = '';
child.stdout.on('data', (chunk) => {
  stdoutLine += chunk.toString();
  const lines = stdoutLine.split('\n');
  stdoutLine = lines.pop().slice(-65536);
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const failed = event.type === 'error' || event.type === 'turn.failed' ||
        (event.type === 'result' && (event.is_error || event.subtype?.startsWith('error')));
      if (!ending && failed && quotaError.test(line)) {
        process.stderr.write('[bridge-quota] exhausted\n');
        finish(125);
      }
    } catch {}
  }
});
process.stdout.on('error', () => finish(130));
process.stderr.on('error', () => finish(130));
process.on('SIGTERM', () => finish(Date.now() >= stopAt ? 124 : 130));
process.on('SIGINT', () => finish(130));
child.on('error', () => finish(127));
child.on('exit', (code) => finish(exitCode ?? code ?? 1));
child.on('close', () => process.exit(exitCode ?? 1));

// Recheck wall time rather than relying solely on a relative timer across
// clock adjustments or machine sleep. The bridge also checks before spawn.
setInterval(() => {
  if (Date.now() >= stopAt) {
    process.stderr.write('[bridge-deadline] task deadline reached\n');
    finish(124);
  } else {
    if (process.ppid !== bridgePid) finish(130);
    else { try { process.kill(bridgePid, 0); } catch { finish(130); } }
  }
}, 100);
if (process.platform === 'linux') setInterval(collectDescendants, 1000);
