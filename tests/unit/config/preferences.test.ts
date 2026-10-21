import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPreferencesChange, preparePreferencesChange, PreferencesApplyError } from '../../../src/config/preferences';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { runtimeProfileConfig } from '../../../src/config/profile-store';
import * as ops from '../../../src/config/config-ops';

vi.mock('../../../src/config/config-ops', () => ({
  applyProfileLarkCliIdentity: vi.fn(async () => true),
  savePreferencesConfig: vi.fn(async () => {}),
}));
vi.mock('../../../src/runtime/model-settings', () => ({ modelEnvironment: async () => ({ defaults: {}, models: [] }) }));

function state() {
  const profileConfig = createDefaultProfileConfig({ agentKind: 'claude', accounts: {
    app: { id: 'test', secret: '${TEST_SECRET}', tenant: 'feishu' },
  } });
  const cfg = runtimeProfileConfig({ schemaVersion: 2, activeProfile: 'test', preferences: {}, profiles: { test: profileConfig } }, 'test');
  return { profile: 'test', configPath: '/unused/config.json', profileConfig, cfg };
}

beforeEach(() => { vi.mocked(ops.applyProfileLarkCliIdentity).mockReset().mockResolvedValue(true); vi.mocked(ops.savePreferencesConfig).mockReset().mockResolvedValue(); });

describe('shared preference changes', () => {
  it('saves offline changes without applying a live identity or unrelated meeting snapshot', async () => {
    const s = state();
    const change = await preparePreferencesChange(s, { larkCliIdentity: 'user-default', model: 'default' });
    await applyPreferencesChange(s, change, 'disk');
    expect(ops.applyProfileLarkCliIdentity).not.toHaveBeenCalled();
    expect(ops.savePreferencesConfig).toHaveBeenCalledOnce();
    expect(vi.mocked(ops.savePreferencesConfig).mock.calls[0]?.[5]).toBeUndefined();
    expect(change.nextPreferences.model).toBeUndefined();
  });

  it('restores the previous identity after a partially failed policy call without saving', async () => {
    const s = state();
    const change = await preparePreferencesChange(s, { larkCliIdentity: 'user-default' });
    vi.mocked(ops.applyProfileLarkCliIdentity).mockResolvedValueOnce(false);
    await expect(applyPreferencesChange(s, change)).rejects.toMatchObject({ step: 'config.lark-cli-policy', identityApplied: false, rollbackFailed: false });
    expect(vi.mocked(ops.applyProfileLarkCliIdentity).mock.calls.map(call => call[1])).toEqual(['user-default', 'bot-only']);
    expect(ops.savePreferencesConfig).not.toHaveBeenCalled();
  });

  it('reports failed rollback distinctly after persistence fails', async () => {
    const s = state();
    const change = await preparePreferencesChange(s, { larkCliIdentity: 'user-default' });
    vi.mocked(ops.savePreferencesConfig).mockRejectedValueOnce(new Error('disk unavailable'));
    vi.mocked(ops.applyProfileLarkCliIdentity).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = applyPreferencesChange(s, change);
    await expect(result).rejects.toBeInstanceOf(PreferencesApplyError);
    await expect(result).rejects.toMatchObject({ step: 'config.save', identityApplied: true, rollbackFailed: true });
  });

  it('validates and records a backend switch, clearing backend-specific model settings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-preference-pi-'));
    temporaryDirs.push(dir);
    const pi = join(dir, 'pi');
    await writeFile(pi, '#!/bin/sh\necho "pi test"\n', 'utf8');
    await chmod(pi, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`;
    try {
      const s = state();
      s.profileConfig.preferences = {
        ...s.profileConfig.preferences,
        model: 'old-backend-model',
        reasoningEffort: 'high',
      };
      s.cfg.preferences = s.profileConfig.preferences;
      const change = await preparePreferencesChange(s, { agentKind: 'pi' });

      expect(change.nextAgentKind).toBe('pi');
      expect(change.agentSwitch).toMatchObject({
        agentKind: 'pi',
        launchPatch: { pi: { binaryPath: pi } },
      });
      expect(change.nextPreferences.model).toBeUndefined();
      expect(change.nextPreferences.reasoningEffort).toBeUndefined();

      await applyPreferencesChange(s, change, 'disk');
      expect(vi.mocked(ops.savePreferencesConfig).mock.calls[0]?.[8]).toMatchObject({
        agentKind: 'pi',
        launchPatch: { pi: { binaryPath: pi } },
      });
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
