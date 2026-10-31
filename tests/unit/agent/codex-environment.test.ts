import { expect, it } from 'vitest';
import { codexExecutionEnvironment } from '../../../src/agent/codex/environment';

it('binds the complete profile and attempt to tools without serializing backend credentials', () => {
  const profile = { LARK_CHANNEL: '1', LARK_CHANNEL_PROFILE: 'profile-a', CODEX_HOME: '/isolated' };
  const env = codexExecutionEnvironment({ profile, attempt: { LARK_WORKFLOW_TOKEN: 'attempt-one' },
    backend: { PROVIDER_KEY: 'backend-only' }, inherited: { PATH: '/bin', HOST_SECRET: 'host-only' } });
  expect(env.tools.set).toEqual({ ...profile, LARK_WORKFLOW_TOKEN: 'attempt-one' });
  expect(env.process).toMatchObject({ ...profile, PROVIDER_KEY: 'backend-only' });
  expect(env.process).not.toHaveProperty('LARK_WORKFLOW_TOKEN');
  expect(JSON.stringify(env.tools)).not.toContain('backend-only');
  expect(JSON.stringify(env.tools)).not.toContain('host-only');
});

it('does not merge prior attempts or another profile into a new tool context', () => {
  const first = codexExecutionEnvironment({ profile: { PROFILE: 'A' }, attempt: { TOKEN: 'one', ENDPOINT: 'old' }, backend: {}, inherited: {} });
  const second = codexExecutionEnvironment({ profile: { PROFILE: 'B' }, attempt: { TOKEN: 'two' }, backend: {}, inherited: {} });
  expect(first.tools.set).toEqual({ PROFILE: 'A', TOKEN: 'one', ENDPOINT: 'old' });
  expect(second.tools.set).toEqual({ PROFILE: 'B', TOKEN: 'two' });
});

it('carries explicit profile deletions to both spawn and daemon tool policy', () => {
  const env = codexExecutionEnvironment({ profile: { UNWANTED: undefined }, backend: {}, inherited: { UNWANTED: 'old' } });
  expect(env.process).not.toHaveProperty('UNWANTED');
  expect(env.tools).toEqual({ inherit: 'all', set: {}, exclude: ['UNWANTED'] });
});

it('uses the same case-insensitive override semantics as process launches', () => {
  const env = codexExecutionEnvironment({ profile: { Path: '/profile', TOKEN: undefined },
    attempt: { PATH: '/attempt', token: 'current' }, backend: {}, inherited: {} });
  expect(env.tools).toEqual({ inherit: 'all', set: { PATH: '/attempt', token: 'current' }, exclude: [] });
});
