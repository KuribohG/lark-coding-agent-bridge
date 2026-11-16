import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CallbackNonceStore } from '../../../src/card/callback-store';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

async function file(content?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'callback-nonces-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'callback-nonces.json');
  if (content) await writeFile(path, content);
  return path;
}

describe('callback nonce store', () => {
  it('accepts a nonce once', async () => {
    const store = new CallbackNonceStore(await file());
    await store.load();
    expect(store.consume('nonce')).toBe(true);
    expect(store.consume('nonce')).toBe(false);
    expect(store.state('nonce')).toBe('used');
    await store.flush();
  });

  it('drops records past their retention window and keeps recent and legacy ones', async () => {
    const now = Date.now();
    const store = new CallbackNonceStore(await file(JSON.stringify({
      old: { state: 'used', at: now - 8 * 24 * 60 * 60 * 1000 },
      recent: { state: 'revoked', at: now - 1_000 },
      legacy: 'used',
    })));
    await store.load();
    expect(store.state('old')).toBeUndefined();
    expect(store.state('recent')).toBe('revoked');
    expect(store.state('legacy')).toBe('used');
  });
});
