import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { Controls } from '../commands';
import { resolveAppPaths } from '../config/app-paths';
import { loadRootConfig, saveRootConfig, withConfigFileLock } from '../config/profile-store';
import { resolveAppSecret } from '../config/secret-resolver';
import { getCotMessages } from '../config/schema';
import { CotClient } from '../bot/cot';
import { inboxMode, intakeScope, normalizeInbox, validateInbox, type InboxConfig, type InboxMode, type IntakeScope } from './config';
import { loadAnalysisProvider } from './analyzer';
import { processInbox } from './processor';
import { startInboxProgress } from './progress';
import { createRuntimeAgent } from '../runtime/agent-runtime';
import { triageWithChatTools } from './codex-triage';
import { InboxReadTools } from './read-tools';
import { InboxLark } from './lark';
import { InboxService } from './service';
import { InboxStore } from './store';
import { InboxH5Auth } from './h5-auth';
import { startInboxH5 } from './h5-server';
import { InboxCards, type InboxCardContext } from './cards';
import { CallbackAuth } from '../card/callback-auth';
import { CallbackNonceStore } from '../card/callback-store';
import { InboxGui } from './gui';

const connectionConfig = ({ enabled: _, autoAnalyze: __, intakeScope: ___, watchPrivate, watchMentions, ...config }: InboxConfig) =>
  ({ ...config, legacyIntake: watchPrivate ? undefined : { watchPrivate, watchMentions } });

