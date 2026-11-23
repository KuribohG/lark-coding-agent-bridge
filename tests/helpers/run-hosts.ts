import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { terminateRunHost } from '../../src/agent/run-host';

/**
 * A run host root whose socket paths fit `sun_path`. macOS's temp directory is
 * long enough that `<root>/<key>/sock` overflows it, and a bind past the limit
 * silently truncates the path instead of failing.
 */
export function runHostRootFor(root: string): string {
  const limit = process.platform === 'darwin' ? 103 : 107;
  return join(root, 'x'.repeat(36), 'sock').length <= limit ? root : mkdtempSync(join('/tmp', 'lrh-'));
}

/**
 * Points run hosts at a directory of the test's own. The returned function ends the agents still running under it,
 * which a bridge shutdown leaves there on purpose, and restores the previous directory.
 */
export function isolateRunHosts(dir: string): () => Promise<void> {
  const root = runHostRootFor(dir);
  const previous = process.env.LARK_RUN_HOST_DIR;
  process.env.LARK_RUN_HOST_DIR = root;
  return async () => {
    let keys: string[] = [];
    try { keys = readdirSync(root); } catch { /* no run was hosted */ }
    // Beside each host lies the directory of its files, which goes with it.
    for (const key of keys.filter(name => !name.includes('.'))) await terminateRunHost(key, 500).catch(() => {});
    if (previous === undefined) delete process.env.LARK_RUN_HOST_DIR;
    else process.env.LARK_RUN_HOST_DIR = previous;
    if (root !== dir) rmSync(root, { recursive: true, force: true });
  };
}
