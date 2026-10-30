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
import { ScopeExecutionStore } from '../session/scope-execution';
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

type StartChannelFn = typeof realStartChannel;

function createExecutionController(input: {
  profileConfig: ProfileConfig;
  scopeExecution: ScopeExecutionStore;
  appPaths: AppPaths;
  configPath: string;
  modelServices?: Record<string, import('../model-service/config').ModelServiceConfig>;
}): ProfileExecutionController {
  const { profileConfig, scopeExecution, appPaths, configPath, modelServices } = input;
  const host = larkAgentHostContext(appPaths, configPath);
  return new ProfileExecutionController({
    profileConfig,
    scopeExecution,
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
class ManagedProfile {
  bridge!: BridgeChannel;
  controls!: Controls;
  locks: AcquiredRuntimeLock[] = [];
  entry!: ProcessEntry;
  startedAt = '';
  private restarting = false;

  constructor(
    readonly profile: string,
    private appPaths: AppPaths,
    private configPath: string,
    private cfg: AppConfig,
    private profileConfig: ProfileConfig,
    private execution: ProfileExecutionController,
    private sessions: SessionStore,
    private sessionCatalog: SessionCatalog,
    private scopeExecution: ScopeExecutionStore,
    private workspaces: WorkspaceStore,
    private startChannelFn: StartChannelFn,
    private onExitCommand: (profile: string) => void,
    private onRuntimeChange: () => Promise<void>,
    private commands: CommandRegistry,
    private larkAuth: LarkProfileAuth,
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
    this.locks.push(await acquireProfileRuntimeLock(this.appPaths, this.execution.defaultAgentKind));
    this.locks.push(
      await acquireAppRuntimeLock(this.appPaths, this.appId, this.execution.defaultAgentKind),
    );
    try {
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
      async restart() {
        const previousAuth = self.larkAuth;
        try {
          await self.restart();
          await self.onRuntimeChange();
        } finally {
          if (previousAuth !== self.larkAuth) await previousAuth.close();
        }
      },
      async switchAgent() {
        await self.switchAgent();
        await self.onRuntimeChange();
      },
    };
    return currentControls;
  }

  /** Connect-before-disconnect reconnect for this profile (e.g. after /account). */
  private async restart(): Promise<void> {
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
      const nextRuntime = await resolveProfileRuntime({
        config: this.configPath,
        profile: this.appPaths.profile,
        allowBootstrap: false,
      });
      const next = nextRuntime.cfg;
      if (!isComplete(next)) throw new Error('config incomplete after change');
      assertReconnectAgentKindUnchanged(
        this.execution.defaultAgentKind,
        nextRuntime.profileConfig.agentKind,
      );
      const nextExecution = createExecutionController({
        profileConfig: nextRuntime.profileConfig,
        scopeExecution: this.scopeExecution,
        appPaths: nextRuntime.appPaths,
        configPath: this.configPath,
        modelServices: nextRuntime.modelServices,
      });
      const nextLarkAuth = candidateAuth = new LarkProfileAuth(next, nextRuntime.appPaths);
      const availability = await checkRuntimeAgentAvailability(nextExecution.defaultAgent());
      if (!availability.ok) throw availability.error;

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
  }

  /**
   * An agent switch cannot use connect-before-disconnect: one Feishu app must
   * not have two listeners, and the old/new adapters have different runtime
   * contracts. Persist-then-switch therefore performs a short full profile
   * bounce and restores the old profile if the selected backend cannot start.
   */
  private async switchAgent(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    const previous = {
      appPaths: this.appPaths,
      cfg: this.cfg,
      profileConfig: this.profileConfig,
      execution: this.execution,
      larkAuth: this.larkAuth,
    };
    try {
      const nextRuntime = await resolveProfileRuntime({
        config: this.configPath,
        profile: this.appPaths.profile,
        allowBootstrap: false,
      });
      if (nextRuntime.profileConfig.agentKind === this.profileConfig.agentKind) return;
      if (!isComplete(nextRuntime.cfg)) throw new Error('config incomplete after agent switch');
      const nextExecution = createExecutionController({
        profileConfig: nextRuntime.profileConfig,
        scopeExecution: this.scopeExecution,
        appPaths: nextRuntime.appPaths,
        configPath: this.configPath,
        modelServices: nextRuntime.modelServices,
      });
      const nextLarkAuth = new LarkProfileAuth(nextRuntime.cfg, nextRuntime.appPaths);
      const availability = await checkRuntimeAgentAvailability(nextExecution.defaultAgent());
      if (!availability.ok) throw availability.error;

      await this.stop();
      this.appPaths = nextRuntime.appPaths;
      this.cfg = nextRuntime.cfg;
      this.profileConfig = nextRuntime.profileConfig;
      this.execution = nextExecution;
      this.larkAuth = nextLarkAuth;
      try {
        await this.bringUp(new Date().toISOString());
      } catch (error) {
        this.appPaths = previous.appPaths;
        this.cfg = previous.cfg;
        this.profileConfig = previous.profileConfig;
        this.execution = previous.execution;
        this.larkAuth = previous.larkAuth;
        await this.bringUp(new Date().toISOString()).catch((rollbackError) => {
          log.fail('supervisor', rollbackError, {
            step: 'restore-after-agent-switch',
            profile: this.profile,
          });
        });
        throw error;
      }
      await this.scopeExecution
        .clearAgentKind(nextRuntime.profileConfig.agentKind)
        .catch((err) => log.warn('supervisor', 'scope-engine-cleanup-failed', {
          profile: this.profile,
          agentKind: nextRuntime.profileConfig.agentKind,
          err: String(err),
        }));
    } finally {
      this.restarting = false;
    }
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

  constructor(private opts: SupervisorOptions) {
    this.plugins = new PluginHost(opts.plugins, {
      configPath: opts.configPath,
      rootDir: opts.rootDir,
      controlsFor: profile => this.controlsFor(profile),
    });
    this.commands = new CommandRegistry(this.plugins.commands());
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
    const scopeExecution = new ScopeExecutionStore(appPaths.scopeExecutionFile);
    await scopeExecution.load();
    const execution = createExecutionController({
      profileConfig,
      scopeExecution,
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
      scopeExecution,
      workspaces,
      this.startChannelFn,
      (p) => void this.stopProfile(p).catch(() => undefined),
      async () => { await this.reconcilePlugins(); },
      this.commands,
      new LarkProfileAuth(cfg, appPaths),
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
