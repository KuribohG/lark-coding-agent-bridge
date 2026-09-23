import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTmpProfile } from '../helpers/tmp-profile';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import { ClaudeAdapter } from '../../src/agent/claude/adapter';
import type { AgentEvent } from '../../src/agent/types';

const guard = fileURLToPath(new URL('../../bin/deadline-guard.mjs', import.meta.url));

describe.skipIf(process.platform !== 'linux')('independent deadline process guard', () => {
  it.each(['codex', 'claude'] as const)('enforces the deadline through the actual %s adapter and stdin', async (kind) => {
    const tmp = await createTmpProfile(`deadline-${kind}-`);
    try {
      const binary = join(tmp.root, 'fake-agent.mjs');
      const pidFile = join(tmp.root, 'agent.json');
      await writeFile(binary, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
        let prompt=''; process.stdin.on('data',chunk=>{prompt+=chunk});
        process.stdin.on('end',()=>writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:process.pid,prompt,deadline:process.env.LARK_RUN_STOP_AT})));
        setInterval(()=>{},1000);
      `, { mode: 0o700 });
      const adapter = kind === 'codex' ? new CodexAdapter({ binary, profileStateDir: tmp.profile }) : new ClaudeAdapter({ binary });
      const deadlineAt = Date.now() + 2000;
      const run = adapter.run({ runId: 'test', prompt: 'deadline <stdin> task', cwd: tmp.workspace, deadlineAt });
      const events: AgentEvent[] = [];
      try { for await (const event of run.events) events.push(event); }
      finally { await run.stop(); }
      const info = JSON.parse(await readFile(pidFile, 'utf8'));
      expect(info.prompt).toContain('deadline <stdin> task');
      expect(Number(info.deadline)).toBe(deadlineAt);
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('124') }));
      expect(await running(info.pid)).toBe(false);
    } finally { await tmp.cleanup(); }
  }, 8000);

  it('recognizes Claude failed-result quota events rather than treating them as completion', async () => {
    const tmp = await createTmpProfile('deadline-claude-quota-');
    try {
      const binary = join(tmp.root, 'fake-agent.mjs');
      await writeFile(binary, `#!${process.execPath}\nconsole.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,errors:['insufficient_quota']}));setInterval(()=>{},1000);`, { mode: 0o700 });
      const run = new ClaudeAdapter({ binary }).run({ runId: 'quota', prompt: 'test', cwd: tmp.workspace, deadlineAt: Date.now() + 4000 });
      const events: AgentEvent[] = [];
      try { for await (const event of run.events) events.push(event); }
      finally { await run.stop(); }
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: 'insufficient_quota' }));
      expect(events.some((event) => event.type === 'done')).toBe(false);
      expect(await run.waitForExit(100)).toBe(true);
    } finally { await tmp.cleanup(); }
  }, 8000);

  it('treats a gateway budget_exceeded Claude result as exhausted quota', async () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: true,
      result: 'API Error: 400 {"error":{"message":"Budget has been exceeded! Current cost: 5, Max budget: 4","type":"budget_exceeded","code":"400"}}' });
    const result = await runGuard(Date.now() + 4000, `console.log(${JSON.stringify(line)}); setInterval(()=>{},1000)`);
    expect(result.code).toBe(125);
    expect(result.err).toContain('[bridge-quota]');
  }, 8000);

  it('rejects an expired task before the command can do any work', async () => {
    const result = await runGuard(Date.now() - 1, "console.log('started')");
    expect(result.code).toBe(124);
    expect(result.out).toBe('');
  });

  it('kills a continuously active process and a descendant in a separate process group', async () => {
    const tmp = await createTmpProfile('deadline-tree-');
    try {
      const pidFile = join(tmp.root, 'pid');
      const childSource = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);";
      const source = `
        const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{detached:true,stdio:'ignore'});
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
        process.on('SIGTERM',()=>{});
        setInterval(()=>console.log('still busy'),20);
      `;
      const result = await runGuard(Date.now() + 1800, source);
      expect(result.code).toBe(124);
      expect(result.out).toContain('still busy');
      const pid = Number(await readFile(pidFile, 'utf8'));
      await vi.waitFor(async () => expect(await running(pid)).toBe(false));
    } finally { await tmp.cleanup(); }
  }, 8000);

  it('stops on explicit exhausted-credit errors but not transient rate limits', async () => {
    const quota = await runGuard(Date.now() + 4000,
      "console.error('API error: insufficient_quota'); setInterval(()=>{},1000)");
    expect(quota.code).toBe(125);
    expect(quota.err).toContain('[bridge-quota]');
    const rate = await runGuard(Date.now() + 1000,
      "console.error('429 rate_limit_exceeded'); setInterval(()=>{},1000)");
    expect(rate.code).toBe(124);
  }, 8000);

  it('survives the bridge process group being killed and cleans up the agent', async () => {
    const tmp = await createTmpProfile('deadline-parent-');
    try {
      const pidFile = join(tmp.root, 'agent-pid');
      const script = join(tmp.root, 'parent.cjs');
      const agentCode = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
      await writeFile(script, `
        const {spawn}=require('node:child_process');
        spawn(process.execPath,[${JSON.stringify(guard)},String(Date.now()+4000),process.execPath,'-e',${JSON.stringify(agentCode)}],{detached:true,stdio:'ignore'});
        setInterval(()=>{},1000);
      `);
      const parent = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
      try {
        await vi.waitFor(async () => expect(Number(await readFile(pidFile, 'utf8'))).toBeGreaterThan(0));
        const exited = new Promise<void>((resolve) => parent.on('exit', () => resolve()));
        process.kill(-parent.pid!, 'SIGKILL');
        await exited;
        const pid = Number(await readFile(pidFile, 'utf8'));
        await vi.waitFor(async () => expect(await running(pid)).toBe(false), { timeout: 2000 });
      } finally {
        if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      }
    } finally { await tmp.cleanup(); }
  }, 8000);
});

async function running(pid: number): Promise<boolean> {
  try { return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1]?.[0] !== 'Z'; }
  catch { return false; }
}

function runGuard(stopAt: number, source: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [guard, String(stopAt), process.execPath, '-e', source]);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.stdin.end();
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}
