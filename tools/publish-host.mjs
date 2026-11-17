import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function publishHost(output, destination, files, { rename = fs.renameSync } = {}) {
// Reuse byte-identical native addons, and publish the manifest last. This also repairs an interrupted old-style build.
const changed = Object.keys(files).filter(relative => {
  const target = path.join(destination, relative);
  return !fs.existsSync(target) || sha(fs.readFileSync(target)) !== files[relative].sha256;
});
for (const relative of changed) if (relative.endsWith('.node') && fs.existsSync(path.join(destination, relative)))
  throw new Error(`Native addon changed: stop owners before replacing ${relative}. The staged build was preserved at ${output}`);
const prior = new Map();
const put = (relative, bytes) => {
  const target = path.join(destination, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.build-tmp`;
  try { fs.writeFileSync(temporary, bytes, { flag: 'wx' }); rename(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
};
try {
  for (const relative of [...changed, 'manifest.json']) {
    const target = path.join(destination, relative);
    const before = fs.existsSync(target) ? fs.readFileSync(target) : null;
    put(relative, fs.readFileSync(path.join(output, relative)));
    prior.set(relative, before);
  }
} catch (error) {
  const rollbackFailures = [];
  for (const [relative, bytes] of [...prior].reverse()) {
    try {
      if (bytes === null) fs.rmSync(path.join(destination, relative), { force: true }); else put(relative, bytes);
    } catch (failure) { rollbackFailures.push({ relative, error: failure }); }
  }
  if (rollbackFailures.length) throw new AggregateError([error, ...rollbackFailures.map(item => item.error)],
    `Host publication failed: ${error instanceof Error ? error.message : String(error)}; rollback failed for ${rollbackFailures.map(item => item.relative).join(', ')}`,
    { cause: error });
  throw error;
}
}
