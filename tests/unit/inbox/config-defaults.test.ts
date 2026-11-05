import { expect, it } from 'vitest';
import { normalizeInbox } from '../../../src/inbox/config';

it('uses the provider default for new installs and preserves legacy Flash routing', () => {
  expect(normalizeInbox(undefined)).toMatchObject({ enabled: false, analysisModel: '' });
  expect(normalizeInbox({ enabled: false }).analysisModel).toBeUndefined();
  expect(normalizeInbox({ analysisModel: '' }).analysisModel).toBe('');
  expect(normalizeInbox({ analysisModel: 'custom/model' }).analysisModel).toBe('custom/model');
});
