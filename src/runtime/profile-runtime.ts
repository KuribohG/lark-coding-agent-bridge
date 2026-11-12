import { AGENT_KINDS } from '../agent/backend-spec';
import { defaultWorkspaceFor } from '../agent/state-layout';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as p from '@clack/prompts';
import { agentDisplayName } from '../agent/backends';
import { detectInstalledAgents, type DetectedAgent } from '../agent/detection';
import {
  createBootstrapProfileConfig,
} from '../cli/profile-bootstrap';
import { setSecret } from '../config/keystore';
import type { PermissionConfig } from '../config/permissions';
import { resolveAppPaths, type AppPaths } from '../config/app-paths';
import {
  agentKindFromString,
  createRootConfig,
  loadRootConfig,
  readActiveProfile,
  runtimeProfileConfig,
  saveRootConfig,
  loadLarkNetworkConfig,
  writeActiveProfile,
} from '../config/profile-store';
import {
  type AgentKind,
  type ProfileConfig,
  type RootConfig,
} from '../config/profile-schema';
import type { AppConfig, SecretInput, TenantBrand } from '../config/schema';
import { isSecretRef, secretKeyForApp } from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { buildEncryptedAccountConfig } from '../config/store';
import { validateAppCredentials } from '../utils/feishu-auth';

export interface ResolveProfileRuntimeOptions {
  config?: string;
  profile?: string;
  agent?: string;
  workspace?: string;
  /** Agent executable for a bootstrapped profile; defaults to the backend's env override or command name. */
  binaryPath?: string;
  /** Extra agent process environment for a bootstrapped profile. */
  launchEnv?: Record<string, string>;
  /** Permissions for a bootstrapped profile; defaults to the schema default. */
  permissions?: Partial<PermissionConfig>;
  appId?: string;
  appSecret?: string;
  tenant?: string;
  allowBootstrap?: boolean;
  /** Interactive steps of a first-run bootstrap; without them bootstrap needs --app-id/--app-secret. */
  prompts?: ProfileBootstrapPrompts;
  selectAgent?: (detected: DetectedAgent[]) => AgentKind | undefined | Promise<AgentKind | undefined>;
}

export interface ProfileBootstrapPrompts {
  registerApp(): Promise<AppConfig>;
  appSecret(appId: string): Promise<string>;
}

export interface ProfileRuntime {
  cfg: AppConfig & { agentKind?: AgentKind };
  profileConfig: ProfileConfig;
  modelServices: Record<string, import('../model-service/config').ModelServiceConfig>;
  configPath: string;
  appPaths: AppPaths;
  profile: string;
}

export interface MaterializeEnvSecretForServiceOptions {
  config?: string;
  profile?: string;
}

const ENV_SECRET_TEMPLATE_RE = /^\$\{[A-Z][A-Z0-9_]{0,127}\}$/;

