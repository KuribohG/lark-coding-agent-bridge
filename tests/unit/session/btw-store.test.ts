import { afterEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { BtwStore } from '../../../src/session/btw-store';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

it('bounds replay while preserving exclusion IDs and topic isolation', async () => {
  const store = new BtwStore();
  await store.markMessage('one', 'very-old-message');
  for (let n = 0; n < 25; n++) await store.append('one', 'parent', { question: `q${n}`, answer: 'a' });
  expect(store.history('one', 'parent')).toHaveLength(20);
  expect(store.history('two', 'parent')).toEqual([]);
  expect(store.history('one', 'new-parent')).toEqual([]);
  await store.append('one', 'parent', { question: 'x'.repeat(50_000), answer: 'a'.repeat(50_000) });
  expect(JSON.stringify(store.history('one', 'parent')).length).toBeLessThanOrEqual(60_000);
  await store.clear('one');
  expect(store.history('one', 'parent')).toEqual([]);
  expect(store.hasMessage('one', 'very-old-message')).toBe(true);
});

it('persists concurrent updates atomically with private permissions', async () => {
  const tmp = await createTmpProfile('btw-store-'); cleanups.push(tmp.cleanup);
  const path = join(tmp.profile, 'btw.json');
  const store = new BtwStore(path);
  await Promise.all([
    store.markMessage('one', 'q'), store.markMessage('one', 'a'),
    store.append('one', 'parent', { question: 'q', answer: 'a' }),
    store.append('two', 'parent', { question: 'other', answer: 'other' }),
  ]);
  const restored = new BtwStore(path); await restored.load();
  expect(restored.history('one', 'parent')).toEqual([{ question: 'q', answer: 'a' }]);
  expect(restored.hasMessage('one', 'a')).toBe(true);
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  const otherProfile = new BtwStore(join(tmp.profile, 'different-profile.json')); await otherProfile.load();
  expect(otherProfile.history('one', 'parent')).toEqual([]);
});
