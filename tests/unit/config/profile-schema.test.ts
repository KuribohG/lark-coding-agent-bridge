import { describe, expect, it } from 'vitest';
import { getCotMessages } from '../../../src/config/schema';
import {
  accessToClaudePermissionMode,
  clampAccess,
} from '../../../src/config/permissions';
import {
  createDefaultProfileConfig,
  effectiveLarkCliIdentity,
  normalizeProfileConfig,
} from '../../../src/config/profile-schema';

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

describe('profile schema', () => {
  it.each(['claude', 'codex'] as const)('defaults %s process display to brief native COT', (agentKind) => {
    const cfg = createDefaultProfileConfig({ agentKind, accounts: { app }, codex: { binaryPath: 'codex' } });
    expect(getCotMessages(cfg)).toBe('brief');
    expect(getCotMessages(normalizeProfileConfig(JSON.parse(JSON.stringify(cfg))))).toBe('brief');
  });

  it.each([
    ['off', 'off'], ['brief', 'brief'], ['detailed', 'detailed'],
  ] as const)('preserves the COT preference %s as %s', (cotMessages, expected) => {
    const cfg = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app }, preferences: { cotMessages } });
    expect(getCotMessages(cfg)).toBe(expected);
  });

  it('defaults deployment mode to personal and parses team', () => {
    const fresh = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
    expect(fresh.mode).toBe('personal');

    const team = createDefaultProfileConfig({ agentKind: 'claude', mode: 'team', accounts: { app } });
    expect(team.mode).toBe('team');

    // Unknown / missing values normalize to personal (safe default for upgrades).
    const legacy = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
    });
    expect(legacy.mode).toBe('personal');
    const bogus = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      mode: 'nonsense',
      accounts: { app },
    });
    expect(bogus.mode).toBe('personal');
  });

  it('effectiveLarkCliIdentity forces bot-only in team mode and passes through otherwise', () => {
    expect(
      effectiveLarkCliIdentity({ mode: 'team', larkCli: { identityPreset: 'user-default' } }),
    ).toBe('bot-only');
    expect(
      effectiveLarkCliIdentity({ mode: 'personal', larkCli: { identityPreset: 'user-default' } }),
    ).toBe('user-default');
    expect(
      effectiveLarkCliIdentity({ mode: 'personal', larkCli: { identityPreset: 'bot-only' } }),
    ).toBe('bot-only');
  });

  it('requires codex configuration when agentKind is codex', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'codex',
        accounts: { app },
      }),
    ).toThrow(/codex/i);
  });

  it('keeps access at profile top level without legacy open semantics', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      preferences: {
        messageReply: 'markdown',
      },
      access: {
        allowedUsers: [],
        allowedChats: [],
        admins: [],
      },
    });

    expect(cfg.preferences).not.toHaveProperty('access');
    expect(JSON.stringify(cfg)).not.toMatch(/access\.semantics|legacy-open|explicit/);
    expect(cfg.access).toEqual({
      allowedUsers: [],
      allowedChats: [],
      admins: [],
      requireMentionInGroup: true,
    });
  });

  it('drops invalid legacy message reply values instead of blocking config load', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      preferences: {
        messageReply: 'plain-text',
        showToolCalls: false,
      } as never,
    });

    expect(cfg.preferences).toEqual({
      showToolCalls: false,
    });
  });

  it('normalizes workspaces to a default working directory only', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.workspaces).toEqual({});
  });

  it('defaults lark-cli identity to app-only without legacy global source fields', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.larkCli).toEqual({ identityPreset: 'bot-only' });
    expect(cfg.larkCli).not.toHaveProperty('configSource');
    expect(cfg.larkCli).not.toHaveProperty('workspaceMode');
  });

  it('normalizes lark-cli user identity import state without preserving invalid fields', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      larkCli: {
        identityPreset: 'user-default',
        configSource: 'legacy-global',
        workspaceMode: 'shared',
        localUserImport: {
          status: 'imported',
          attemptedAt: '2026-06-04T01:02:03.000Z',
          importedAt: '2026-06-04T01:03:03.000Z',
          reason: 'same-app-local-user',
          token: 'must-not-survive',
        },
      },
    });

    expect(cfg.larkCli).toEqual({
      identityPreset: 'user-default',
      localUserImport: {
        status: 'imported',
        attemptedAt: '2026-06-04T01:02:03.000Z',
        importedAt: '2026-06-04T01:03:03.000Z',
        reason: 'same-app-local-user',
      },
    });
    expect(JSON.stringify(cfg.larkCli)).not.toContain('legacy-global');
    expect(JSON.stringify(cfg.larkCli)).not.toContain('workspaceMode');
    expect(JSON.stringify(cfg.larkCli)).not.toContain('token');
  });

  it('tolerates legacy workspace root fields without preserving them', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      workspaces: {
        default: '/repo',
        trusted: ['/repo'],
        trustedRoots: ['/repo'],
        defaultWorkspaces: ['/repo'],
        riskFlags: ['legacy-home'],
      },
    });

    expect(cfg.workspaces).toEqual({ default: '/repo' });
  });

  it('drops comment config while tolerating legacy comment fields', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      comments: {
        enabled: false,
        allowUsers: ['ou-user'],
        allowGroups: ['oc-chat'],
        allowlist: {
          docs: ['doc-b', 'doc-a', 'doc-a'],
          wikiSpaces: ['space-a'],
          folders: ['folder-a'],
        },
        bindings: {
          'doc-a': { workspace: '/repo/a', readOnly: true },
        },
        workspace: '/repo/comment',
        rateLimit: {
          perOperatorPerMin: 7,
          perDocPerMin: 13,
        },
      },
    });

    expect(cfg.comments).not.toHaveProperty('enabled');
    expect(cfg.comments).not.toHaveProperty('allowlist');
    expect(cfg.comments).not.toHaveProperty('allowUsers');
    expect(cfg.comments).not.toHaveProperty('allowGroups');
    expect(cfg.comments).not.toHaveProperty('allowedDocuments');
    expect(cfg.comments).not.toHaveProperty('bindings');
    expect(cfg.comments).not.toHaveProperty('workspace');
    expect(cfg.comments).not.toHaveProperty('rateLimit');
    expect(cfg.comments).toEqual({});
  });

  it('does not enable comment rate limits by default', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.comments).toEqual({});
  });

  it('seeds attachment limits from the runtime policy', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.attachments).toMatchObject({
      maxCount: 10,
      maxBytes: 100 * 1024 * 1024,
      maxFileBytes: 25 * 1024 * 1024,
      imageMaxBytes: 25 * 1024 * 1024,
    });
  });

  it('keeps legacy Codex binary metadata and user-home defaults without keeping public flags', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'codex',
      accounts: { app },
      codex: {
        binaryPath: '/usr/local/bin/codex',
        realpath: '/opt/codex/bin/codex',
        version: 'codex 1.2.3',
        sha256: 'abc123',
        owner: 501,
        mode: 0o755,
        flags: ['--sandbox', 'workspace-write'],
      },
    });

    expect(cfg.codex).toMatchObject({
      binaryPath: '/usr/local/bin/codex',
      realpath: '/opt/codex/bin/codex',
      version: 'codex 1.2.3',
      sha256: 'abc123',
      owner: 501,
      mode: 0o755,
      inheritCodexHome: false,
      ignoreUserConfig: false,
      ignoreRules: false,
      transport: 'app-server',
      appServerMode: 'daemon',
    });
    expect(cfg.codex).not.toHaveProperty('flags');
  });

  it('preserves explicit Codex home isolation when configured', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'codex',
      accounts: { app },
      codex: {
        binaryPath: '/usr/local/bin/codex',
        inheritCodexHome: false,
      },
    });

    expect(cfg.codex?.inheritCodexHome).toBe(false);
  });

  it('preserves explicit per-run app-server mode and rejects unknown modes', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'codex',
      accounts: { app },
      codex: {
        binaryPath: '/usr/local/bin/codex',
        appServerMode: 'per-run',
      },
    });

    expect(cfg.codex?.appServerMode).toBe('per-run');
    expect(() => normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'codex',
      accounts: { app },
      codex: {
        binaryPath: '/usr/local/bin/codex',
        appServerMode: 'background',
      },
    })).toThrow(/appServerMode/);
  });

  it('defaults Claude permissions to full/full', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
  });

  it('defaults Codex permissions to full/full', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app },
      codex: { binaryPath: '/usr/local/bin/codex' },
    });

    expect(cfg.permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
  });

  it('rejects permission defaults that exceed max access', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'claude',
        accounts: { app },
        permissions: {
          defaultAccess: 'full',
          maxAccess: 'workspace',
        },
      }),
    ).toThrow(/permission/i);
  });

  it('uses Claude permissionMode override when deriving Claude runtime permissions', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      permissions: {
        defaultAccess: 'full',
        maxAccess: 'full',
        claude: {
          permissionMode: 'default',
        },
      },
    });

    expect(accessToClaudePermissionMode('full', cfg.permissions)).toBe('default');
  });

  it('clamps access by both profile and capability maximums', () => {
    expect(clampAccess('full', 'workspace', 'full')).toBe('workspace');
    expect(clampAccess('workspace', 'full', 'read-only')).toBe('read-only');
    expect(clampAccess('read-only', 'full', 'full')).toBe('read-only');
  });

  it('rejects Claude permission overrides wider than max access', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'claude',
        accounts: { app },
        permissions: {
          maxAccess: 'read-only',
          claude: {
            permissionMode: 'bypassPermissions',
          },
        },
      }),
    ).toThrow(/permission/i);
  });

  it('does not let Claude override exceed the current access at runtime mapping time', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'full',
        claude: {
          permissionMode: 'bypassPermissions',
        },
      },
    });

    expect(accessToClaudePermissionMode('read-only', cfg.permissions)).toBe('plan');
  });

  it('rejects array-shaped permissions config', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'claude',
        accounts: { app },
        permissions: [],
      }),
    ).toThrow(/permission/i);
  });

  it('rejects array-shaped Claude permissions config', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'claude',
        accounts: { app },
        permissions: {
          claude: [],
        },
      }),
    ).toThrow(/permission/i);
  });

  it('clamps default access to an explicit max access', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      permissions: {
        maxAccess: 'workspace',
      },
    });

    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
  });
});
