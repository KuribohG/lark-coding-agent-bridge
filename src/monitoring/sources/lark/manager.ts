import { defaultWorkspaceFor, managedWorkspaceFor } from '../../../agent/state-layout';
import { dirname, join } from 'node:path';
import type { LarkMonitorProfiles } from './host';
import { resolveAppPaths } from '../../../config/app-paths';
import { withConfigFileLock } from '../../../config/profile-store';
import { loadMonitorRoot, saveMonitorRoot, monitorConfigPath, larkConfigRevision, concurrencyConfigRevision, monitorSectionErrors } from '../../store';
import { parseWorkItemConcurrency } from '../../../work-items/concurrency';
import { LarkProfileAuth } from '../../../lark-auth/profile-auth';
import { getCotMessages } from '../../../config/schema';
import { CotClient } from '../../../channels/lark/cot';
import { inboxMode, inboxWorkbenchUrl, normalizeInbox, validateInbox, type InboxConfig, type InboxMode, type IntakeScope } from '../../../inbox/config';
import { inboxTriageService, loadInboxTriageService } from '../../../inbox/model-routing';
import { backgroundModelSettings } from '../../../runtime/background-model';
import { supportsBackgroundProfile } from '../../../runtime/agent-capabilities';
import { getUserAuthStatus } from '../../../lark-cli/user-im';
import { guiJobs } from '../../../inbox/presentation';
import { executeInboxCommand, executeSourceCommand } from '../../../inbox/workbench';
import { processInbox } from './processor';
import { startInboxProgress } from '../../../inbox/progress';
import { createLarkRuntimeAgent } from '../../../channels/lark/agent-host';
import { triageWithChatTools } from './codex-triage';
import { InboxReadTools } from './read-tools';
import { InboxLark } from '../../../inbox/lark';
import { WorkItemService } from '../../../work-items/service';
import { WorkItemStore } from '../../../work-items/store';
import { InboxH5Auth } from '../../../inbox/h5-auth';
import { startInboxH5 } from '../../../inbox/h5-server';
import { InboxCards, type InboxCardContext } from '../../../inbox/cards';
import { CallbackAuth } from '../../../card/callback-auth';
import { CallbackNonceStore } from '../../../card/callback-store';
import { InboxGui } from '../../../inbox/gui';
import { WorkItemSources } from '../../../work-items/registry';
import { startInboxControl, type InboxControlHandle } from '../../../inbox/control-server';
import { larkRuntime } from './runtime';
import { larkSource } from './source';
import { ReconcileLoop } from '../../reconcile-loop';
import { acquireStateLease } from '../../../platform/state-lease';

const connectionConfig = ({ enabled: _, intakeScope: __, analysisTimeoutMinutes: ___, workbenchUrl: ____, ...config }: InboxConfig) => config;

