import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nodeProcesses } from '../../src/engine/workspace-process';
import type { WorkflowProcesses } from '../../src/engine/ports';

/** Runs Git once a file exists, in Git's place: how a test keeps the files of a worktree from being written yet. */
const HELD = `const fs = require('fs'), cp = require('child_process');
const [flag, ...argv] = process.argv.slice(1);
const timer = setInterval(() => {
  if (!fs.existsSync(flag)) return;
  clearInterval(timer);
  process.exit(cp.spawnSync('git', argv, { stdio: 'inherit' }).status ?? 1);
}, 20);`;
type Chosen = (args: readonly string[], cwd: string) => boolean;
/** Git commands a test holds back until it lets them go, fails, or only counts. */
export function gate(dir: string) {
  const flag = join(dir, 'release-' + randomUUID());
  let held: Chosen = () => false, broken: Chosen = () => false;
  const ran: string[][] = [];
  const processes: WorkflowProcesses = { ...nodeProcesses, spawn: (command, args, options) => {
    if (command !== 'git') return nodeProcesses.spawn(command, args, options);
    ran.push([...args]);
    if (broken(args, String(options.cwd))) return nodeProcesses.spawn(process.execPath, ['-e', 'process.stderr.write("no space left on device\\n"); process.exit(1)'], options);
    if (held(args, String(options.cwd))) return nodeProcesses.spawn(process.execPath, ['-e', HELD, flag, ...args], options);
    return nodeProcesses.spawn(command, args, options);
  } };
  return { processes, ran, hold(chosen: Chosen) { held = chosen; }, fail(chosen: Chosen) { broken = chosen; }, release: () => writeFile(flag, '') };
}
/** The commands that write a checkout's files. */
export const writes: Chosen = args => args.includes('read-tree') || args.includes('checkout-index');
