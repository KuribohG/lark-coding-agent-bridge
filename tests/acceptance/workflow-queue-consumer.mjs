// Executed by a native worker only in the opt-in, isolated queue acceptance case.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (method, args = {}, mutation = true) => JSON.parse(execFileSync(process.execPath,
  [process.env.LARK_WORKFLOW_CLI, 'workflow', method, '--input', JSON.stringify({ ...(mutation ? {operationId:randomUUID()} : {}), ...args }), '--json'],
  { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }));
const waitFor = async names => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try { await Promise.all(names.map(name => access(join(directory, name)))); return; }
    catch { await delay(100); }
  }
  throw new Error('Acceptance synchronization deadline exceeded');
};
const member = call('read_context', {}, false).member.member;
assert(['A', 'B', 'C'].includes(member));
if (member !== 'A') await waitFor(['adopt-ready']);
let count = 0;
for (;;) {
  const grant = call('claim_work', {leaseMs:120_000});
  if (!grant) break;
  const token = {claimId:grant.claimId,generation:grant.generation};
  if (member === 'A') {
    call('checkpoint_work', {...token,expectedProgressVersion:grant.item.progress.version,state:{stage:'armed',partial:7}});
    // Intentional foreground suspension for the test controller to interrupt.
    await delay(90_000);
    throw new Error('Controller did not interrupt the armed worker');
  }
  if (count === 0) {
    await writeFile(join(directory, 'claimed-' + member), 'ready', {mode:0o600});
    await waitFor(['claimed-B', 'claimed-C']);
  }
  const inherited = grant.item.progress.state;
  call('checkpoint_work', {...token,expectedProgressVersion:grant.item.progress.version,state:{stage:'computed',inherited}});
  call('complete_work', {...token,result:{square:grant.item.input**2,member,inherited}});
  count++;
}
console.log(JSON.stringify({member,completed:count}));
