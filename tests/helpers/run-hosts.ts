import { readdirSync } from 'node:fs';
import { terminateRunHost } from '../../src/agent/run-host';

/**
 * Points run hosts at a directory of the test's own. The returned function ends the agents still running under it,
 * which a bridge shutdown leaves there on purpose, and restores the previous directory.
 */
export function isolateRunHosts(dir: string): () => Promise<void> {
  const previous = process.env.LARK_RUN_HOST_DIR;
  process.env.LARK_RUN_HOST_DIR = dir;
  return async () => {
    let keys: string[] = [];
    try { keys = readdirSync(dir); } catch { /* no run was hosted */ }
    // Beside each host lies the directory of its files, which goes with it.
    for (const key of keys.filter(name => !name.includes('.'))) await terminateRunHost(key, 500).catch(() => {});
    if (previous === undefined) delete process.env.LARK_RUN_HOST_DIR;
    else process.env.LARK_RUN_HOST_DIR = previous;
  };
}
