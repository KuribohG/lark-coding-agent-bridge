#!/usr/bin/env node
// Stand-in for `ssh`, used by tests/process/pi-sdk-remote.test.ts. It records
// what the bridge asked for, then either keeps the reverse tunnel open or runs
// the remote script on this machine (which is all a shared filesystem needs).
import { appendFileSync, writeFileSync } from 'node:fs';

const recordPath = process.env.FAKE_SSH_RECORD;
const argv = process.argv.slice(2);

function record(entry) {
  if (!recordPath) return;
  writeFileSync(`${recordPath}.${process.pid}.json`, JSON.stringify(entry, null, 2));
}

const tunnel = argv.includes('-N');
if (tunnel) {
  record({ argv, mode: 'tunnel' });
  // Stay alive like a forwarded connection; the bridge kills this on close.
  setInterval(() => {}, 1000);
} else {
  const script = argv.at(-1);
  const destination = argv.at(-2);
  record({ argv, mode: 'exec', destination, script });
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('/bin/bash', ['-c', script], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
