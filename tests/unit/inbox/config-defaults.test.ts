import { expect, it } from 'vitest';
import { normalizeInbox } from '../../../src/inbox/config';

it('follows the executor default model unless one is set', () => {
  expect(normalizeInbox(undefined)).toMatchObject({ enabled: false, analysisModel: '' });
  expect(normalizeInbox({ enabled: false }).analysisModel).toBe('');
  expect(normalizeInbox({ analysisModel: 'custom/model' }).analysisModel).toBe('custom/model');
});
