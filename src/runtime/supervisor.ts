import pkg from '../../package.json';
import { startChannel as realStartChannel, type BridgeChannel } from '../bot/channel';
import type { Controls } from '../commands';
import { CommandRegistry } from '../commands/registry';
import type { AppPaths } from '../config/app-paths';
import { isComplete, type AppConfig } from '../config/schema';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { refreshOwnerControls } from '../policy/owner';
import { SessionStore } from '../session/store';
import { SessionCatalog } from '../session/catalog';
import { WorkspaceStore } from '../workspace/store';
import { preFlightChecks } from '../cli/preflight';
import { larkAgentHostContext } from '../channels/lark/agent-host';
import {
  assertReconnectAgentKindUnchanged,
  checkRuntimeAgentAvailability,
  releaseRuntimeLocks,
} from './agent-runtime';
import { ProfileExecutionController } from './execution-controller';
import { ModelProviderRegistry } from '../model-provider/provider';
import { LarkProfileAuth } from '../lark-auth/profile-auth';
import {
  acquireAppRuntimeLock,
  acquireProfileRuntimeLock,
  type AcquiredRuntimeLock,
} from './locks';
import { resolveProfileRuntime } from './profile-runtime';
import { readConfigRevision } from '../config/revision';
import {
  register,
  unregister,
  unregisterSync,
  updateEntry,
  type ProcessEntry,
} from './registry';
import type {
  BridgePlugin,
  BridgePluginFactory,
  PluginAction,
  PluginHttpRoute,
} from '../plugins/api';
import { PluginHost } from '../plugins/host';
import { configSource, type ConfigChangeEvent, type ConfigSnapshot, type ConfigSource, type ConfigTrigger, type RefreshResult } from '../config/config-source';
import { planRootChanges, type ConfigApplyReport, type SettingChange } from '../config/apply';
import { AUTO_APPLY } from '../config/settings';
import type { RootConfig } from '../config/profile-schema';
import { applyProfileLarkCliIdentity } from '../config/config-ops';
import { reconcileProfile } from './config-reconciler';
import { onDaemonIdle } from '../agent/codex/daemon';
import { ACTIVITY_HEARTBEAT_MS } from './activity';
import type { ModelServiceConfig } from '../model-service/config';

type StartChannelFn = typeof realStartChannel;

function createExecutionController(input: {
  profileConfig: ProfileConfig;
  appPaths: AppPaths;
  configPath: string;
  modelServices?: Record<string, import('../model-service/config').ModelServiceConfig>;
}): ProfileExecutionController {
  const { profileConfig, appPaths, configPath, modelServices } = input;
  const host = larkAgentHostContext(appPaths, configPath);
  return new ProfileExecutionController({
    profileConfig,
    appPaths: { ...appPaths, configPath },
    systemPrompt: host.systemPrompt,
    env: host.env,
    modelProviders: new ModelProviderRegistry(modelServices),
  });
}

export interface SupervisorOptions {
  /** Root config path (config.json). */
  configPath: string;
  /** LARK_CHANNEL_HOME root; undefined = default. */
  rootDir?: string;
  /** Injectable for tests (defaults to the real startChannel). */
  startChannelFn?: StartChannelFn;
  /** Run lark-cli preflight per profile (default true; tests pass false). */
  runPreflight?: boolean;
  /** Skip CLI binding only; agent availability checks still run. */
  skipCheckLarkCli?: boolean;
  /** Explicit feature composition. Core supervision has no concrete plugins. */
  plugins?: BridgePluginFactory;
}

export interface ManagedStatus {
  profile: string;
  agentKind: AgentKind;
  online: boolean;
  pid: number;
  startedAt?: string;
  botName?: string;
  appId?: string;
}

/**
 * One profile's live bridge inside the supervisor. Owns its locks, registry
 * entry, stores, channel and `controls`. `stop()` tears down ONLY this profile
 * (no process.exit) so the supervisor keeps hosting the others.
 */
const ACTIVITY_POLL_MS = 2_000;

class ManagedProfile {
  bridge!: BridgeChannel;
  controls!: Controls;
  locks: AcquiredRuntimeLock[] = [];
  entry!: ProcessEntry;
  startedAt = '';
  configStatus?: ConfigApplyReport;
  private restarting = false;
  private applying: Promise<unknown> = Promise.resolve();
  private activityTimer?: NodeJS.Timeout;
  private publishedActivity?: { key: string; at: number };
  private publishingActivity = false;

