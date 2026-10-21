import { encodeFixture, decodeFixture } from '../../helpers/config-fixture';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret, listSecretIds } from '../../../src/config/keystore';
import {
  createDefaultProfileConfig,
  type AgentKind,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { runtimeProfileConfig } from '../../../src/config/profile-store';
import { getMessageReplyMode, getRequireMentionInGroup, getRunIdleTimeoutMs, secretKeyForApp } from '../../../src/config/schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { applyConfig, loadProfileState } from '../../../src/ui/api';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: vi.fn(async () => ({
    ok: true,
    botName: 'Updated Bot',
    botOpenId: 'ou-bot',
  })),
}));

const identityPolicyMocks = vi.hoisted(() => ({
  applyLarkCliIdentityPolicy: vi.fn(async () => true),
}));

vi.mock('../../../src/lark-cli/identity-policy', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lark-cli/identity-policy')>(
    '../../../src/lark-cli/identity-policy',
  );
  return {
    ...actual,
    applyLarkCliIdentityPolicy: identityPolicyMocks.applyLarkCliIdentityPolicy,
  };
});

const roots: string[] = [];

beforeEach(() => {
  identityPolicyMocks.applyLarkCliIdentityPolicy.mockReset();
  identityPolicyMocks.applyLarkCliIdentityPolicy.mockResolvedValue(true);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile-aware account and config commands', () => {
  it('applies equivalent card and web settings through the same validation and identity policy', async () => {
    vi.useFakeTimers();
    const card = await createHarness();
    const web = await createHarness();
    await card.command('/config submit', {
      model_pick: '__manual__', model: 'private/custom-model', reasoning_effort: 'high',
      message_reply: 'text', show_tool_calls: 'hide', cot_messages: 'on',
      max_concurrent_runs: '99', run_idle_timeout_minutes: '0', require_mention_in_group: 'no',
      deploy_mode: 'team', lark_cli_identity: 'user-default',
    });
    await applyConfig({
      ...await loadProfileState('claude', web.rootDir),
      async refreshOwner() {}, async restart() {},
    }, {
      model: 'private/custom-model', reasoningEffort: 'high', messageReply: 'text',
      showToolCalls: false, cotMessages: 'detailed', maxConcurrentRuns: 99,
      runIdleTimeoutMinutes: 0, requireMentionInGroup: false, mode: 'team', larkCliIdentity: 'user-default',
    });
    const cardRoot = await waitForRoot(card.rootDir, root => root.profiles.claude?.mode === 'team');
    const webRoot = await readRoot(web.rootDir);
    const actual = cardRoot.profiles.claude!;
    const expected = webRoot.profiles.claude!;
    expect(actual.preferences).toEqual(expected.preferences);
    expect(actual.access).toEqual(expected.access);
    expect(actual.larkCli.identityPreset).toBe(expected.larkCli.identityPreset);
    expect(actual.preferences.maxConcurrentRuns).toBe(50);
    expect(getRunIdleTimeoutMs(actual)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('saves /config submit into the active v2 profile without flattening root config', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.channels?.lark?.reply_mode === 'text',
    );
    expect(root.schemaVersion).toBe(2);
    expect(root.activeProfile).toBe('claude');
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.preferences).toMatchObject({
      maxConcurrentRuns: 7,
      runIdleTimeoutMinutes: 15,
    });
    expect(root.profiles.claude?.access.requireMentionInGroup).toBe(false);
    expect(root.profiles.claude?.larkCli.identityPreset).toBe('user-default');
    expect(root.profiles.claude?.larkCli.localUserImport).toMatchObject({
      status: 'not-needed',
      reason: 'manual-user-default',
    });
    expect(getRequireMentionInGroup(runtimeProfileConfig(root, 'claude'))).toBe(false);
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
  });

  it('persists a hand-written model and effort, and clears both when default is chosen', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', {
      model: 'private/custom-model',
      model_pick: '__manual__',
      reasoning_effort: 'high',
      message_reply: 'text',
    });
    const withModel = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.model === 'private/custom-model',
    );
    expect(withModel.profiles.claude?.preferences).toMatchObject({ model: 'private/custom-model', reasoningEffort: 'high' });

    await h.command('/config submit', {
      model: 'default',
      reasoning_effort: 'default',
      message_reply: 'text',
    });
    const cleared = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.model === undefined,
    );
    expect(cleared.profiles.claude?.preferences.model).toBeUndefined();
    expect(cleared.profiles.claude?.preferences.reasoningEffort).toBeUndefined();
  });

  it('switches a profile execution engine through the shared config API', async () => {
    const h = await createHarness({ preferences: { model: 'old-model', reasoningEffort: 'high' } });
    const binDir = join(h.rootDir, 'bin');
    await mkdir(binDir, { recursive: true });
    const pi = join(binDir, 'pi');
    await writeFile(pi, '#!/bin/sh\necho "pi 0.test"\n', 'utf8');
    await chmod(pi, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${oldPath ?? ''}`;
    const switchAgent = vi.fn(async () => {});
    try {
      const state = await loadProfileState('claude', h.rootDir);
      const view = await applyConfig({
        ...state,
        async refreshOwner() {},
        async restart() {},
        switchAgent,
      }, { agentKind: 'pi' });

      expect(view).toMatchObject({ profile: 'claude', agentKind: 'pi', live: true });
      const root = await readRoot(h.rootDir);
      expect(root.profiles.claude?.agentKind).toBe('pi');
      expect(root.profiles.claude?.pi?.binaryPath).toBe(pi);
      expect(root.profiles.claude?.preferences.model).toBeUndefined();
      expect(root.profiles.claude?.preferences.reasoningEffort).toBeUndefined();
      expect(switchAgent).toHaveBeenCalledOnce();
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('stores a /config engine choice as a context override without changing the profile default', async () => {
    const setAgentKind = vi.fn(async () => {});
    const h = await createHarness({ agentKind: 'claude', setAgentKind });

    await h.command('/config submit', {
      agent_kind: 'pi',
      model: 'claude-profile-model',
      reasoning_effort: 'high',
      message_reply: 'markdown',
    });
    await vi.waitFor(() => expect(setAgentKind).toHaveBeenCalledWith('chat-1', 'pi'));
    const root = await readRoot(h.rootDir);
    expect(root.profiles.claude?.agentKind).toBe('claude');
    expect(root.profiles.claude?.preferences.model).toBeUndefined();
  });

  it('keeps the current message reply mode when the config submit payload omits it', async () => {
    vi.useFakeTimers();
    const h = await createHarness({
      preferences: {
        messageReply: 'text',
        messageReplyMigrated: true,
      },
    });

    await h.command('/config submit', {
      show_tool_calls: 'show',
      max_concurrent_runs: '8',
      run_idle_timeout_minutes: '20',
      require_mention_in_group: 'yes',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.maxConcurrentRuns === 8,
    );
    expect(root.profiles.claude?.channels?.lark?.reply_mode).toBe('text');
    expect(getMessageReplyMode(runtimeProfileConfig(root, 'claude'))).toBe('text');
  });

  it('does not save a lark-cli identity change when applying the runtime policy fails', async () => {
    vi.useFakeTimers();
    identityPolicyMocks.applyLarkCliIdentityPolicy.mockResolvedValueOnce(false);
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(h.channel.sent.length).toBeGreaterThan(0);
    });

    const root = await readRoot(h.rootDir);
    expect(root.profiles.claude?.larkCli.identityPreset).toBe('bot-only');
    expect(root.profiles.claude?.preferences.messageReply).not.toBe('text');
    expect(appliedLarkCliIdentities()).toEqual([
      'user-default',
      'bot-only',
    ]);
    const card = encodeFixture(h.channel.sent.at(-1)?.content);
    expect(card).toContain('保存失败');
    expect(card).toContain('lark-cli 身份策略');
    expect(card).not.toContain('偏好已保存');
  });

  it('rolls back lark-cli identity when saving config fails after applying the runtime policy', async () => {
    vi.useFakeTimers();
    const applied = deferred<boolean>();
    identityPolicyMocks.applyLarkCliIdentityPolicy
      .mockImplementationOnce(async () => applied.promise)
      .mockResolvedValue(true);
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });
    await Promise.resolve();
    await writeFile(resolveAppPaths({ rootDir: h.rootDir }).configFile, '{invalid json', 'utf8');
    applied.resolve(true);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(h.channel.sent.length).toBeGreaterThan(0);
    });

    expect(appliedLarkCliIdentities()).toEqual([
      'user-default',
      'bot-only',
    ]);
    const card = encodeFixture(h.channel.sent.at(-1)?.content);
    expect(card).toContain('保存失败');
    expect(card).toContain('已回滚');
    expect(card).not.toContain('未做任何修改');
    expect(card).not.toContain('偏好已保存');
  });

  it('saves /account submit into the active v2 profile and profile-local keystore', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/account submit', {
      app_id: 'cli_new',
      app_secret: 'new-secret',
      tenant: 'lark',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.accounts.app.id === 'cli_new',
    );
    expect(root.schemaVersion).toBe(2);
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.accounts.app).toMatchObject({
      id: 'cli_new',
      tenant: 'lark',
      secret: {
        source: 'exec',
        provider: 'bridge',
        id: secretKeyForApp('cli_new'),
      },
    });
    expect(root.secrets?.providers?.bridge?.command).toContain('secrets-getter');
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
    await expect(
      getSecret(secretKeyForApp('cli_new'), resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' })),
    ).resolves.toBe('new-secret');
    const claudePaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' });
    const codexPaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'codex-dev' });
    expect(claudePaths.secretsFile).not.toBe(codexPaths.secretsFile);
    await expect(
      listSecretIds(codexPaths),
    ).resolves.not.toContain(secretKeyForApp('cli_new'));
  });
});

async function createHarness(options: {
  preferences?: RootConfig['profiles'][string]['preferences'];
  agentKind?: 'claude' | 'codex' | 'pi';
  setAgentKind?: (scope: string, kind: AgentKind) => Promise<void>;
} = {}): Promise<{
  rootDir: string;
  channel: ReturnType<typeof createFakeChannel>;
  command(content: string, formValue?: Record<string, unknown>): Promise<boolean>;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-profile-config-command-'));
  roots.push(rootDir);
  const workspace = join(rootDir, 'workspace');
  await mkdir(workspace, { recursive: true });
  const root = await writeRoot(rootDir, workspace, options.preferences);
  const profileConfig = root.profiles.claude!;
  const appPaths = resolveAppPaths({ rootDir, profile: 'claude' });
  const channel = createFakeChannel();
  const sessions = new SessionStore(appPaths.sessionsFile);
  const workspaces = new WorkspaceStore(appPaths.workspacesFile);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-admin',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: appPaths.configFile,
    cfg: runtimeProfileConfig(root, 'claude'),
    processId: 'proc-1',
  } satisfies Controls;

  return {
    rootDir,
    channel,
    command: (content: string, formValue?: Record<string, unknown>) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: message(content),
        scope: 'chat-1',
        chatMode: 'p2p',
        sessions,
        workspaces,
        agent: new FakeAgentAdapter(),
        activeRuns: new ActiveRuns(),
        controls,
        agentKind: options.agentKind ?? 'claude',
        defaultAgentKind: profileConfig.agentKind,
        setAgentKind: options.setAgentKind,
        formValue,
        fromCardAction: true,
      }),
  };
}

async function writeRoot(
  rootDir: string,
  workspace: string,
  preferences: RootConfig['profiles'][string]['preferences'] = {},
): Promise<RootConfig> {
  const root: RootConfig = {
    schemaVersion: 2,
    activeProfile: 'claude',
    preferences: {},
    profiles: {
      claude: createDefaultProfileConfig({
        agentKind: 'claude',
        accounts: {
          app: { id: 'cli_old', secret: '${APP_SECRET}', tenant: 'feishu' },
        },
        access: { admins: ['ou-admin'] },
      }),
      'codex-dev': createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: {
          app: { id: 'cli_codex', secret: '${APP_SECRET}', tenant: 'feishu' },
        },
        codex: { binaryPath: 'codex' },
      }),
    },
  };
  root.profiles.claude!.workspaces.default = workspace;
  root.profiles.claude!.preferences = {
    ...root.profiles.claude!.preferences,
    ...preferences,
  };
  await writeJson(resolveAppPaths({ rootDir }).configFile, root);
  await writeFile(join(rootDir, 'active-profile'), 'claude\n', 'utf8');
  return root;
}

async function readRoot(rootDir: string): Promise<RootConfig> {
  return decodeFixture(await readFile(resolveAppPaths({ rootDir }).configFile, 'utf8')) as RootConfig;
}

async function waitForRoot(
  rootDir: string,
  predicate: (root: RootConfig) => boolean,
): Promise<RootConfig> {
  let lastRoot = await readRoot(rootDir);
  await vi.waitFor(async () => {
    lastRoot = await readRoot(rootDir);
    expect(predicate(lastRoot)).toBe(true);
  }, { timeout: 5000 });
  return lastRoot;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function appliedLarkCliIdentities(): unknown[] {
  return (
    identityPolicyMocks.applyLarkCliIdentityPolicy.mock.calls as unknown as Array<[unknown, unknown]>
  ).map((call) => call[1]);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${encodeFixture(value, null, 2)}\n`, 'utf8');
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
