import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter';
import { retryingRun } from '../../src/runtime/retrying-run';
import type { AgentEvent } from '../../src/agent/types';

it('retries a native Claude rate limit with the same session and one authoritative result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-contract-retry-'));
  const binary = join(dir, 'claude.mjs'), record = join(dir, 'calls.json');
  await writeFile(binary, `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const path=${JSON.stringify(record)};
const emit=x=>console.log(JSON.stringify(x));
createInterface({input:process.stdin}).once('line', line=>{
 const input=JSON.parse(line);let calls=[];try{calls=JSON.parse(readFileSync(path,'utf8'));}catch{}
 calls.push({args:process.argv.slice(2),prompt:input.message.content});writeFileSync(path,JSON.stringify(calls));
 emit({type:'system',subtype:'init',session_id:'native-session'});
 if(calls.length===1){
  emit({type:'assistant',message:{id:'work',content:[{type:'tool_use',id:'read',name:'Read',input:{}}]}});
  emit({type:'result',subtype:'error_during_execution',is_error:true,errors:['429 Too Many Requests'],user_message_uuids:[input.uuid]});
 }else{
  emit({type:'assistant',message:{id:'final',content:[{type:'text',text:'ANSWER'}]}});
  emit({type:'result',subtype:'success',result:'ANSWER',session_id:'native-session',user_message_uuids:[input.uuid]});
 }
});
process.stdin.on('end',()=>process.exit(0));
`, { mode: 0o700 });
  vi.useFakeTimers();
  const agent = new ClaudeAdapter({ binary });
  const options = { runId: 'retry', cwd: dir, prompt: 'original' };
  const run = retryingRun({ agent, initialRun: agent.run(options), options, exitGraceMs: 1000, canRetry: () => true });
  try {
    const iterator = run.events[Symbol.asyncIterator]();
    const events: AgentEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error('missing retry');
      events.push(next.value);
      if (next.value.type === 'retry') break;
    }
    const next = iterator.next(); await vi.advanceTimersByTimeAsync(30_000); events.push((await next).value);
    for (;;) { const next = await iterator.next(); if (next.done) break; events.push(next.value); }
    expect(run.capabilities?.input).toBe('active-session');
    expect(events.filter(e => e.type === 'final_text')).toEqual([{ type: 'final_text', content: 'ANSWER' }]);
    expect(events.filter(e => e.type === 'done')).toEqual([{ type: 'done', sessionId: 'native-session', terminationReason: 'normal' }]);
    expect(events.filter(e => e.type === 'error' || e.type === 'text')).toEqual([]);
    const calls = JSON.parse(await readFile(record, 'utf8'));
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toContain('--resume');
    expect(calls[1].args[calls[1].args.indexOf('--resume') + 1]).toBe('native-session');
    expect(calls[1].prompt).toContain('不要重复执行已完成的操作');
    expect(await run.waitForExit(1000)).toBe(true);
  } finally { vi.useRealTimers(); await run.stop(); await rm(dir, { recursive: true, force: true }); }
}, 10_000);
