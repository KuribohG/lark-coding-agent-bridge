import { dirname, join } from 'node:path';
import type { RootConfig } from '../config/profile-schema';
import { log, type LogFields } from '../core/logger';
import { acquireStateLease } from '../platform/state-lease';
import type { ExecutionProfile } from '../runtime/execution-provider';
import { WorkItemSources } from '../work-items/registry';
import type { MonitorHost, MonitorSourceOptions } from './host';
import { ReconcileLoop } from './reconcile-loop';
import { loadMonitorRoot, monitorSectionErrors } from './store';

export type SourceConnection = Awaited<ReturnType<WorkItemSources['connect']>>;

/** A running collector. It exists only while its source is enabled. */
export interface SourceCollector { close(): Promise<void> }

export interface SourceView<T extends SourceCollector> {
  collector(): T | undefined;
  error(): string | undefined;
}

export interface SourceSetup<T extends SourceCollector> {
  /** Work-item settings besides identity and execution, which the controller supplies. */
  options(view: SourceView<T>): Omit<MonitorSourceOptions, 'id' | 'label' | 'profile' | 'enabled' | 'executor'>;
  /** Starts collection for an enabled source; a disabled source keeps its items accessible without one. */
  start?(connection: SourceConnection): Promise<T>;
}

/** A deterministic collector that publishes observations into the shared work-item engine. */
export interface SourceKind<C extends { enabled: boolean; executorProfile: string }, T extends SourceCollector> {
  /** Work-item source id. */
  id: string;
  label: string;
  section: string;
  /** State folder beside the bridge config; its lease admits one collector per config. */
  folder: string;
  logTag: string;
  setupError: string;
  config(root: RootConfig | undefined): C;
  /** Log fields describing what a started collector watches. */
  describe?(config: C): LogFields;
  /** Validates the config and loads credentials before the running instance is replaced. */
  setup(config: C, sources: WorkItemSources): Promise<SourceSetup<T>>;
}

/** Keeps one source kind's collector and work-item connection in line with the monitor config. */
export class SourceController<C extends { enabled: boolean; executorProfile: string }, T extends SourceCollector> extends ReconcileLoop {
  readonly sources: WorkItemSources;
  private collector?: T;
  private connection?: SourceConnection;
  private unlock?: () => Promise<void>;
  private executor?: ExecutionProfile;
  private executionError?: string;
  private fingerprint = '';
  private profile = '';

  constructor(private kind: SourceKind<C, T>, private configPath: string, private host: MonitorHost, sources?: WorkItemSources) {
    super(kind.logTag, kind.setupError);
    this.sources = sources ?? new WorkItemSources(configPath);
  }

  get current(): T | undefined { return this.collector; }

  protected async reload(): Promise<void> {
    if (this.closed) return;
    const root = await loadMonitorRoot(this.configPath);
    this.sectionError = monitorSectionErrors(root)[this.kind.section];
    if (root) this.sources.configureConcurrency(root.workItemConcurrency);
    const config = this.kind.config(root);
    if (config.enabled) await this.refreshExecutor(config.executorProfile);
    else { this.executor = undefined; this.executionError = undefined; }
    const fingerprint = JSON.stringify(config);
    if (this.connection && fingerprint === this.fingerprint) { this.error = this.executionError; return; }
    if (!config.executorProfile) { await this.stop(); this.error = undefined; return; }
    const setup = await this.kind.setup(config, this.sources);
    await this.stop();
    const folder = join(dirname(this.configPath), this.kind.folder);
    this.unlock = await acquireStateLease(folder, () => { void this.close(); });
    try {
      this.connection = await this.sources.connect(this.host.source({
        id: this.kind.id, label: this.kind.label, profile: config.executorProfile, enabled: config.enabled,
        executor: () => this.executor,
        ...setup.options({ collector: () => this.collector, error: () => this.error }),
      }));
      this.profile = config.executorProfile;
      this.fingerprint = fingerprint;
      if (config.enabled && setup.start) {
        this.collector = await setup.start(this.connection);
        log.info(this.kind.logTag, 'watch-started', this.kind.describe?.(config) ?? {});
      }
      this.error = this.executionError;
    } catch (error) { await this.stop(); throw error; }
  }

  protected async recover(): Promise<void> {
    // Collection continues on a stale config; only execution availability is refreshed.
    if (this.collector) await this.refreshExecutor(this.profile);
  }

  private async refreshExecutor(profile: string): Promise<void> {
    try {
      this.executor = await this.host.executors.resolve(profile);
      this.executionError = this.executor?.available ? undefined : this.executor?.error ?? '执行器暂不可用，采集继续，分析等待';
    } catch {
      this.executor = undefined; this.executionError = '执行器配置不可用，采集继续，分析等待';
    }
  }

  protected async stop(): Promise<void> {
    await this.collector?.close(); this.collector = undefined;
    await this.connection?.close(); this.connection = undefined;
    await this.unlock?.(); this.unlock = undefined;
    this.fingerprint = '';
  }
}
