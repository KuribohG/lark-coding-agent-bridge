import { readFile } from 'node:fs/promises';

export async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
