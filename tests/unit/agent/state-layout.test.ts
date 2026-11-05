import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultWorkspaceFor,
  encodeClaudeProject,
  ensureSharedAgentAssets,
  parseAgentStateTable,
  resolveAgentState,
} from '../../../src/agent/state-layout';
import { parseDocument, documentToRoot, rootToDocument } from '../../../src/config/document';
import { profileForAgentKind } from '../../../src/runtime/execution-controller';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-state-')));
  roots.push(root);
  return root;
}

const app = { id: 'cli_test', secret: 'secret', tenant: 'feishu' as const };

describe('agent state layout', () => {
  it('derives workspaces per engine, keeping an explicit profile workspace for its own engine only', async () => {
    const root = await tmpRoot();
    const profile = {
      agentKind: 'codex' as const,
      workspaces: { default: '/srv/codex-bot' },
      state: { bridgeRoot: join(root, '.lark-channel') },
    };
    expect(defaultWorkspaceFor(profile)).toBe('/srv/codex-bot');
    expect(defaultWorkspaceFor(profile, 'claude')).toBe(join(root, '.lark-channel-workspaces', 'claude', 'default'));
    expect(defaultWorkspaceFor({ ...profile, state: { ...profile.state, workspaceRoot: '/data/ws' } }, 'pi'))
      .toBe(join(resolve('/data/ws'), 'pi', 'default'));
  });

  it('drops the hosting profile workspace when an engine is switched in', () => {
    const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app }, codex: { binaryPath: 'codex' } });
    profile.workspaces = { default: '/srv/codex-bot' };
    profile.state = { bridgeRoot: '/home/u/.lark-channel' };
    const claude = profileForAgentKind(profile, 'claude');
    expect(claude.workspaces.default).toBeUndefined();
    expect(defaultWorkspaceFor(claude)).toBe(join('/home/u/.lark-channel-workspaces', 'claude', 'default'));
    expect(profileForAgentKind(profile, 'codex').workspaces.default).toBe('/srv/codex-bot');
  });

  it('pins Claude memory to the engine workspace project regardless of cwd', async () => {
    const root = await tmpRoot();
    const configDir = join(root, 'claude-home');
    const state = { bridgeRoot: join(root, '.lark-channel') };
    const workspace = join(root, '.lark-channel-workspaces', 'claude', 'default');
    await mkdir(workspace, { recursive: true });
    const layout = resolveAgentState({ agentKind: 'codex', claude: { configDir }, state }, 'claude');
    expect(layout).toMatchObject({ home: configDir, homeSource: 'launch', exportHome: true, defaultWorkspace: workspace });
    expect(layout.memoryDir).toBe(join(configDir, 'projects', encodeClaudeProject(workspace), 'memory'));
    const native = resolveAgentState({ agentKind: 'claude', state: { ...state, memory: 'workspace' } }, 'claude', { env: { CLAUDE_CONFIG_DIR: configDir } });
    expect(native).toMatchObject({ home: configDir, homeSource: 'native', exportHome: false });
    expect(native.memoryDir).toBeUndefined();
  });

  it('places Codex homes bridge-wide, or in the host state directory without a bridge root', async () => {
    const root = await tmpRoot();
    const bridgeRoot = join(root, '.lark-channel');
    const profileDir = join(bridgeRoot, 'profiles', 'claude');
    const profile = { agentKind: 'claude' as const, codex: { binaryPath: 'codex' }, state: { bridgeRoot } };
    expect(resolveAgentState(profile, 'codex', { profileDir })).toMatchObject({
      home: join(bridgeRoot, 'agents', 'codex'), homeSource: 'bridge', exportHome: true, homeEnv: 'CODEX_HOME',
    });

    await mkdir(join(bridgeRoot, 'profiles', 'codex', 'codex-home'), { recursive: true });
    expect(resolveAgentState(profile, 'codex', { profileDir }).homeSource).toBe('bridge');

    const standalone = { agentKind: 'codex' as const, codex: { binaryPath: 'codex' } };
    expect(resolveAgentState(standalone, 'codex', { profileDir })).toMatchObject({
      home: join(profileDir, 'codex-home'), homeSource: 'profile', exportHome: true,
    });

    const inherited = { ...profile, codex: { binaryPath: 'codex', inheritCodexHome: true } };
    expect(resolveAgentState(inherited, 'codex', { profileDir, env: { CODEX_HOME: '/x/codex' } }))
      .toMatchObject({ home: '/x/codex', homeSource: 'native', exportHome: false });
  });

  it('links shared instructions and skills without replacing existing files', async () => {
    const root = await tmpRoot();
    const instructions = join(root, 'shared', 'RULES.md');
    const skills = join(root, 'shared', 'skills');
    await mkdir(join(skills, 'alpha'), { recursive: true });
    await mkdir(join(skills, 'beta'), { recursive: true });
    await writeFile(instructions, 'rules');
    const home = join(root, 'codex-home');
    await mkdir(join(home, 'skills'), { recursive: true });
    await writeFile(join(home, 'skills', 'beta'), 'local');
    const layout = { kind: 'codex' as const, home, exportHome: true, defaultWorkspace: root };

    const report = ensureSharedAgentAssets(layout, { instructions, skills });
    expect(report.linked.sort()).toEqual([join(home, 'AGENTS.md'), join(home, 'skills', 'alpha')]);
    expect(report.conflicts).toEqual([expect.stringContaining(join(home, 'skills', 'beta'))]);
    expect(await readlink(join(home, 'AGENTS.md'))).toBe(instructions);

    expect(ensureSharedAgentAssets(layout, { instructions, skills }).linked).toEqual([]);

    const claudeHome = join(root, 'claude-home');
    await mkdir(claudeHome, { recursive: true });
    await symlink(skills, join(claudeHome, 'skills'));
    const claude = ensureSharedAgentAssets({ ...layout, kind: 'claude', home: claudeHome }, { instructions, skills });
    expect(claude.linked).toEqual([join(claudeHome, 'CLAUDE.md')]);
    expect((await lstat(join(claudeHome, 'skills'))).isSymbolicLink()).toBe(true);
  });

  it('validates and round-trips the [state] table', () => {
    expect(() => parseAgentStateTable({ memory: 'global' })).toThrow('state.memory');
    expect(() => parseAgentStateTable({ workspace_root: 'relative' })).toThrow('absolute');
    expect(() => parseAgentStateTable({ shared: { rules: '/x' } })).toThrow('state.shared.rules');
    const doc = parseDocument(`version = 3
[state]
workspace_root = "~/ws"
memory = "agent"
[state.shared]
instructions = "~/.claude/CLAUDE.md"
[profiles.bot]
agent = "claude"
[profiles.bot.accounts.app]
id = "cli_test"
secret = "secret"
tenant = "feishu"
`);
    const root = documentToRoot(doc);
    expect(root.agentState).toEqual({ workspaceRoot: '~/ws', memory: 'agent', shared: { instructions: '~/.claude/CLAUDE.md' } });
    expect(root.profiles.bot!.state).toEqual(root.agentState);
    expect(rootToDocument(root).state).toEqual({ workspace_root: '~/ws', memory: 'agent', shared: { instructions: '~/.claude/CLAUDE.md' } });
  });
});

