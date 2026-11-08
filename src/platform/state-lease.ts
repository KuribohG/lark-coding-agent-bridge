import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as lockfile from 'proper-lockfile';

/** Exclusive lease on a state folder; a compromised lease asks the owner to stop writing. */
export async function acquireStateLease(folder: string, onCompromised: () => void): Promise<() => Promise<void>> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const lease = join(folder, 'service');
  await writeFile(lease, '', { flag: 'a', mode: 0o600 });
  return lockfile.lock(lease, { stale: 60_000, update: 10_000, retries: 0, onCompromised });
}
