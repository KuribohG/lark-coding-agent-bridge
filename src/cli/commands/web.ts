import { AGENT_KINDS } from '../../agent/backend-spec';
import { readFile } from 'node:fs/promises';
import {
  parseDocument,
  resolveChannels,
} from '../../config/document';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { ChannelHost } from '../../channels/plugin';
import { createWebPlugin } from '../../channels/web/server';
import { WEB_SYSTEM_PROMPT } from '../../channels/web/runtime';
import { isAgentKind } from '../../agent/backends';
import type {
  AgentKind,
  RunProfileConfig,
} from '../../config/profile-schema';
import { configureLogger, closeLogger } from '../../core/logger';
import { ProfileExecutionController } from '../../runtime/execution-controller';
import { checkRuntimeAgentAvailability } from '../../runtime/agent-runtime';
import { ScopeExecutionStore } from '../../session/scope-execution';
import { normalizeModelServices } from '../../model-service/config';
import { ModelProviderRegistry } from '../../model-provider/provider';
import {
  selectStandaloneAgent,
  selectStandaloneProfile,
  standaloneProfile,
} from './standalone-profile';

export interface RunWebOptions {
  agent?: string;
  profile?: string;
  config?: string;
  workspace: string;
  stateDir?: string;
  port?: string;
  binary?: string;
  model?: string;
}
/** Standalone browser channel: no Lark profile, credential bootstrap or SDK connection. */
export async function runWeb(options: RunWebOptions): Promise<void> {
  if (options.agent !== undefined && !isAgentKind(options.agent)) {
    throw new Error(`agent must be ${AGENT_KINDS.join(', ')}`);
  }
  const port = options.port === undefined ? 8787 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port');
  const workspace = await realpath(resolve(options.workspace));
  const stateDir = resolve(options.stateDir ?? join(homedir(), '.lark-channel', 'web', 'default'));
  configureLogger({ logsDir: join(stateDir, 'logs') });
  const doc = options.config ? parseDocument(await readFile(options.config, 'utf8')) : undefined;
  const profile = selectStandaloneProfile(doc, options.profile);
  const defaultAgentKind = selectStandaloneAgent(doc, profile, options.agent);
  const profileConfig = standaloneProfile(doc, profile, defaultAgentKind, workspace, options);
  const configForAgent = (kind: AgentKind): RunProfileConfig =>
    standaloneProfile(doc, profile, kind, workspace, options, defaultAgentKind);

  const scopeExecution = new ScopeExecutionStore(join(stateDir, 'scope-execution.json'));
  await scopeExecution.load();
  const execution = new ProfileExecutionController({
    profileConfig,
    scopeExecution,
    appPaths: { profileDir: stateDir },
    systemPrompt: WEB_SYSTEM_PROMPT,
    modelProviders: new ModelProviderRegistry(normalizeModelServices(doc?.model_services)),
  });
  const initialAgent = execution.defaultAgent();
  const availability = await checkRuntimeAgentAvailability(initialAgent);
  if (!availability.ok) throw availability.error;

  const host = new ChannelHost();
  const connection = await host.connect(createWebPlugin({
    execution,
    config: configForAgent(defaultAgentKind),
    configForAgent,
    stateDir,
    namespace: 'web',
    systemPrompt: WEB_SYSTEM_PROMPT,
    port,
    display: doc ? resolveChannels(doc, profile).web : undefined,
  }));
  console.log(`Bridge Chat: ${connection.url} (engine: ${defaultAgentKind})`);
  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      process.off('SIGINT', close); process.off('SIGTERM', close);
      host.close().finally(closeLogger).then(resolve, reject);
    };
    process.on('SIGINT', close); process.on('SIGTERM', close);
  });
}