export class InboxManager {
  private service?: InboxService;
  private cards?: InboxCards;
  private lark?: InboxLark;
  private nonces?: CallbackNonceStore;
  private h5?: { close(): Promise<void> };
  private gui?: InboxGui;
  private unlock?: () => Promise<void>;
  private fingerprint = '';
  private chain: Promise<unknown> = Promise.resolve();
  error?: string;
  constructor(private configPath: string, private controls: (profile: string) => Controls | undefined, private rootDir?: string) {}
  async view() {
    const root = await loadRootConfig(this.configPath);
    return { config: normalizeInbox(root?.inbox), running: Boolean(this.service?.config.enabled), error: this.error || this.service?.lastError || this.gui?.lastError,
      jobs: this.service?.list().map(({ messages: _, result: __, ...j }) => j) || [] };
  }
  async command(args: string, ctx: InboxCardContext): Promise<string | undefined> {
    const cards = this.cards; const lark = this.lark;
    if (!cards || !lark) return '会话助理当前未运行，请检查 Bridge 全局设置中的开关和运行状态。';
    if (!cards.accepts(ctx)) return '请由助理所属用户在配置的结果群话题中发送 /inbox。';
    if (this.service?.config.gui.publicUrl && (!args || ['open', 'private', 'groups', 'pending'].includes(args))) {
      return `会话助理工作台：${this.service.config.gui.publicUrl}\n在页面中查看待办、选择会话和查看分析结果。`;
    }
    try { await cards.handle(args, ctx); }
    catch (error) {
      return error instanceof Error ? error.message : '助理操作失败，请重新发送 /inbox';
    }
  }
  async configure(input: unknown) {
    const config = normalizeInbox(input); validateInbox(config);
    await withConfigFileLock(this.configPath, async () => {
      const root = await loadRootConfig(this.configPath);
      if (!root) throw new Error('找不到 Bridge 配置');
      const p = root.profiles[config.executorProfile];
      if (config.enabled && (!p || p.mode === 'team' || p.agentKind !== 'codex')) throw new Error('请选择个人模式的 Codex profile');
      root.inbox = config; await saveRootConfig(root, this.configPath);
    });
    await this.reconcile(); return this.view();
  }
  reconcile(): Promise<void> {
    const p = this.chain.then(() => this.reload()); this.chain = p.catch(() => {}); return p;
  }
  private async changeMode(service: InboxService, mode: InboxMode): Promise<void> {
    // Do not reconcile here: this callback is awaited by the GUI poll itself.
    await withConfigFileLock(this.configPath, async () => {
      const root = await loadRootConfig(this.configPath);
      const config = normalizeInbox(root?.inbox);
      if (!root || this.service !== service || JSON.stringify(connectionConfig(config)) !== JSON.stringify(connectionConfig(service.config))) {
        throw new Error('助理配置正在更新，请稍后重试');
      }
      config.enabled = mode !== 'off'; config.autoAnalyze = false; validateInbox(config);
      await service.setMode(mode, async () => { root.inbox = config; await saveRootConfig(root, this.configPath); });
    });
  }
  private async changeScope(service: InboxService, scope: IntakeScope): Promise<void> {
    await withConfigFileLock(this.configPath, async () => {
      const root = await loadRootConfig(this.configPath);
      const config = normalizeInbox(root?.inbox);
      if (!root || this.service !== service || JSON.stringify(connectionConfig(config)) !== JSON.stringify(connectionConfig(service.config))) {
        throw new Error('助理配置正在更新，请稍后重试');
      }
      const next = normalizeInbox({ ...config, intakeScope: scope });
      await service.setScope(scope, async () => { root.inbox = next; await saveRootConfig(root, this.configPath); });
    });
  }
  private async reload(): Promise<void> {
    const root = await loadRootConfig(this.configPath); const config = normalizeInbox(root?.inbox);
    const controls = this.controls(config.executorProfile);
    const fingerprint = JSON.stringify([connectionConfig(config), controls?.cfg.accounts.app, controls?.botIdentity?.openId, controls?.profileConfig.mode, controls?.profileConfig.codex, controls?.profileConfig.preferences.model]);
    if (this.service && controls && fingerprint === this.fingerprint) {
      await withConfigFileLock(this.configPath, async () => {
        const latest = normalizeInbox((await loadRootConfig(this.configPath))?.inbox);
        if (this.service && intakeScope(latest) && intakeScope(latest) !== intakeScope(this.service.config)) await this.service.setScope(intakeScope(latest)!);
        if (this.service && inboxMode(latest) !== inboxMode(this.service.config)) await this.service.setMode(inboxMode(latest));
      });
      return;
    }
    await this.stop();
    if (!config.enabled && !config.gui.publicUrl) { this.error = undefined; return; }
    try {
      validateInbox({ ...config, enabled: true });
      if (!controls) throw new Error('执行 profile 尚未上线');
      if (controls.profileConfig.mode === 'team') throw new Error('团队模式不允许使用个人收件助理');
      const paths = resolveAppPaths({ rootDir: this.rootDir, profile: config.executorProfile });
      const folder = join(dirname(this.configPath), 'inbox');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const lease = join(folder, 'service'); await writeFile(lease, '', { flag: 'a', mode: 0o600 });
      this.unlock = await lockfile.lock(lease, { stale: 60_000, update: 10_000, retries: 0, onCompromised: () => { void this.close(); } });
      const lark = new InboxLark({ profile: config.executorProfile, rootDir: this.rootDir }, config);
      this.lark = lark;
      const agent = createRuntimeAgent(controls.profileConfig, { ...paths, configPath: this.configPath });
      if (controls.botIdentity) agent.setBotIdentity?.(controls.botIdentity);
      const readTools = new InboxReadTools(async (args, signal) => {
        const reader = new InboxLark({ profile: config.executorProfile, rootDir: this.rootDir }, config);
        const cancel = () => reader.close();
        signal.addEventListener('abort', cancel, { once: true });
        try {
          signal.throwIfAborted();
          await reader.checkOwner(config.ownerOpenId);
          signal.throwIfAborted();
          return await reader.callValue(args);
        } finally { signal.removeEventListener('abort', cancel); reader.close(); }
      });
      const secret = await resolveAppSecret(controls.cfg, paths);
      const cotClient = new CotClient({ tenant: controls.cfg.accounts.app.tenant, appId: controls.cfg.accounts.app.id, appSecret: secret });
      this.service = new InboxService(new InboxStore(join(folder, 'state.json')), config, {
        selfSenderIds: [controls.cfg.accounts.app.id, controls.botIdentity?.openId].filter((id): id is string => Boolean(id)),
        cancel: () => lark.close(),
        cancelPending: () => lark.cancelPending(),
        checkOwner: id => lark.checkOwner(id), collect: (...args) => lark.collect(...args), context: (...args) => lark.context(...args),
        source: id => lark.source(id), deliver: (...args) => lark.deliver(...args),
        beginAnalysis: (job, text) => lark.beginAnalysis(job, text),
        analyze: async (job, signal) => {
          const progress = await startInboxProgress(job, lark, cotClient, getCotMessages(controls.cfg), signal);
          let success = false;
          try {
            const result = await processInbox(job, agent, controls.profileConfig.workspaces.default || paths.defaultWorkspaceDir,
              config.attentionProfile, signal, undefined, event => progress?.event(event));
            success = true;
            return result;
          } finally { await progress?.finish(success); }
        },
        triage: async (jobs, signal, onProgress) => triageWithChatTools(jobs, config.attentionProfile,
          await loadAnalysisProvider(controls.profileConfig), readTools, signal, onProgress),
        notifyAttention: (jobs, id) => lark.notifyAttention(jobs, id),
      });
      this.nonces = new CallbackNonceStore(join(folder, 'card-nonces.json'));
      await this.nonces.load();
      const cards = new InboxCards(this.service, lark, new CallbackAuth({ keys: [{ version: 1, secret }], nonceStore: this.nonces }), this.nonces);
      this.cards = cards;
      lark.reminderCard = (job, content) => cards.reminder(job, content);
      await this.service.start();
      if (config.gui.publicUrl) {
        const service = this.service;
        this.gui = new InboxGui(service, lark, controls.cfg.accounts.app.id, join(folder, 'gui-receipts.json'), fetch,
          mode => this.changeMode(service, mode), scope => this.changeScope(service, scope));
        await this.gui.start();
      }
      if (config.h5.publicUrl) {
        const auth = new InboxH5Auth(controls.cfg.accounts.app.id, secret, config.ownerOpenId, config.h5.publicUrl, controls.cfg.accounts.app.tenant);
        this.h5 = await startInboxH5(this.service, auth);
      }
      this.fingerprint = fingerprint; this.error = undefined;
    } catch (e) {
      this.error = e instanceof Error ? e.message : '助理启动失败'; await this.stop();
    }
  }
  private async stop(): Promise<void> {
    // Disable work before closing the listener, so active HTTP requests cannot queue new jobs.
    const service = this.service; this.service = undefined;
    this.cards = undefined;
    const gui = this.gui; this.gui = undefined;
    await gui?.close();
    await service?.close();
    this.lark?.close(); this.lark = undefined;
    await this.nonces?.flush(); this.nonces = undefined;
    await this.h5?.close(); this.h5 = undefined;
    await this.unlock?.(); this.unlock = undefined;
    this.fingerprint = '';
  }
  async close(): Promise<void> { await this.chain; await this.stop(); }
}
