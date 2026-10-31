// Native workers run this helper only in isolated, opt-in acceptance cases.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const call = (method, args = {}, mutation = true) => JSON.parse(execFileSync(process.execPath,
  [process.env.LARK_WORKFLOW_CLI, 'workflow', method, '--input', JSON.stringify({
    ...(mutation ? {operationId:randomUUID()} : {}), ...args,
  }), '--json'], {encoding:'utf8',timeout:20_000,stdio:['ignore','pipe','pipe']}));
const context = call('read_context', {}, false);
const mode = process.argv[2];
if (mode === 'parent' || mode === 'parent-hold') {
  const prior = context.workflows?.call;
  if (prior?.status === 'completed') {
    assert.equal(context.workflows.checkpoint.stage, 'delegated');
    assert.equal(prior.ok, true);
    console.log(JSON.stringify(prior.result));
  } else {
    assert(!prior || prior.status === 'waiting', 'Child failed');
    const input = JSON.parse(await readFile(join(directory, process.argv[3]), 'utf8'));
    const result = call('run_workflow', input);
    if (mode === 'parent-hold') {
      await new Promise(resolve=>setTimeout(resolve,90_000));
      throw new Error('Controller did not stop the caller before yield');
    }
    console.log(JSON.stringify(result));
  }
} else if (mode === 'leaf') {
  if (context.member.checkpoint?.state.stage === 'armed') {
    console.log(JSON.stringify({marker:context.member.checkpoint.state.marker,recovered:true}));
  } else {
    const marker = process.argv[3];
    call('checkpoint', {expectedCheckpointVersion:0,state:{stage:'armed',marker}});
    await writeFile(join(directory, 'armed.json'), JSON.stringify({pid:process.pid}), {mode:0o600});
    // The controller deliberately interrupts this foreground tool after the checkpoint.
    await new Promise(resolve=>setTimeout(resolve,90_000));
    throw new Error('Controller did not interrupt the leaf');
  }
} else if (mode === 'consume') {
  let count = 0;
  for (;;) {
    const grant = call('claim_work');
    if (!grant) break;
    call('complete_work', {claimId:grant.claimId,generation:grant.generation,result:grant.item.input**2});
    count++;
  }
  console.log(JSON.stringify({completed:count}));
} else {
  throw new Error('Unsupported acceptance helper mode');
}