  constructor(
    readonly profile: string,
    private appPaths: AppPaths,
    private configPath: string,
    private cfg: AppConfig,
    private profileConfig: ProfileConfig,
    private execution: ProfileExecutionController,
    private sessions: SessionStore,
    private sessionCatalog: SessionCatalog,
    private workspaces: WorkspaceStore,
    private startChannelFn: StartChannelFn,
    private onExitCommand: (profile: string) => void,
    private onRuntimeChange: () => Promise<void>,
    private commands: CommandRegistry,
    private larkAuth: LarkProfileAuth,
    private source: ConfigSource,
    private modelServices: Record<string, ModelServiceConfig>,
    private rootPending: () => SettingChange[],
  ) {}

  get appId(): string {
    return this.cfg.accounts.app.id;
  }

  get botName(): string | undefined {
    return this.bridge?.channel.botIdentity?.name;
  }

  async bringUp(nowIso: string): Promise<void> {
    this.larkAuth.resumeNetwork();
    this.startedAt = nowIso;
    // Acquire sequentially, pushing as we go: if the app lock throws (e.g. the
    // same app is running elsewhere) the already-held profile lock is still in
    // this.locks and gets released by the catch — otherwise it would leak and
    // a retry in the same process would fail to re-lock.
    this.locks = [];
    try {
      this.locks.push(await acquireProfileRuntimeLock(this.appPaths, this.execution.defaultAgentKind));
      this.locks.push(
        await acquireAppRuntimeLock(this.appPaths, this.appId, this.execution.defaultAgentKind),
      );
      this.entry = await register({
        appId: this.appId,
        tenant: this.cfg.accounts.app.tenant,
        profileName: this.appPaths.profile,
        agentKind: this.execution.defaultAgentKind,
        configPath: this.configPath,
        version: pkg.version,
        registryFile: this.appPaths.userRegistryFile,
      });
      this.controls = this.makeControls(this.appPaths, this.cfg, this.profileConfig);
      this.bridge = await this.startChannelFn({
        cfg: this.cfg,
        execution: this.execution,
        sessions: this.sessions,
        sessionCatalog: this.sessionCatalog,
        workspaces: this.workspaces,
        controls: this.controls,
        appPaths: this.appPaths,
        larkAuth: this.larkAuth,
      });
      const botName = this.bridge.channel.botIdentity?.name;
      if (botName) {
        await updateEntry(this.entry.id, { botName }, this.appPaths.userRegistryFile).catch((err) =>
          log.warn('registry', 'update-failed', { step: 'botName', err: String(err) }),
        );
      }
      this.activityTimer = setInterval(() => void this.publishActivity(), ACTIVITY_POLL_MS);
      this.activityTimer.unref?.();
      await this.publishActivity();
    } catch (err) {
      // Roll back partial bring-up so a failed start doesn't leak locks/entries.
      if (this.entry) unregisterSync(this.entry.id, this.appPaths.userRegistryFile);
      await this.larkAuth.close();
      await releaseRuntimeLocks(this.locks);
      this.locks = [];
      throw err;
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.activityTimer);
    this.activityTimer = undefined;
    try {
      await this.bridge?.disconnect();
    } catch (err) {
      log.warn('supervisor', 'disconnect-failed', { profile: this.profile, err: String(err) });
    }
    if (this.entry) {
      await unregister(this.entry.id, this.appPaths.userRegistryFile).catch(() => undefined);
    }
    await this.larkAuth.close();
    await releaseRuntimeLocks(this.locks);
    this.locks = [];
  }

  /** Writes on change, plus a heartbeat so readers can tell a live snapshot from a stale one. */
  private async publishActivity(): Promise<void> {
    const activity = this.bridge?.activity?.();
    if (!activity || !this.entry || this.publishingActivity) return;
    const key = JSON.stringify(activity);
    const now = Date.now();
    if (this.publishedActivity?.key === key && now - this.publishedActivity.at < ACTIVITY_HEARTBEAT_MS) return;
    this.publishingActivity = true;
    try {
      await updateEntry(this.entry.id, { activity, activityAt: new Date(now).toISOString() },
        this.appPaths.userRegistryFile);
      this.publishedActivity = { key, at: now };
    } catch (err) {
      log.warn('registry', 'update-failed', { step: 'activity', err: String(err) });
    } finally {
      this.publishingActivity = false;
    }
  }

