import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { ClaudeAdapter } from '../../agent/claude/adapter';
import { CodexAdapter } from '../../agent/codex/adapter';
import { ChannelHost } from '../../channels/plugin';
import { createWebPlugin } from '../../channels/web/server';
import type { RunProfileConfig } from '../../config/profile-schema';
import { configureLogger, closeLogger } from '../../core/logger';

export interface RunWebOptions {
  agent: string;
  workspace: string;
  stateDir?: string;
  port?: string;
  binary?: string;
  model?: string;
}

/** Standalone browser channel: no Lark profile, credential bootstrap or SDK connection. */
export async function runWeb(options: RunWebOptions): Promise<void> {
  if (options.agent !== 'claude' && options.agent !== 'codex') throw new Error('agent must be claude or codex');
  const port = options.port === undefined ? 8787 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port');
  const workspace = await realpath(resolve(options.workspace));
  const stateDir = resolve(options.stateDir ?? join(homedir(), '.lark-channel', 'web', options.agent));
  configureLogger({ logsDir: join(stateDir, 'logs') });
  const agent = options.agent === 'claude' ? new ClaudeAdapter({ binary: options.binary })
    : new CodexAdapter({ binary: options.binary ?? 'codex', profileStateDir: stateDir,
        transport: 'app-server', ignoreRules: false, sandbox: 'workspace-write' });
  const availability = await agent.checkAvailability();
  if (!availability.ok) throw new Error(`${agent.displayName} is unavailable`);
  const config: RunProfileConfig = {
    agentKind: options.agent, preferences: { model: options.model, showToolCalls: true, maxConcurrentRuns: 4 },
    permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
    workspaces: { default: workspace },
    access: { allowedUsers: ['local'], allowedChats: [], admins: [], requireMentionInGroup: false },
    attachments: { maxCount: 0, maxBytes: 0, maxFileBytes: 0, imageMaxBytes: 0, cacheTtlMs: 0, cacheMaxBytes: 0 },
  };
  const host = new ChannelHost();
  const connection = await host.connect(createWebPlugin({ agent, config, stateDir, namespace: options.agent, port }));
  console.log(`Bridge Chat: ${connection.url}`);
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