export async function resolveProfileRuntime(
  opts: ResolveProfileRuntimeOptions,
): Promise<ProfileRuntime> {
  const rootDir = opts.config ? dirname(opts.config) : undefined;
  const requestedAgent = agentKindFromString(opts.agent);
  const explicitProfile = opts.profile;
  const activeProfile = explicitProfile ?? (await readActiveProfile(rootDir));
  let profile = activeProfile ?? requestedAgent;
  if (!profile && opts.allowBootstrap) {
    const detected = await detectInstalledAgents();
    if (detected.length === 0) {
      throw new Error(`no supported local agent found; install ${AGENT_KINDS.join(', ')} first`);
    }
    if (detected.length > 1) {
      const selected = await selectDetectedAgent(detected, opts.selectAgent);
      if (!selected) {
        throw new Error(formatAmbiguousAgentSelectionError(detected));
      }
      profile = selected;
    } else {
      profile = detected[0]?.kind;
    }
  }
  if (!profile && !opts.allowBootstrap) {
    throw new Error('active profile is required');
  }
  profile ??= 'claude';
  let appPaths = resolveAppPaths({ rootDir, profile });
  const configPath = opts.config ?? appPaths.configFile;

  let rootConfig = await loadRootConfig(configPath);
  if (rootConfig) {
    if (!explicitProfile && !activeProfile) {
      profile = rootConfig.activeProfile;
      appPaths = resolveAppPaths({ rootDir, profile });
    }
    let profileConfig = rootConfig.profiles[profile];
    if (!profileConfig) {
      if (opts.allowBootstrap && explicitProfile) {
        return bootstrapProfileIntoExistingRoot({
          rootConfig,
          profile,
          requestedAgent,
          opts,
          appPaths,
          configPath,
        });
      }
      throw new Error(`profile not found: ${profile}`);
    }
    assertRequestedAgentMatchesExistingProfile(profile, profileConfig, requestedAgent);
    await ensureDefaultWorkspace(profileConfig);
    assertBootstrapAppMatchesExistingProfile(opts, profile, profileConfig);
    const cfg = runtimeProfileConfig(rootConfig, profile);
    return { cfg, profileConfig, modelServices: rootConfig.modelServices ?? {}, configPath, appPaths, profile };
  }

  if (!opts.allowBootstrap) {
    throw new Error('config not initialized');
  }
  const bootstrapAgent = resolveBootstrapAgent(requestedAgent, profile) ?? 'claude';
  const workspace = opts.workspace;
  const fresh = await resolveBootstrapAppConfig(opts, configPath, profile);
  const encrypted = await encryptedConfigForProfile(fresh, appPaths);
  const profileConfig = await createBootstrapProfileConfig({
    agentKind: bootstrapAgent,
    accounts: encrypted.accounts,
    preferences: encrypted.preferences,
    secrets: encrypted.secrets,
    workspace,
    binaryPath: opts.binaryPath,
    launchEnv: opts.launchEnv,
    permissions: opts.permissions,
    defaultWorkspace: defaultWorkspaceFor({ agentKind: bootstrapAgent, state: { bridgeRoot: appPaths.rootDir } }),
  });
  const root = createRootConfig(profile, profileConfig, encrypted.secrets);
  await saveRootConfig(root, configPath);
  await writeActiveProfile(appPaths.rootDir, profile);
  console.log(`配置已保存到 ${configPath}\n`);
  return {
    cfg: runtimeProfileConfig(root, profile),
    profileConfig: root.profiles[profile]!,
    modelServices: root.modelServices ?? {},
    configPath,
    appPaths,
    profile,
  };
}

async function bootstrapProfileIntoExistingRoot(args: {
  rootConfig: RootConfig;
  profile: string;
  requestedAgent: AgentKind | undefined;
  opts: ResolveProfileRuntimeOptions;
  appPaths: AppPaths;
  configPath: string;
}): Promise<ProfileRuntime> {
  const { rootConfig, profile, requestedAgent, opts, appPaths, configPath } = args;
  const bootstrapAgent = resolveBootstrapAgent(requestedAgent, profile) ?? 'claude';
  const workspace = opts.workspace;
  const fresh = await resolveBootstrapAppConfig(opts, configPath, profile);
  const encrypted = await encryptedConfigForProfile(fresh, appPaths);
  const profileConfig = await createBootstrapProfileConfig({
    agentKind: bootstrapAgent,
    accounts: encrypted.accounts,
    preferences: encrypted.preferences,
    secrets: encrypted.secrets,
    workspace,
    binaryPath: opts.binaryPath,
    launchEnv: opts.launchEnv,
    permissions: opts.permissions,
    defaultWorkspace: defaultWorkspaceFor({ agentKind: bootstrapAgent, state: { bridgeRoot: appPaths.rootDir } }),
  });
  const nextRoot: RootConfig = {
    ...rootConfig,
    ...(rootConfig.secrets ?? encrypted.secrets
      ? { secrets: rootConfig.secrets ?? encrypted.secrets }
      : {}),
    profiles: {
      ...rootConfig.profiles,
      [profile]: {
        ...profileConfig,
        secrets: undefined,
      },
    },
  };
  await saveRootConfig(nextRoot, configPath);
  console.log(`配置已保存到 ${configPath}\n`);
  return {
    cfg: runtimeProfileConfig(nextRoot, profile),
    profileConfig: nextRoot.profiles[profile]!,
    modelServices: nextRoot.modelServices ?? {},
    configPath,
    appPaths,
    profile,
  };
}