  /** Best-effort sync unregister for the process 'exit' hook. */
  unregisterSelfSync(): void {
    if (this.entry) unregisterSync(this.entry.id, this.appPaths.userRegistryFile);
  }

  status(pid: number): ManagedStatus {
    return {
      profile: this.profile,
      agentKind: this.execution.defaultAgentKind,
      online: true,
      pid,
      startedAt: this.startedAt,
      botName: this.botName,
      appId: this.appId,
    };
  }

  private makeControls(
    currentPaths: AppPaths,
    currentCfg: AppConfig,
    currentProfileConfig: ProfileConfig,
    larkAuth = this.larkAuth,
  ): Controls {
    const self = this;
    const currentControls: Controls = {
      commands: this.commands,
      profile: currentPaths.profile,
      profileConfig: currentProfileConfig,
      ownerRefreshState: 'unknown',
      knownChats: [],
      async refreshOwner(channelOverride) {
        const target = channelOverride ?? self.bridge?.channel;
        if (!target) return;
        await refreshOwnerControls(currentControls, target, currentControls.cfg.accounts.app.id);
      },
      configPath: self.configPath,
      cfg: currentCfg,
      larkAuth,
      processId: self.entry.id,
      async exit() {
        // `/exit` from chat stops THIS profile's channel; the supervisor lives on.
        self.onExitCommand(self.profile);
      },
      async restart(opts) {
        const previousAuth = self.larkAuth;
        try {
          await self.restart(opts?.config ?? 'reload');
          await self.onRuntimeChange();
        } finally {
          if (previousAuth !== self.larkAuth) await previousAuth.close();
        }
      },
      async switchAgent() {
        await self.switchAgent();
        await self.onRuntimeChange();
      },
      async applyConfig(trigger, options) {
        return self.applyFromSource(trigger, options?.force === true);
      },
    };
    return currentControls;
  }

