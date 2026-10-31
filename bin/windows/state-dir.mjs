import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function defaultWebStateDir(repository, userHome = homedir()) {
  const legacy = join(repository, '.web-local');
  // Existing conversations must remain in the same home after an upgrade.
  if (existsSync(legacy)) return legacy;
  const key = createHash('sha256').update(resolve(repository).toLowerCase()).digest('hex').slice(0, 8);
  return join(userHome, '.lark-web', key);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('repository path is required');
  process.stdout.write(defaultWebStateDir(process.argv[2]));
}