/** The layout default is derived, not persisted; only make sure it exists. */
async function ensureDefaultWorkspace(profileConfig: ProfileConfig): Promise<void> {
  const workspace = profileConfig.workspaces.default ? undefined : defaultWorkspaceFor(profileConfig);
  if (workspace) await mkdir(workspace, { recursive: true, mode: 0o700 });
}


function resolveBootstrapAgent(
  requestedAgent: AgentKind | undefined,
  profile: string | undefined,
): AgentKind | undefined {
  return requestedAgent ?? (
    profile === 'codex' ? 'codex'
      : profile === 'pi' ? 'pi'
        : undefined
  );
}


async function resolveBootstrapAppConfig(opts: ResolveProfileRuntimeOptions, configPath: string, profile: string): Promise<AppConfig> {
  if (!opts.appId) {
    if (!isInteractiveTerminal() || !opts.prompts) {
      throw new Error(
        '当前没有配置，非交互模式无法完成扫码创建应用。' +
          '请先在终端运行 `lark-channel-bridge run` 完成首次初始化，' +
          '或传入 --app-id 和 --app-secret。',
      );
    }
    return opts.prompts.registerApp();
  }
  let appSecret = opts.appSecret;
  if (!appSecret) {
    if (!isInteractiveTerminal() || !opts.prompts) {
      throw new Error(
        `非交互模式缺少 App Secret: ${opts.appId}。` +
          '请传入 --app-secret <secret>，或在终端中重新运行命令后按提示输入。',
      );
    }
    appSecret = await opts.prompts.appSecret(opts.appId);
  }
  if (!appSecret) throw new Error('app secret is required');
  const tenant = tenantBrandFromString(opts.tenant);
  const network = await loadLarkNetworkConfig(configPath, profile);
  const result = await validateAppCredentials(opts.appId, appSecret, tenant, ...(network ? [network] as const : []));
  if (!result.ok) {
    throw new Error(`app credentials validation failed: ${result.reason ?? 'unknown'}`);
  }
  if (result.botName) {
    console.log(`✓ 应用凭证校验通过: ${result.botName}`);
  } else {
    console.log('✓ 应用凭证校验通过');
  }
  return {
    accounts: {
      app: {
        id: opts.appId,
        secret: appSecret,
        tenant,
      },
    },
  };
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function tenantBrandFromString(value: string | undefined): TenantBrand {
  if (value === undefined) return 'feishu';
  if (value === 'feishu' || value === 'lark') return value;
  throw new Error(`unsupported tenant: ${value}`);
}

function assertBootstrapAppMatchesExistingProfile(
  opts: ResolveProfileRuntimeOptions,
  profile: string,
  profileConfig: ProfileConfig,
): void {
  if (!opts.appId || opts.appId === profileConfig.accounts.app.id) return;
  throw new Error(
    `profile already exists: ${profile}; it uses app ${profileConfig.accounts.app.id}. ` +
      'omit --app-id or create another profile',
  );
}

function assertRequestedAgentMatchesExistingProfile(
  profile: string,
  profileConfig: ProfileConfig,
  requestedAgent: AgentKind | undefined,
): void {
  if (!requestedAgent || profileConfig.agentKind === requestedAgent) return;
  throw new Error(
    `profile ${profile} already exists with agentKind ${profileConfig.agentKind}, ` +
      `but this command requested --agent ${requestedAgent}. ` +
      `Profile names are labels; to use the existing ${profileConfig.agentKind} profile, omit --agent. ` +
      `To recreate it as ${requestedAgent}, remove profile ${profile} first.`,
  );
}

export async function materializeEnvSecretForService(
  opts: MaterializeEnvSecretForServiceOptions = {},
): Promise<boolean> {
  const rootDir = opts.config ? dirname(opts.config) : undefined;
  const explicitProfile = opts.profile;
  const activeProfile = explicitProfile ?? (await readActiveProfile(rootDir));
  let profile = activeProfile ?? 'claude';
  let appPaths = resolveAppPaths({ rootDir, profile });
  const configPath = opts.config ?? appPaths.configFile;

  const rootConfig = await loadRootConfig(configPath);
  if (rootConfig) {
    if (!explicitProfile && !activeProfile) {
      profile = rootConfig.activeProfile;
      appPaths = resolveAppPaths({ rootDir, profile });
    }
    const profileConfig = rootConfig.profiles[profile];
    if (!profileConfig) throw new Error(`profile not found: ${profile}`);
    const cfg = runtimeProfileConfig(rootConfig, profile);
    if (!isEnvBackedSecret(cfg.accounts.app.secret)) return false;

    const encrypted = await encryptedConfigForResolvedSecret(
      cfg,
      await resolveAppSecret(cfg, appPaths),
      appPaths,
    );
    rootConfig.profiles[profile] = {
      ...profileConfig,
      accounts: encrypted.accounts,
    };
    if (encrypted.secrets) rootConfig.secrets = encrypted.secrets;
    await saveRootConfig(rootConfig, configPath);
    return true;
  }

  return false;
}

function formatAmbiguousAgentSelectionError(
  detected: Array<{ kind: AgentKind; binaryPath: string }>,
): string {
  const lines = detected.map((agent) => `  - ${agent.kind}: ${agent.binaryPath}`);
  return [
    `检测到多个本地 agent，请使用 --agent <${AGENT_KINDS.join('|')}> 指定要初始化哪一个。`,
    '已检测到：',
    ...lines,
  ].join('\n');
}

async function selectDetectedAgent(
  detected: DetectedAgent[],
  selector: ResolveProfileRuntimeOptions['selectAgent'],
): Promise<AgentKind | undefined> {
  const selected = selector
    ? await selector(detected)
    : await promptForDetectedAgentSelection(detected);
  if (!selected) return undefined;
  return detected.some((agent) => agent.kind === selected) ? selected : undefined;
}

async function promptForDetectedAgentSelection(detected: DetectedAgent[]): Promise<AgentKind | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  p.intro('选择本地 agent');
  const selected = await p.select<AgentKind>({
    message: '检测到多个本地 agent，本次要初始化哪一个？',
    options: detected.map((agent) => ({
      value: agent.kind,
      label: displayAgentKind(agent.kind),
      hint: agent.binaryPath,
    })),
    initialValue: detected[0]?.kind,
  });
  if (p.isCancel(selected)) {
    p.cancel('已取消 agent 选择。');
    throw new UserCancelledError('已取消启动。');
  }
  p.outro(`已选择 ${displayAgentKind(selected)}`);
  return selected;
}

class UserCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserCancelledError';
  }
}

function displayAgentKind(kind: AgentKind): string {
  return agentDisplayName(kind);
}

async function encryptedConfigForProfile(
  cfg: AppConfig,
  appPaths: Pick<AppPaths, 'secretsGetterScript' | 'secretsFile' | 'keystoreSaltFile'>,
): Promise<AppConfig> {
  const secret = cfg.accounts.app.secret;
  if (typeof secret !== 'string') return cfg;
  const next = await buildEncryptedAccountConfig(
    cfg.accounts.app.id,
    cfg.accounts.app.tenant,
    cfg.preferences,
    appPaths,
  );
  await setSecret(secretKeyForApp(cfg.accounts.app.id), secret, appPaths);
  return next;
}

async function encryptedConfigForResolvedSecret(
  cfg: AppConfig,
  plaintext: string,
  appPaths: Pick<AppPaths, 'secretsGetterScript' | 'secretsFile' | 'keystoreSaltFile'>,
): Promise<AppConfig> {
  const next = await buildEncryptedAccountConfig(
    cfg.accounts.app.id,
    cfg.accounts.app.tenant,
    cfg.preferences,
    appPaths,
  );
  await setSecret(secretKeyForApp(cfg.accounts.app.id), plaintext, appPaths);
  return next;
}

function isEnvBackedSecret(secret: SecretInput): boolean {
  if (typeof secret === 'string') return ENV_SECRET_TEMPLATE_RE.test(secret);
  return isSecretRef(secret) && secret.source === 'env';
}
