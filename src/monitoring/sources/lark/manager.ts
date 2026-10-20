import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { LarkMonitorProfiles } from './host';
import { resolveAppPaths } from '../../../config/app-paths';
import { withConfigFileLock } from '../../../config/profile-store';
import { loadMonitorRoot, saveMonitorRoot, monitorConfigPath, larkConfigRevision } from '../../store';
import { resolveAppSecret } from '../../../config/secret-resolver';
import { getCotMessages } from '../../../config/schema';
import { CotClient } from '../../../bot/cot';
import { inboxMode, intakeScope, normalizeInbox, validateInbox, type InboxConfig, type InboxMode, type IntakeScope } from '../../../inbox/config';
import { inboxTriageSource, loadInboxTriageSource } from '../../../inbox/model-routing';
import { backgroundModelSettings } from '../../../runtime/background-model';
import { supportsBackgroundProfile } from '../../../runtime/agent-capabilities';
import { getUserAuthStatus } from '../../../lark-cli/user-im';
import { guiJobs } from '../../../inbox/presentation';
import { executeInboxCommand, executeSourceCommand } from '../../../inbox/workbench';
import { processInbox } from './processor';
import { startInboxProgress } from '../../../inbox/progress';
import { createRuntimeAgent } from '../../../runtime/agent-runtime';
import { triageWithChatTools } from './codex-triage';
import { InboxReadTools } from './read-tools';
import { InboxLark } from '../../../inbox/lark';
import { InboxService } from '../../../inbox/service';
import { InboxStore } from '../../../inbox/store';
import { InboxH5Auth } from '../../../inbox/h5-auth';
import { startInboxH5 } from '../../../inbox/h5-server';
import { InboxCards, type InboxCardContext } from '../../../inbox/cards';
import { CallbackAuth } from '../../../card/callback-auth';
import { CallbackNonceStore } from '../../../card/callback-store';
import { InboxGui } from '../../../inbox/gui';
import { InboxTaskSources } from '../../../inbox/task-sources';
import { larkRuntime } from './runtime';

const connectionConfig = ({ enabled: _, autoAnalyze: __, intakeScope: ___, analysisTimeoutMinutes: ____, watchPrivate, watchMentions, ...config }: InboxConfig) =>
  ({ ...config, legacyIntake: watchPrivate ? undefined : { watchPrivate, watchMentions } });

