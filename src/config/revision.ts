import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export function configRevision(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function readConfigRevision(path: string): Promise<string | undefined> {
  try {
    return configRevision(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function readConfigRevisionSync(path: string): string | undefined {
  try {
    return configRevision(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
