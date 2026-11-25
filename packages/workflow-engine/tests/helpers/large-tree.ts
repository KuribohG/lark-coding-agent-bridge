import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Paths long and many enough that Git lists them, in any form, in more bytes than a workspace command may print whole. */
export const LARGE_PATHS = Array.from({ length: 9600 }, (_, index) => `bulk/${index % 64}/${'n'.repeat(200)}-${index}.txt`);

const run = (cwd: string, args: string[], input?: string, env = process.env) => execFileSync('git', args, { cwd, env, input, encoding: 'utf8', maxBuffer: 64 << 20 }).trim();

/**
 * A commit on `parent` that adds LARGE_PATHS and what `extra` names. It is written in an index of its own, so the
 * checkout's files and index stay as they are.
 */
export function largeCommit(repo: string, parent: string, extra: { files?: Record<string, string>; submodule?: string } = {}): string {
  const index = join(tmpdir(), `large-index-${randomUUID()}`), env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    const blob = (text: string) => run(repo, ['hash-object', '-w', '--stdin'], text);
    const shared = blob('x\n');
    run(repo, ['read-tree', parent], undefined, env);
    run(repo, ['update-index', '--add', '--index-info'], [...LARGE_PATHS.map(path => `100644 ${shared}\t${path}`),
      ...Object.entries(extra.files ?? {}).map(([path, text]) => `100644 ${blob(text)}\t${path}`),
      ...(extra.submodule ? [`160000 ${parent}\t${extra.submodule}`] : [])].join('\n') + '\n', env);
    return run(repo, ['commit-tree', run(repo, ['write-tree'], undefined, env), '-p', parent, '-m', 'large']);
  } finally { rmSync(index, { force: true }); }
}
/** How many bytes Git prints for a command there. */
export const printed = (repo: string, ...args: string[]) => Buffer.byteLength(run(repo, args));
