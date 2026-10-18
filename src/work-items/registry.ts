import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { Controls } from '../commands';
import type { ModelSettings } from '../agent/model-settings';
import { resolveAppPaths } from '../config/app-paths';
import { resolveAppSecret } from '../config/secret-resolver';
import { getCotMessages } from '../config/schema';
import { CotClient } from '../bot/cot';
import { createRuntimeAgent } from '../runtime/agent-runtime';
import { EventSource } from './event-source';
import { createInvestigator } from './investigation';
import type { SourceAdapter, RuleAssessmentPolicy, InvestigationDriver } from './contracts';
import type { WorkItem } from './types';
import { normalizeInbox, type InboxConfig } from '../inbox/config';
import { InboxLark } from '../inbox/lark';
import { processAnalysis } from '../inbox/processor';
import { startInboxProgress } from '../inbox/progress';
import { InboxService } from '../inbox/service';
import { InboxStore } from '../inbox/store';
import { AnalysisScheduler } from './scheduler';
import type { WorkItemEvent } from './events';
import { executeInboxCommand } from '../inbox/workbench';
import { obj } from '../inbox/values';

export interface WorkItemSourceOptions {
  id: string; label: string; profile: string; enabled: boolean;
  controls?: Controls;
  notification?: Pick<InboxConfig, 'ownerOpenId' | 'destination' | 'deliveryMode'>;
  settings: ModelSettings;
  source?: SourceAdapter;
  assessment?: RuleAssessmentPolicy;
  driver: InvestigationDriver & { accepts?(item: WorkItem): boolean };
}
interface Entry { service: InboxService; lark?: InboxLark; label: string; close(): Promise<void> }

/** Source/account partitions share lifecycle code, the analysis queue and workbench. */
export class WorkItemSources {
  private entries = new Map<string, Entry>();
  constructor(private configPath: string, private rootDir?: string, readonly queue = new AnalysisScheduler()) {}
  list() { return [...this.entries.values()].flatMap(entry => entry.service.list(500)); }
  statuses() { return [...this.entries].map(([id, entry]) => ({ id, label: entry.label,
    running: entry.service.config.enabled, error: entry.service.lastError })); }
  async connect(options: WorkItemSourceOptions) {
    if (!/^[a-z][a-z0-9-]*$/.test(options.id)) throw new Error('Invalid inbox task source');
    if ((options.source && options.source.id !== options.id) || (!options.source && !options.driver.accepts)) throw new Error('Invalid source adapter');
    if (options.source && options.assessment) throw new Error('Configure assessment on the supplied source adapter');
    if (this.entries.has(options.id)) throw new Error('Inbox task source already connected');
    const config = normalizeInbox({ ...options.notification, executorProfile: options.profile,
      ownerOpenId: options.notification?.ownerOpenId || `local:${options.profile}`, enabled: options.enabled,
      watchPrivate: false, watchMentions: false });
    const scope = createHash('sha256').update(JSON.stringify([config.ownerOpenId, options.profile])).digest('hex').slice(0, 24);
    const folder = join(dirname(this.configPath), 'inbox', 'sources', options.id, scope);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const lease = join(folder, 'service'); await writeFile(lease, '', { flag: 'a', mode: 0o600 });
    let service: InboxService | undefined;
    const unlock = await lockfile.lock(lease, { stale: 60_000, update: 10_000, retries: 0,
      onCompromised: () => { void service?.close(); } });
    const lark = options.notification ? new InboxLark({ profile: options.profile, rootDir: this.rootDir }, config) : undefined;
    try {
      service = new InboxService(new InboxStore(join(folder, 'state.json')), config, {
        source: options.source ?? new EventSource(options.id, options.driver.accepts!, options.assessment),
        checkAccess: async () => {},
        cancel: () => lark?.close(),
        deliver: async (job, phase) => { await lark?.deliver(job, phase); },
        ...(lark ? { beginAnalysis: (job: Parameters<InboxLark['beginAnalysis']>[0], text: string) => lark.beginAnalysis(job, text) } : {}),
        investigate: async (job, signal) => {
          const controls = options.controls;
          if (!controls || !options.enabled) throw new Error('盯盘执行器未上线');
          let progress: Awaited<ReturnType<typeof startInboxProgress>>;
          let success = false;
          try {
            const result = await createInvestigator(options.driver, async prepared => {
              const paths = resolveAppPaths({ rootDir: this.rootDir, profile: options.profile });
              const agent = createRuntimeAgent(controls.profileConfig, { ...paths, configPath: this.configPath });
              if (controls.botIdentity) agent.setBotIdentity?.(controls.botIdentity);
              if (lark && getCotMessages(controls.cfg) !== 'off') {
                const secret = await resolveAppSecret(controls.cfg, paths);
                progress = await startInboxProgress(job, lark, new CotClient({ tenant: controls.cfg.accounts.app.tenant,
                  appId: controls.cfg.accounts.app.id, appSecret: secret }), getCotMessages(controls.cfg), signal);
              }
              return processAnalysis(agent, { runId: `inbox-${job.id}-${job.attempt}`, cwd: prepared.cwd,
                prompt: prepared.prompt, ...options.settings, deadlineAt: Date.now() + 30 * 60_000 }, signal, event => progress?.event(event));
            }, options.settings)(job, signal);
            success = true; return result;
          } finally { await progress?.finish(success); }
        },
      }, Date.now, this.queue);
      await service.start();
      const active = service;
      let closed = false;
      const entry: Entry = { service, lark, label: options.label, close: async () => {
        if (closed) return; closed = true;
        if (this.entries.get(options.id) === entry) this.entries.delete(options.id);
        await active.close(); await unlock();
      } };
      this.entries.set(options.id, entry);
      return { submit: (event: WorkItemEvent) => active.observe(event), observe: (event: WorkItemEvent) => active.observe(event), close: entry.close };
    } catch (error) { await service?.close(); lark?.close(); await unlock(); throw error; }
  }
  async command(input: unknown, scope?: { owner: string; profile: string }): Promise<{ handled: boolean; result?: unknown }> {
    const command = obj(input);
    if (['mode', 'scope', 'browse', 'manual'].includes(String(command.action))) return { handled: false };
    const target = ['review', 'batch'].includes(String(command.action)) && typeof command.target === 'string'
      ? obj(JSON.parse(command.target)) : { id: command.target };
    const ids = command.action === 'batch' && Array.isArray(target.items) ? target.items.map(item => obj(item).id) : [target.id];
    const entries = [...this.entries.values()].filter(entry => ids.some(id => typeof id === 'string' && entry.service.get(id)));
    if (!entries.length) return { handled: false };
    if (scope && entries.some(entry => entry.service.config.ownerOpenId !== scope.owner || entry.service.config.executorProfile !== scope.profile)) {
      throw new Error('待办不属于当前工作台');
    }
    if (entries.length !== 1 || !ids.every(id => typeof id === 'string' && entries[0]!.service.get(id))) {
      throw new Error('请按同一来源分别批量操作；本次未修改任何事项');
    }
    const entry = entries[0]!;
    return { handled: true, result: await executeInboxCommand(entry.service, entry.lark, input) };
  }
  async close() { await Promise.all([...this.entries.values()].map(entry => entry.close())); }
}