  /**
   * Connect-before-disconnect reconnect for this profile. `reload` applies the
   * config file (the only way reconnect-class settings take effect); `running`
   * reconnects with what is already running, so a keepalive recovery cannot
   * pick up unrelated edits behind the user's back.
   */
  private async restart(config: 'reload' | 'running' = 'reload'): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    let nextAppLock: AcquiredRuntimeLock | undefined;
    let pendingPaused = false;
    let switched = false;
    let candidateAuth: LarkProfileAuth | undefined;
    try {
      this.controls.pausePendingInput?.();
      pendingPaused = true;
      await this.controls.flushPendingInput?.();
      const nextRuntime = config === 'running'
        ? { cfg: this.controls.cfg, profileConfig: this.controls.profileConfig, appPaths: this.appPaths, modelServices: this.modelServices }
        : await resolveProfileRuntime({
          config: this.configPath,
          profile: this.appPaths.profile,
          allowBootstrap: false,
        });
      const next = nextRuntime.cfg;
      if (!isComplete(next)) throw new Error('config incomplete after change');
      if (config === 'reload') {
        assertReconnectAgentKindUnchanged(
          this.execution.defaultAgentKind,
          nextRuntime.profileConfig.agentKind,
        );
      }
      const nextExecution = config === 'running' ? this.execution : createExecutionController({
        profileConfig: nextRuntime.profileConfig,
        appPaths: nextRuntime.appPaths,
        configPath: this.configPath,
        modelServices: nextRuntime.modelServices,
      });
      const nextLarkAuth = candidateAuth = new LarkProfileAuth(next, nextRuntime.appPaths);
      if (config === 'reload') {
        const availability = await checkRuntimeAgentAvailability(nextExecution.defaultAgent());
        if (!availability.ok) throw availability.error;
      }

      const appChanged = next.accounts.app.id !== this.cfg.accounts.app.id;
      if (appChanged) {
        nextAppLock = await acquireAppRuntimeLock(
          nextRuntime.appPaths,
          next.accounts.app.id,
          nextExecution.defaultAgentKind,
        );
      }
      const nextControls = this.makeControls(
        nextRuntime.appPaths,
        next,
        nextRuntime.profileConfig,
        nextLarkAuth,
      );
      const nextBridge = await this.startChannelFn({
        cfg: next,
        execution: nextExecution,
        sessions: this.sessions,
        sessionCatalog: this.sessionCatalog,
        workspaces: this.workspaces,
        controls: nextControls,
        appPaths: nextRuntime.appPaths,
        larkAuth: nextLarkAuth,
        restorePending: false,
      });
      this.controls.detachPendingInput?.();
      try {
        await this.bridge.disconnect();
      } catch (err) {
        log.warn('supervisor', 'old-disconnect-failed', { profile: this.profile, err: String(err) });
      }
      this.bridge = nextBridge;
      const startupConfigRevision = await readConfigRevision(this.configPath)
        .catch(() => undefined);
      await updateEntry(
        this.entry.id,
        {
          appId: next.accounts.app.id,
          tenant: next.accounts.app.tenant,
          configPath: this.configPath,
          botName: nextBridge.channel.botIdentity?.name,
          ...(startupConfigRevision ? { startupConfigRevision } : {}),
        },
        this.appPaths.userRegistryFile,
      ).catch((err) => log.warn('registry', 'update-failed', { err: String(err) }));
      if (nextAppLock) {
        const oldAppLock = this.locks.find((l) => l.kind === 'app');
        this.locks = [...this.locks.filter((l) => l.kind !== 'app'), nextAppLock];
        nextAppLock = undefined;
        await oldAppLock?.release().catch(() => undefined);
      }
      this.cfg = next;
      this.profileConfig = nextRuntime.profileConfig;
      this.execution = nextExecution;
      this.larkAuth = nextLarkAuth;
      this.modelServices = nextRuntime.modelServices;
      nextControls.configStatus = this.configStatus;
      this.controls = nextControls;
      await nextControls.reloadPendingInput?.();
      nextControls.resumePendingInput?.();
      pendingPaused = false;
      switched = true;
    } finally {
      if (candidateAuth && candidateAuth !== this.larkAuth) await candidateAuth.close();
      if (pendingPaused && !switched) this.controls.resumePendingInput?.();
      if (nextAppLock) await nextAppLock.release().catch(() => undefined);
      this.restarting = false;
    }
    // Edits that landed while reconnecting, plus a fresh pending report.
    const latest = await this.source.refresh('read').catch(() => undefined);
    const snapshot = latest?.snapshot ?? this.source.snapshot;
    if (snapshot) await this.applyConfig(snapshot, 'read');
  }

  /** `/config reload`, writers and the console: refresh the source, then report for this profile. */
  async applyFromSource(trigger: ConfigTrigger, force: boolean): Promise<ConfigApplyReport> {
    const startedAt = Date.now();
    const result: RefreshResult = await this.source.refresh(trigger, { force });
    if (!result.snapshot) throw new Error(result.error?.message ?? '配置文件不存在');
    const fresh = this.configStatus && this.configStatus.revision === result.snapshot.revision && this.configStatus.at >= startedAt;
    const report = fresh ? this.configStatus! : await this.applyConfig(result.snapshot, trigger);
    return result.error ? { ...report, rejected: { revision: result.error.revision, message: result.error.message } } : report;
  }

  /** Reconcile the running profile with an accepted snapshot. Serialized per profile. */
  applyConfig(snapshot: ConfigSnapshot, trigger: ConfigTrigger): Promise<ConfigApplyReport> {
    const run = this.applying.then(() => this.reconcileConfig(snapshot, trigger));
    this.applying = run.catch(() => undefined);
    return run;
  }

  private async reconcileConfig(snapshot: ConfigSnapshot, trigger: ConfigTrigger): Promise<ConfigApplyReport> {
    if (this.restarting || !this.controls) {
      return this.configStatus ?? { profile: this.profile, trigger, revision: snapshot.revision, at: Date.now(),
        applied: [], components: [], pending: [], failed: [] };
    }
    const controls = this.controls;
    const result = await reconcileProfile({
      profile: this.profile,
      state: controls,
      execution: this.execution,
      modelServices: this.modelServices,
      applyLarkCliIdentity: identity => applyProfileLarkCliIdentity(controls, identity),
      reconcileMeeting: controls.reconcileMeeting ? () => controls.reconcileMeeting!() : undefined,
      onApplied: () => controls.onConfigApplied?.(),
      rootPending: this.rootPending,
    }, snapshot.root, { trigger, revision: snapshot.revision });
    const { report } = result;
    // A reconnect swapped controls while this was in flight; it re-reconciles
    // the new controls when it finishes, so don't publish stale values.
    if (this.controls !== controls || this.restarting) return report;
    this.cfg = result.cfg;
    this.profileConfig = result.profileConfig;
    this.modelServices = result.modelServices;
    const previous = this.configStatus;
    this.configStatus = controls.configStatus = report;
    if (report.applied.length || report.failed.length || report.pending.length !== (previous?.pending.length ?? 0)) {
      log.info('config', 'applied', { profile: this.profile, trigger, revision: snapshot.revision.slice(0, 12),
        applied: report.applied, components: report.components,
        pending: report.pending.map(change => change.label),
        failed: report.failed.map(f => `${f.component}: ${f.error}`) });
    }
    if (this.entry) {
      await updateEntry(this.entry.id, { appliedConfigRevision: snapshot.revision, configPendingCount: report.pending.length,
        agentKind: this.execution.defaultAgentKind },
        this.appPaths.userRegistryFile).catch((err) => log.warn('registry', 'update-failed', { step: 'config', err: String(err) }));
    }
    return report;
  }

  /** Validate and publish the saved engine without stopping existing runs. */
  private async switchAgent(): Promise<void> {
    if (this.restarting) throw new Error('profile lifecycle change already in progress');
    const report = await this.applyFromSource('save', false);
    // A deferred swap (busy Codex daemon) completes on its own once idle.
    const failure = report.failed.find(f => f.component === 'execution' && !f.deferred);
    if (failure) throw new Error(failure.error);
  }
}

