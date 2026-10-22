import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseDocument, resolveChannels } from '../../config/document';
import { resolveAppPaths } from '../../config/app-paths';
import { getSecret } from '../../config/keystore';
import { readActiveProfile } from '../../config/profile-store';
import { configureLogger, closeLogger } from '../../core/logger';
import { checkRuntimeAgentAvailability } from '../../runtime/agent-runtime';
import { ChannelHost } from '../../channels/plugin';
import { createSlackPlugin } from '../../channels/slack';
import { SLACK_SYSTEM_PROMPT } from '../../channels/slack/config';
import { ProfileExecutionController } from '../../runtime/execution-controller';
import { ScopeExecutionStore } from '../../session/scope-execution';
import { normalizeModelServices } from '../../model-service/config';
import { ModelProviderRegistry } from '../../model-provider/provider';
import type { AgentKind, RunProfileConfig } from '../../config/profile-schema';
import {
  selectStandaloneAgent,
  selectStandaloneProfile,
  standaloneProfile,
} from './standalone-profile';

export interface RunSlackOptions {
  agent?: string;
  profile?: string;
  config?: string;
  workspace: string;
  stateDir?: string;
  binary?: string;
  model?: string;
  teamId?: string;
  allowedUsers?: string;
  allowedChannels?: string;
  allowAllUsers?: boolean;
  showTools?: boolean;
  botTokenEnv?: string;
  appTokenEnv?: string;
  botTokenSecret?: string;
  appTokenSecret?: string;
}

export async function runSlack(options: RunSlackOptions): Promise<void> {
  const workspace = await realpath(resolve(options.workspace));
  const doc = options.config ? parseDocument(await readFile(options.config, 'utf8')) : undefined;
  const profile = selectStandaloneProfile(doc, doc ? options.profile : undefined);
  const defaultAgentKind = selectStandaloneAgent(doc, profile, options.agent);
  const namespace = profile ?? options.profile ?? 'default';
  const stateDir = resolve(
    options.stateDir ?? join(homedir(), '.lark-channel', 'slack', namespace),
  );
  configureLogger({ logsDir: join(stateDir, 'logs') });

  const profileConfig = standaloneProfile(doc, profile, defaultAgentKind, workspace, options);
  const configForAgent = (kind: AgentKind): RunProfileConfig =>
    standaloneProfile(doc, profile, kind, workspace, options, defaultAgentKind);
  const scopeExecution = new ScopeExecutionStore(join(stateDir, 'scope-execution.json'));
  await scopeExecution.load();
  const execution = new ProfileExecutionController({
    profileConfig,
    scopeExecution,
    appPaths: { profileDir: stateDir },
    systemPrompt: SLACK_SYSTEM_PROMPT,
    modelProviders: new ModelProviderRegistry(normalizeModelServices(doc?.model_services)),
  });
  const availability = await checkRuntimeAgentAvailability(execution.defaultAgent());
  if (!availability.ok) throw availability.error;

  const secretProfile = options.profile
    ?? profile
    ?? await readActiveProfile(resolveAppPaths().rootDir)
    ?? process.env.LARK_CHANNEL_PROFILE
    ?? resolveAppPaths().profile;
  const secretPaths = resolveAppPaths({ profile: secretProfile });
  const botToken = await resolveSlackToken(
    options.botTokenEnv ?? 'SLACK_BOT_TOKEN',
    options.botTokenSecret ?? 'slack-bot-token',
    secretPaths,
  );
  const appToken = await resolveSlackToken(
    options.appTokenEnv ?? 'SLACK_APP_TOKEN',
    options.appTokenSecret ?? 'slack-app-token',
    secretPaths,
  );

  const allowedUsers = splitIds(options.allowedUsers ?? process.env.SLACK_ALLOWED_USERS);
  const allowedChannels = splitIds(options.allowedChannels ?? process.env.SLACK_ALLOWED_CHANNELS);
  if (!options.allowAllUsers && allowedUsers.length === 0) {
    throw new Error(
      'Set --allowed-users/--allow-all-users (or SLACK_ALLOWED_USERS) before starting Slack',
    );
  }

  const host = new ChannelHost();
  const connection = await host.connect(createSlackPlugin({
    execution,
    config: configForAgent(defaultAgentKind),
    configForAgent,
    stateDir,
    namespace,
    systemPrompt: SLACK_SYSTEM_PROMPT,
    botToken,
    appToken,
    teamId: options.teamId,
    allowedUsers,
    allowedChannels,
    allowAllUsers: options.allowAllUsers,
    display: {
      ...(doc ? resolveChannels(doc, profile).slack : undefined),
      ...(options.showTools ? { show_tools: true } : {}),
    },
  }));
  console.log(
    `Slack Bridge connected: team=${connection.teamId} bot=${connection.botUserId} engine=${defaultAgentKind}`,
  );

  await new Promise<void>((resolveWait, reject) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      process.off('SIGINT', close);
      process.off('SIGTERM', close);
      host.close().finally(closeLogger).then(resolveWait, reject);
    };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
  });
}

async function resolveSlackToken(
  envName: string,
  secretId: string,
  secretPaths: ReturnType<typeof resolveAppPaths>,
): Promise<string> {
  const fromEnv = process.env[envName];
  if (fromEnv?.trim()) return fromEnv.trim();
  const stored = await getSecret(secretId, secretPaths);
  if (stored?.trim()) return stored.trim();
  throw new Error(
    `Slack token ${envName} is not set and keystore entry ${secretId} was not found`,
  );
}

function splitIds(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map(item => item.trim()).filter(Boolean))];
}