export class InboxManager extends ReconcileLoop {
  readonly sources: WorkItemSources;
  private service?: WorkItemService<InboxConfig>;
  private cards?: InboxCards;
  private lark?: InboxLark;
  private nonces?: CallbackNonceStore;
  private h5?: { close(): Promise<void> };
  private gui?: InboxGui;
  private control?: InboxControlHandle;
  private unlock?: () => Promise<void>;
  private fingerprint = '';
  private ownedLarkAuth?: LarkProfileAuth;
  private releaseNetwork?: () => Promise<void>;
  constructor(private configPath: string, private profiles: LarkMonitorProfiles, private rootDir?: string, private sharedSources?: WorkItemSources) {
    super('inbox', '监控配置读取失败');
    this.sources = sharedSources ?? new WorkItemSources(configPath);
  }
  async view() {
    let config = this.service?.config ?? normalizeInbox(undefined);
    let configFile: string | undefined;
    let configRevision: string | undefined;
    let concurrency = this.sources.concurrency;
    let concurrencyRevision: string | undefined;
    try {
      const root = await loadMonitorRoot(this.configPath);
      config = normalizeInbox(root?.inbox);
      configFile = root ? monitorConfigPath(root, this.configPath) : undefined;
      configRevision = root ? larkConfigRevision(root) : undefined;
      concurrency = parseWorkItemConcurrency(root?.workItemConcurrency);
      concurrencyRevision = root ? concurrencyConfigRevision(root) : undefined;
    } catch (error) { this.error = error instanceof Error ? error.message : '监控配置读取失败'; }
    return { config, configFile, configRevision, concurrency, concurrencyRevision, running: Boolean(this.service?.config.enabled), error: this.error || this.service?.lastError || this.gui?.lastError,
      jobs: this.service?.list().map(({ messages: _, result: __, ...j }) => j) || [] };
  }
  async workbench() {
    const view = await this.view();
    const sources = this.sources.statuses();
    const jobs = [...(this.service?.list(500).filter(j => j.ownerKey === view.config.ownerKey && j.profile === view.config.executorProfile) ?? []), ...this.sources.list()];
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
        if (config.recipientKey && ownerOpenId !== config.recipientKey) throw new Error('授权用户与助理所属用户不一致');
        const missing = ['search:message', 'im:chat:read', 'im:message.p2p_msg:get_as_user', 'im:message.group_msg:get_as_user'].filter(s => !auth.scopes.includes(s));
        if (missing.length) throw new Error(`缺少授权：${missing.join('、')}`);
        if (profile.larkCli.identityPreset !== 'user-default') throw new Error('请在 profile 设置中允许已授权用户身份，或完成本页的授权流程');
        return auth.userName || ownerOpenId;
      });
      await check('模型配置', async () => {
        const provider = await loadInboxTriageService(config, inboxTriageService(config, root!));
        return `${provider.model}（已找到 Responses API 配置与凭据；尚未请求模型）`;
      });
      await check('深入分析模型', async () => {
        const paths = resolveAppPaths({ rootDir: this.rootDir, profile: config.executorProfile });
        const settings = await backgroundModelSettings(profile, paths.profileDir, config.analysisModel);
        return `${settings.model || '执行 profile / CLI 默认模型'}（${profile.agentKind}）`;
      });
    }
    await check('结果话题配置', () => {
      const recipientKey = config.recipientKey || ownerOpenId;
      validateInbox({ ...config, recipientKey, ownerKey: recipientKey, enabled: true });
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
      if (current.recipientKey && current.recipientKey !== ctx.operator) return '此助理已属于另一用户，请使用独立配置目录。';
      await this.configure({ ...current, executorProfile: ctx.profile, recipientKey: ctx.operator, ownerKey: ctx.operator,
        target: { transport: 'lark', containerId: ctx.chatId, threadId: ctx.threadId, replyTo: ctx.messageId } });
      return '已记录当前结果话题。请在本地控制台的会话助理设置中点击“重新读取设置”，检查模型配置后开启。';
    }
    const cards = this.cards; const lark = this.lark;
    if (!cards || !lark) return '会话助理当前未运行，请检查 Bridge 全局设置中的开关和运行状态。';
    if (!cards.accepts(ctx)) return '请由助理所属用户在配置的结果群话题中发送 /inbox。';
    if (this.service && inboxWorkbenchUrl(this.service.config) && (!args || ['open', 'private', 'groups', 'pending'].includes(args))) {
      return `会话助理工作台：${inboxWorkbenchUrl(this.service.config)}\n在页面中查看待办、选择会话和查看分析结果。`;
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
      if (config.enabled || config.triageService) inboxTriageService(config, root);
      root.inbox = config; await saveMonitorRoot(root, this.configPath);
    });
    await this.reconcile(); return this.view();
  }
  async configureConcurrency(input: unknown) {
    if (!input || typeof input !== 'object' || !('concurrency' in input)) throw new Error('缺少并发配置');
    const config = parseWorkItemConcurrency(input.concurrency);
    await withConfigFileLock(this.configPath, async () => {
      const root = await loadMonitorRoot(this.configPath);
      if (!root) throw new Error('找不到 Bridge 配置');
      const expected = 'concurrencyRevision' in input ? input.concurrencyRevision : undefined;
      if (expected !== undefined && expected !== concurrencyConfigRevision(root)) throw new Error('并发配置已更新，请重新读取设置后保存；本次未覆盖');
      root.workItemConcurrency = config;
      await saveMonitorRoot(root, this.configPath);
      this.sources.configureConcurrency(config);
    });
    return this.view();
  }
  protected async recover(): Promise<void> {
    const executor = this.service && this.profiles(this.service.config.executorProfile);
    if (this.service && (!executor || !supportsBackgroundProfile(executor.profileConfig))) await this.stop();
  }
  private async changeMode(service: WorkItemService<InboxConfig>, mode: InboxMode): Promise<void> {
    // Do not reconcile here: this callback is awaited by the GUI poll itself.
    await withConfigFileLock(this.configPath, async () => {
      const root = await loadMonitorRoot(this.configPath);
      const config = normalizeInbox(root?.inbox);
      if (!root || this.service !== service || JSON.stringify(connectionConfig(config)) !== JSON.stringify(connectionConfig(service.config))) {
        throw new Error('助理配置正在更新，请稍后重试');
      }
      config.enabled = mode !== 'off'; validateInbox(config);
      await service.setMode(mode, async () => { root.inbox = config; await saveMonitorRoot(root, this.configPath); });
    });
  }
  private async changeScope(service: WorkItemService<InboxConfig>, scope: IntakeScope): Promise<void> {
    await withConfigFileLock(this.configPath, async () => {
      const root = await loadMonitorRoot(this.configPath);
      const config = normalizeInbox(root?.inbox);
      if (!root || this.service !== service || JSON.stringify(connectionConfig(config)) !== JSON.stringify(connectionConfig(service.config))) {
        throw new Error('助理配置正在更新，请稍后重试');
      }
      const next = normalizeInbox({ ...config, intakeScope: scope });
      await larkSource(service).setScope(scope, async () => { root.inbox = next; await saveMonitorRoot(root, this.configPath); });
    });
  }
  protected async reload(): Promise<void> {
    if (this.closed) return;
    const root = await loadMonitorRoot(this.configPath); const config = normalizeInbox(root?.inbox);
    this.sectionError = monitorSectionErrors(root).lark;
    if (root) this.sources.configureConcurrency(root.workItemConcurrency);
    const controls = this.profiles(config.executorProfile);
    const fingerprint = JSON.stringify([connectionConfig(config), controls?.cfg.accounts.app, controls?.cfg.channels?.lark?.network, controls?.botIdentity?.openId, controls?.profileConfig.mode, controls?.profileConfig.agentKind, controls?.profileConfig.codex, controls?.profileConfig.preferences,
      config.triageService ? root?.modelServices?.[config.triageService] : undefined]);
    if (this.service && controls && fingerprint === this.fingerprint) {
      await withConfigFileLock(this.configPath, async () => {
        const latest = normalizeInbox((await loadMonitorRoot(this.configPath))?.inbox);
        if (this.service) {
          this.service.config.analysisTimeoutMinutes = latest.analysisTimeoutMinutes;
          this.service.config.workbenchUrl = latest.workbenchUrl;
        }
        if (this.service && latest.intakeScope !== this.service.config.intakeScope) await larkSource(this.service).setScope(latest.intakeScope);
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
      const triageService = inboxTriageService(config, root!);
      const paths = resolveAppPaths({ rootDir: this.rootDir, profile: config.executorProfile });
      const folder = join(dirname(this.configPath), 'inbox');
      this.unlock = await acquireStateLease(folder, () => { void this.close(); });
      const lark = new InboxLark({ profile: config.executorProfile, rootDir: this.rootDir }, config);
      this.lark = lark;
      const agent = createLarkRuntimeAgent(controls.profileConfig, paths, this.configPath);
      if (controls.botIdentity) agent.setBotIdentity?.(controls.botIdentity);
      const readTools = new InboxReadTools(async (args, signal) => {
        const reader = new InboxLark({ profile: config.executorProfile, rootDir: this.rootDir }, config);
        const cancel = () => reader.close();
        signal.addEventListener('abort', cancel, { once: true });
        try {
          signal.throwIfAborted();
          await reader.checkOwner(config.recipientKey);
          signal.throwIfAborted();
          return await reader.callValue(args);
        } finally { signal.removeEventListener('abort', cancel); reader.close(); }
      }, config.recipientKey);
      const larkAuth = controls.larkAuth ?? (this.ownedLarkAuth = new LarkProfileAuth(controls.cfg, paths));
      this.releaseNetwork = larkAuth.retainNetwork();
      const credentials = await larkAuth.credentials();
      const tenantTokens = await larkAuth.tenantTokens();
      const cotClient = new CotClient({
        tenant: credentials.tenant,
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        tenantTokens,
        request: larkAuth.request,
      });
      this.service = new WorkItemService(new WorkItemStore(join(folder, 'state.sqlite')), config, larkRuntime(config, {
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
            const result = await processInbox(job, agent, defaultWorkspaceFor(controls.profileConfig) ?? managedWorkspaceFor({ bridgeRoot: paths.rootDir }, controls.profileConfig.agentKind)!,
              config.attentionProfile, signal, config.analysisTimeoutMinutes * 60_000, event => progress?.event(event),
              await backgroundModelSettings(controls.profileConfig, paths.profileDir, config.analysisModel));
            success = true;
            return result;
          } finally { await progress?.finish(success); }
        },
        triage: async (job, signal, onProgress) => triageWithChatTools(job, config.attentionProfile,
          await loadInboxTriageService(config, triageService), readTools, signal, onProgress, undefined, undefined, config),
        notifyAttention: (jobs, id) => lark.notifyAttention(jobs, id),
      }), Date.now, this.sources.queue, this.sources.triageQueue);
      this.nonces = new CallbackNonceStore(join(folder, 'card-nonces.json'));
      await this.nonces.load();
      const cards = new InboxCards(this.service, lark, new CallbackAuth({
        keys: await larkAuth.callbackKeys(),
        nonceStore: this.nonces,
      }), this.nonces);
      this.cards = cards;
      lark.reminderCard = (job, content) => cards.reminder(job, content);
      await this.service.start();
      this.control = await startInboxControl(
        join(this.rootDir ?? dirname(this.configPath), 'inbox-control.json'),
        { profile: config.executorProfile, ownerOpenId: config.recipientKey },
        input => this.workbenchCommand(input),
      );
      if (config.gui.publicUrl) {
        const service = this.service;
        this.gui = new InboxGui(service, lark, controls.cfg.accounts.app.id, join(folder, 'gui-receipts.json'), fetch,
          mode => this.changeMode(service, mode), scope => this.changeScope(service, scope), this.sources);
        await this.gui.start();
      }
      if (config.h5.publicUrl) {
        const auth = new InboxH5Auth({
          appId: controls.cfg.accounts.app.id,
          appSecret: credentials.appSecret,
          ownerOpenId: config.recipientKey,
          publicUrl: config.h5.publicUrl,
          tenant: controls.cfg.accounts.app.tenant,
          tenantTokens,
          request: larkAuth.request,
        });
        this.h5 = await startInboxH5(this.service, auth);
      }
      this.fingerprint = fingerprint; this.error = undefined;
    } catch (e) {
      this.error = e instanceof Error ? e.message : '助理启动失败'; await this.stop();
    }
  }
  protected async stop(): Promise<void> {
    // Disable work before closing the listener, so active HTTP requests cannot queue new jobs.
    const service = this.service; this.service = undefined;
    this.cards = undefined;
    const gui = this.gui; this.gui = undefined;
    const control = this.control; this.control = undefined;
    await control?.close();
    await gui?.close();
    await service?.close();
    this.lark?.close(); this.lark = undefined;
    await this.nonces?.flush(); this.nonces = undefined;
    await this.h5?.close(); this.h5 = undefined;
    await this.releaseNetwork?.(); this.releaseNetwork = undefined;
    await this.ownedLarkAuth?.close(); this.ownedLarkAuth = undefined;
    await this.unlock?.(); this.unlock = undefined;
    this.fingerprint = '';
  }
  override async close(): Promise<void> {
    await super.close(); if (!this.sharedSources) await this.sources.close();
  }
}