/**
 * The single control-plane process: hosts every profile's bridge in one Node
 * process and lets the web console start/stop/restart/configure each in-memory.
 * No `process.exit` here — the CLI entry owns process lifecycle.
 */
export class Supervisor {
  private managed = new Map<string, ManagedProfile>();
  private readonly plugins: PluginHost;
  private readonly commands: CommandRegistry;
  private readonly source: ConfigSource;
  private readonly unsubscribeConfig: () => void;
  /** Root settings the process booted with; restart-class root edits are reported against it. */
  private bootRoot?: RootConfig;

  constructor(private opts: SupervisorOptions) {
    this.plugins = new PluginHost(opts.plugins, {
      configPath: opts.configPath,
      rootDir: opts.rootDir,
      controlsFor: profile => this.controlsFor(profile),
    });
    this.commands = new CommandRegistry(this.plugins.commands());
    this.source = configSource(opts.configPath);
    const unsubscribe = this.source.subscribe(event => this.onConfigChange(event));
    // Deferred engine swaps (busy Codex daemon) complete when it goes idle.
    const unsubscribeIdle = onDaemonIdle(() => { void this.retryDeferred(); });
    this.unsubscribeConfig = () => { unsubscribe(); unsubscribeIdle(); };
  }

  private async retryDeferred(): Promise<void> {
    const snapshot = this.source.snapshot;
    if (!snapshot) return;
    for (const managed of [...this.managed.values()]) {
      if (!managed.configStatus?.failed.some(f => f.deferred)) continue;
      await managed.applyConfig(snapshot, 'read').catch((err) =>
        log.warn('config', 'apply-failed', { profile: managed.profile, err: String(err) }));
    }
  }

  /** Watch the config and monitors files; returns the stop function. */
  watchConfig(): () => void {
    return this.source.watch();
  }

  /** SIGHUP / CLI reload: re-read and re-apply even when the revision is unchanged. */
  reloadConfig(trigger: ConfigTrigger = 'sighup'): Promise<RefreshResult> {
    return this.source.refresh(trigger, { force: true });
  }

  /** Restart-class bridge-wide edits that the running process has not applied. */
  rootPending(): SettingChange[] {
    const latest = this.source.snapshot?.root;
    if (!this.bootRoot || !latest) return [];
    return planRootChanges(this.bootRoot, latest)
      .filter(change => !AUTO_APPLY.has(change.apply) && change.apply !== 'reconnect' && change.path[0] !== 'profiles');
  }

  private async onConfigChange(event: ConfigChangeEvent): Promise<void> {
    if (event.kind === 'config') {
      for (const managed of [...this.managed.values()]) {
        await managed.applyConfig(event.snapshot, event.trigger).catch((err) =>
          log.warn('config', 'apply-failed', { profile: managed.profile, err: String(err) }));
      }
    }
    await this.reconcilePlugins().catch((err) => log.warn('config', 'plugin-reconcile-failed', { err: String(err) }));
  }

  private get startChannelFn(): StartChannelFn {
    return this.opts.startChannelFn ?? realStartChannel;
  }

  isOnline(profile: string): boolean {
    return this.managed.has(profile);
  }

  controlsFor(profile: string): Controls | undefined {
    return this.managed.get(profile)?.controls;
  }

  channelFor(profile: string) {
    return this.managed.get(profile)?.bridge.channel;
  }