describe('run flow workspace for switched engines', () => {
  it('runs a Claude scope hosted by a Codex bot in the bridge-wide Claude workspace', async () => {
    const { resolveRunFlowContext } = await import('../../../src/runtime/run-flow');
    const { capabilityForProfile } = await import('../../../src/agent/backends');
    const { SessionStore } = await import('../../../src/session/store');
    const { WorkspaceStore } = await import('../../../src/workspace/store');
    const root = await tmpRoot();
    const bridgeRoot = join(root, '.lark-channel');
    const codexWorkspace = join(root, 'codex-bot');
    await mkdir(codexWorkspace, { recursive: true });
    const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app }, codex: { binaryPath: 'codex' } });
    profile.workspaces = { default: codexWorkspace };
    profile.state = { bridgeRoot };
    const input = {
      scope: { source: 'im' as const, chatId: 'chat', actorId: 'user' }, prompt: '', attachments: [],
      access: { ok: true as const, reason: 'allowed-user' as const },
      sessions: new SessionStore(join(root, 'sessions.json')), workspaces: new WorkspaceStore(join(root, 'workspaces.json')), now: Date.now(),
    };

    const claude = profileForAgentKind(profile, 'claude');
    const switched = await resolveRunFlowContext({ ...input, scopeId: 'chat', capability: capabilityForProfile(claude), profileConfig: claude });
    expect(switched.workspace).toMatchObject({ ok: true, cwdRealpath: join(`${bridgeRoot}-workspaces`, 'claude', 'default') });

    const own = await resolveRunFlowContext({ ...input, scopeId: 'chat', capability: capabilityForProfile(profile), profileConfig: profile });
    expect(own.workspace).toMatchObject({ ok: true, cwdRealpath: codexWorkspace });
  });
});