export class InboxManager {
  readonly sources: InboxTaskSources;
  private service?: InboxService;
  private cards?: InboxCards;
  private lark?: InboxLark;
  private nonces?: CallbackNonceStore;
  private h5?: { close(): Promise<void> };
  private gui?: InboxGui;
  private unlock?: () => Promise<void>;
  private fingerprint = '';
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  error?: string;
  constructor(private configPath: string, private profiles: LarkMonitorProfiles, private rootDir?: string, private sharedSources?: InboxTaskSources) {
    this.sources = sharedSources ?? new InboxTaskSources(configPath);
    this.timer = setInterval(() => { void this.reconcile(); }, 15_000);
    this.timer.unref();
  }
  async view() {
    let config = this.service?.config ?? normalizeInbox(undefined);
    let configFile: string | undefined;
    let configRevision: string | undefined;
    try {
      const root = await loadMonitorRoot(this.configPath);
      config = normalizeInbox(root?.inbox);
      configFile = root ? monitorConfigPath(root, this.configPath) : undefined;
      configRevision = root ? larkConfigRevision(root) : undefined;
    } catch (error) { this.error = error instanceof Error ? error.message : '监控配置读取失败'; }
    return { config, configFile, configRevision, running: Boolean(this.service?.config.enabled), error: this.error || this.service?.lastError || this.gui?.lastError,
      jobs: this.service?.list().map(({ messages: _, result: __, ...j }) => j) || [] };
  }
  async workbench() {
    const view = await this.view();
    const sources = this.sources.statuses();
    const jobs = [...(this.service?.list(500).filter(j => j.ownerOpenId === view.config.ownerOpenId && j.profile === view.config.executorProfile) ?? []), ...this.sources.list()];
    return { ...view, connected: Boolean(this.service) || sources.length > 0, sources,
      jobs: guiJobs(jobs) };
  }
  async workbenchCommand(input: unknown) {
    const source = await executeSourceCommand(this.sources, input);
    if (source.handled) return source.result;
    const service = this.service, lark = this.lark;
    if (!service || !lark) throw new Error('请先完成配置并启动执行 profile');
    return executeInboxCommand(service, lark, input, mode => this.changeMode(service, mode), scope => this.changeScope(service, scope));
  }
  async checkSetup(input: unknown) {
    const config = normalizeInbox(input);
    const root = await loadMonitorRoot(this.configPath);
    const profile = root?.profiles[config.executorProfile];
    const checks: { label: string; ok: boolean; detail: string }[] = [];
    const check = async (label: string, fn: () => Promise<string> | string) => {
      try { checks.push({ label, ok: true, detail: await fn() }); }
      catch (error) { checks.push({ label, ok: false, detail: error instanceof Error ? error.message : '检查失败' }); }
    };
    await check('执行环境', () => {
      if (!profile || !supportsBackgroundProfile(profile)) throw new Error('请选择支持后台分析的个人 profile');
      if (!this.profiles(config.executorProfile)) throw new Error('请先在上方启动这个 profile');
      return config.executorProfile;
    });
    let ownerOpenId = '';
    if (profile) {
      await check('飞书用户授权', async () => {
        const auth = await getUserAuthStatus({ profile: config.executorProfile, rootDir: this.rootDir });
        ownerOpenId = auth.openId ?? '';
        if (!ownerOpenId) throw new Error('请先完成飞书用户授权；若未安装 lark-cli，请运行 npm install -g @larksuite/cli@1.0.77 并重启 profile');
        if (config.ownerOpenId && ownerOpenId !== config.ownerOpenId) throw new Error('授权用户与助理所属用户不一致');
        const missing = ['search:message', 'im:chat:read', 'im:message.p2p_msg:get_as_user', 'im:message.group_msg:get_as_user'].filter(s => !auth.scopes.includes(s));
        if (missing.length) throw new Error(`缺少授权：${missing.join('、')}`);
        if (profile.larkCli.identityPreset !== 'user-default') throw new Error('请在 profile 设置中允许已授权用户身份，或完成本页的授权流程');
        return auth.userName || ownerOpenId;
      });
      await check('模型配置', async () => {
        const provider = await loadInboxTriageSource(config, inboxTriageSource(config, root!), this.rootDir);
        return `${provider.model}（已找到 Responses API 配置与凭据；尚未请求模型）`;
      });
      await check('深入分析模型', async () => {
        const paths = resolveAppPaths({ rootDir: this.rootDir, profile: config.executorProfile });
        const settings = await backgroundModelSettings(profile, paths.profileDir, config.analysisModel);
        return `${settings.model || '执行 profile / CLI 默认模型'}（${profile.agentKind}）`;
      });
    }
    await check('结果话题配置', () => {
      validateInbox({ ...config, ownerOpenId: config.ownerOpenId || ownerOpenId, enabled: true });
      return '已填写；请确保机器人在结果群内并可发消息';
    });
    return { checks, ownerOpenId, ok: checks.every(c => c.ok) };
  }
  async command(args: string, ctx: InboxCardContext): Promise<string | undefined> {
    if (args === 'setup') {
      const controls = this.profiles(ctx.profile);
      if (!controls || !supportsBackgroundProfile(controls.profileConfig)) return '请使用支持后台分析的个人 profile 的机器人设置会话助理。';
      if (!ctx.threadId) return '请在结果群的目标话题内发送 /inbox setup。';
      const auth = await getUserAuthStatus({ profile: ctx.profile, rootDir: this.rootDir });
      if (auth.openId !== ctx.operator) return '请先在本地控制台完成当前 profile 的用户授权，再由该用户发送 /inbox setup。';
      const current = (await this.view()).config;
      if (current.ownerOpenId && current.ownerOpenId !== ctx.operator) return '此助理已属于另一用户，请使用独立配置目录。';
      await this.configure({ ...current, executorProfile: ctx.profile, ownerOpenId: ctx.operator,
        destination: { chatId: ctx.chatId, threadId: ctx.threadId, replyTo: ctx.messageId } });
      return '已记录当前结果话题。请在本地控制台的会话助理设置中点击“重新读取设置”，检查模型配置后开启。';
    }
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
      const root = await loadMonitorRoot(this.configPath);
      if (!root) throw new Error('找不到 Bridge 配置');
      const expected = input && typeof input === 'object' ? (input as { configRevision?: unknown }).configRevision : undefined;
      if (expected !== undefined && expected !== larkConfigRevision(root)) throw new Error('飞书监控配置已更新，请重新读取设置后保存；本次未覆盖');
      const p = root.profiles[config.executorProfile];
      if (config.enabled && (!p || !supportsBackgroundProfile(p))) throw new Error('请选择支持后台分析的个人 profile');
      if (config.enabled || config.triageService) inboxTriageSource(config, root);
      root.inbox = config; await saveMonitorRoot(root, this.configPath);
    });
    await this.reconcile(); return this.view();
  }
  reconcile(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const p = this.chain.then(() => this.reload()).catch(async error => {
      this.error = error instanceof Error ? error.message : '监控配置读取失败';
      const executor = this.service && this.profiles(this.service.config.executorProfile);
      if (this.service && (!executor || !supportsBackgroundProfile(executor.profileConfig))) await this.stop();
    }); this.chain = p.catch(() => {}); return p;
  }
  private async changeMode(service: InboxService, mode: InboxMode): Promise<void> {
    // Do not reconcile here: this callback is awaited by the GUI poll itself.
    await withConfigFileLock(this.configPath, async () => {
      const root = await loadMonitorRoot(this.configPath);
      const config = normalizeInbox(root?.inbox);
      if (!root || this.service !== service || JSON.stringify(connectionConfig(config)) !== JSON.stringify(connectionConfig(service.config))) {
        throw new Error('助理配置正在更新，请稍后重试');
      }
      config.enabled = mode !== 'off'; config.autoAnalyze = false; validateInbox(config);
      await service.setMode(mode, async () => { root.inbox = config; await saveMonitorRoot(root, this.configPath); });
    });
  }
  private async changeScope(service: InboxService, scope: IntakeScope): Promise<void> {
    await withConfigFileLock(this.configPath, async () => {
      const root = await loadMonitorRoot(this.configPath);
      const config = normalizeInbox(root?.inbox);
      if (!root || this.service !== service || JSON.stringify(connectionConfig(config)) !== JSON.stringify(connectionConfig(service.config))) {
        throw new Error('助理配置正在更新，请稍后重试');
      }
      const next = normalizeInbox({ ...config, intakeScope: scope });
      await service.setScope(scope, async () => { root.inbox = next; await saveMonitorRoot(root, this.configPath); });
    });
  }
  private async reload(): Promise<void> {
    if (this.closed) return;
    const root = await loadMonitorRoot(this.configPath); const config = normalizeInbox(root?.inbox);
    const controls = this.profiles(config.executorProfile);
    const sourceProfile = config.triageService ? undefined : root?.profiles[config.triageProfile || config.executorProfile];
    const fingerprint = JSON.stringify([connectionConfig(config), controls?.cfg.accounts.app, controls?.botIdentity?.openId, controls?.profileConfig.mode, controls?.profileConfig.agentKind, controls?.profileConfig.codex, controls?.profileConfig.preferences,
      sourceProfile?.agentKind, sourceProfile?.mode, sourceProfile?.codex, sourceProfile?.preferences,
      config.triageService ? root?.modelServices?.[config.triageService] : undefined]);
    if (this.service && controls && fingerprint === this.fingerprint) {
      await withConfigFileLock(this.configPath, async () => {
        const latest = normalizeInbox((await loadMonitorRoot(this.configPath))?.inbox);
        if (this.service) this.service.config.analysisTimeoutMinutes = latest.analysisTimeoutMinutes;
        if (this.service && intakeScope(latest) && intakeScope(latest) !== intakeScope(this.service.config)) await this.service.setScope(intakeScope(latest)!);
        if (this.service && inboxMode(latest) !== inboxMode(this.service.config)) await this.service.setMode(inboxMode(latest));
      });
      this.error = undefined;
      return;
    }
    await this.stop();
    if (!config.enabled && !config.gui.publicUrl && !config.executorProfile) { this.error = undefined; return; }
    try {
      validateInbox({ ...config, enabled: true });
      if (!controls) throw new Error('执行 profile 尚未上线');
      if (controls.profileConfig.mode === 'team') throw new Error('团队模式不允许使用个人收件助理');
      if (!supportsBackgroundProfile(controls.profileConfig)) throw new Error('当前 profile 尚不支持后台分析');
      const triageSource = inboxTriageSource(config, root!);
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
      }, config.ownerOpenId);
      const secret = await resolveAppSecret(controls.cfg, paths);
      const cotClient = new CotClient({ tenant: controls.cfg.accounts.app.tenant, appId: controls.cfg.accounts.app.id, appSecret: secret });
      this.service = new InboxService(new InboxStore(join(folder, 'state.json')), config, larkRuntime(config, {
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
              config.attentionProfile, signal, config.analysisTimeoutMinutes * 60_000, event => progress?.event(event),
              await backgroundModelSettings(controls.profileConfig, paths.profileDir, config.analysisModel));
            success = true;
            return result;
          } finally { await progress?.finish(success); }
        },
        triage: async (jobs, signal, onProgress) => triageWithChatTools(jobs, config.attentionProfile,
          await loadInboxTriageSource(config, triageSource, this.rootDir), readTools, signal, onProgress, undefined, undefined, config),
        notifyAttention: (jobs, id) => lark.notifyAttention(jobs, id),
      }), Date.now, this.sources.queue);
      this.nonces = new CallbackNonceStore(join(folder, 'card-nonces.json'));
      await this.nonces.load();
      const cards = new InboxCards(this.service, lark, new CallbackAuth({ keys: [{ version: 1, secret }], nonceStore: this.nonces }), this.nonces);
      this.cards = cards;
      lark.reminderCard = (job, content) => cards.reminder(job, content);
      await this.service.start();
      if (config.gui.publicUrl) {
        const service = this.service;
        this.gui = new InboxGui(service, lark, controls.cfg.accounts.app.id, join(folder, 'gui-receipts.json'), fetch,
          mode => this.changeMode(service, mode), scope => this.changeScope(service, scope), this.sources);
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
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.timer);
    await this.chain; await this.stop(); if (!this.sharedSources) await this.sources.close();
  }
}
