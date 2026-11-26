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
/** In Git's place, a process that ends as a test wants a Git command to have ended. */
const ENDINGS = {
  /** Fails and says why. */
  fails: 'process.stderr.write("no space left on device\\n"); process.exit(1)',
  /** Is killed before it can say anything. */
  killed: 'process.kill(process.pid, "SIGKILL"); setInterval(() => {}, 1000)',
  /** Says it succeeded and has done nothing. */
  idle: 'process.exit(0)',
};
/** Git commands a test holds back until it lets them go, has end badly, or only counts. */
export function gate(dir: string) {
  const flag = join(dir, 'release-' + randomUUID());
  let held: Chosen = () => false, broken: Chosen = () => false, ending: keyof typeof ENDINGS = 'fails';
  const ran: string[][] = [], where: string[] = [];
  const processes: WorkflowProcesses = { ...nodeProcesses, spawn: (command, args, options) => {
    if (command !== 'git') return nodeProcesses.spawn(command, args, options);
    ran.push([...args]); where.push(String(options.cwd));
    if (broken(args, String(options.cwd))) return nodeProcesses.spawn(process.execPath, ['-e', ENDINGS[ending]], options);
    if (held(args, String(options.cwd))) return nodeProcesses.spawn(process.execPath, ['-e', HELD, flag, ...args], options);
    return nodeProcesses.spawn(command, args, options);
  } };
  return { processes, ran,
    /** The commands that ran in `cwd`. */
    in: (cwd: string) => ran.filter((_, at) => where[at] === cwd),
    hold(chosen: Chosen) { held = chosen; }, fail(chosen: Chosen, how: keyof typeof ENDINGS = 'fails') { broken = chosen; ending = how; }, release: () => writeFile(flag, '') };
}
/** The commands that write a checkout's files. */
export const writes: Chosen = args => args.includes('read-tree') || args.includes('checkout-index');
