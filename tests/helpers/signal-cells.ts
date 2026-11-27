import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const signalCellLauncher = fileURLToPath(new URL('../../bin/signal-cell', import.meta.url));
const buildScript = fileURLToPath(new URL('../../native/build.mjs', import.meta.url));

/**
 * What `signal-cell --check` says here: 'ok' where a cell confines signals, and 'nested' when the suite itself runs in
 * a cell (a workflow member running the tests). A kernel allows one listener, so a cell made inside another is judged
 * by the outer one's rules and cannot show its own.
 */
export function signalCellSupport(): 'ok' | 'nested' | 'unsupported' {
  if (process.platform !== 'linux') return 'unsupported';
  if (!existsSync(signalCellLauncher)) {
    // Build on demand so `pnpm test` works on a fresh clone.
    try { execFileSync(process.execPath, [buildScript], { stdio: 'ignore' }); } catch { return 'unsupported'; }
  }
  if (!existsSync(signalCellLauncher)) return 'unsupported';
  const said = spawnSync(signalCellLauncher, ['--check'], { encoding: 'utf8' }).stdout.trim();
  return said === 'ok' || said === 'nested' ? said : 'unsupported';
}