  plugin<T extends BridgePlugin = BridgePlugin>(id: string): T | undefined {
    return this.plugins.get<T>(id);
  }

  pluginRoutes(): readonly PluginHttpRoute[] {
    return this.plugins.routes();
  }

  reconcilePlugins(): Promise<void> {
    return this.plugins.reconcile();
  }

  validatePluginAction(action: PluginAction): Promise<void> {
    return this.plugins.validateAction(action);
  }

  list(): ManagedStatus[] {
    return [...this.managed.values()].map((m) => m.status(process.pid));
  }

  /** Bring a profile online inside this process. Throws on lock/app conflict. */
  async startProfile(profile: string): Promise<void> {
    if (this.managed.has(profile)) return;

    // Strict at startup: an invalid file refuses to bring a profile up.
    const loaded = await this.source.refresh('startup');
    if (loaded.status === 'rejected' && loaded.error) throw new Error(`配置无效：${loaded.error.message}`);
    this.bootRoot ??= this.source.snapshot?.root;
    const runtime = await resolveProfileRuntime({
      config: this.opts.configPath,
      profile,
      allowBootstrap: false,
    });
    const { cfg, appPaths, profileConfig, configPath } = runtime;
    if (!isComplete(cfg)) throw new Error(`profile 配置不完整：${profile}`);

    // Dedupe by app id — two channels for one app fight over event routing.
    for (const m of this.managed.values()) {
      if (m.appId === cfg.accounts.app.id) {
        throw new Error(`该飞书应用已被 profile「${m.profile}」连接，不能重复上线`);
      }
    }

    if (this.opts.runPreflight !== false) {
      await preFlightChecks({
        skipCheckLarkCli: this.opts.skipCheckLarkCli,
        bridgeConfig: cfg,
        profileConfig,
        appPaths,
        larkChannel: {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          configPath,
          larkCliConfigDir: appPaths.larkCliConfigDir,
          larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
        },
      });
    }

    const sessions = new SessionStore(appPaths.sessionsFile);
    await sessions.load();
    const sessionCatalog = new SessionCatalog(`${appPaths.sessionsFile}.catalog.json`);
    await sessionCatalog.load();
    const execution = createExecutionController({
      profileConfig,
      appPaths,
      configPath,
      modelServices: runtime.modelServices,
    });
    if (this.opts.runPreflight !== false) {
      const availability = await checkRuntimeAgentAvailability(execution.defaultAgent());
      if (!availability.ok) throw availability.error;
    }
    const workspaces = new WorkspaceStore(appPaths.workspacesFile);
    await workspaces.load();

    const managed = new ManagedProfile(
      appPaths.profile,
      appPaths,
      configPath,
      cfg,
      profileConfig,
      execution,
      sessions,
      sessionCatalog,
      workspaces,
      this.startChannelFn,
      (p) => void this.stopProfile(p).catch(() => undefined),
      async () => { await this.reconcilePlugins(); },
      this.commands,
      new LarkProfileAuth(cfg, appPaths),
      this.source,
      runtime.modelServices,
      () => this.rootPending(),
    );
    await managed.bringUp(new Date().toISOString());
    this.managed.set(appPaths.profile, managed);
    await this.reconcilePlugins();
    log.info('supervisor', 'profile-online', { profile: appPaths.profile, appId: cfg.accounts.app.id });
  }

  /** Take a profile offline (in-process). The supervisor keeps running. */
  async stopProfile(profile: string): Promise<void> {
    const managed = this.managed.get(profile);
    if (!managed) return;
    this.managed.delete(profile);
    await this.reconcilePlugins();
    await managed.stop();
    log.info('supervisor', 'profile-offline', { profile });
  }

  async restartProfile(profile: string): Promise<void> {
    const managed = this.managed.get(profile);
    if (!managed) throw new Error(`profile 未在运行：${profile}`);
    await managed.controls.restart();
    await this.reconcilePlugins();
  }

  /** Stop every profile — for process shutdown. */
  async shutdown(): Promise<void> {
    this.unsubscribeConfig();
    await this.plugins.close();
    const all = [...this.managed.values()];
    this.managed.clear();
    await Promise.allSettled(all.map((m) => m.stop()));
  }

  /** Sync best-effort unregister of all entries (for the process 'exit' hook). */
  unregisterAllSync(): void {
    for (const m of this.managed.values()) m.unregisterSelfSync();
  }
}
