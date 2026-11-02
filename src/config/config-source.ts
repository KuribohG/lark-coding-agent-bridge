import { watch, watchFile, unwatchFile, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { log } from '../core/logger';
import type { RootConfig } from './profile-schema';
import { cloneRootConfig, parseRootConfig } from './profile-store';
import { configRevision } from './revision';

export type ConfigTrigger = 'startup' | 'read' | 'watch' | 'sighup' | 'command' | 'save' | 'api';

export interface ConfigSnapshot {
  /** Treat as immutable; readers get clones from {@link ConfigSource.current}. */
  root: RootConfig;
  text: string;
  revision: string;
  loadedAt: number;
}

export interface ConfigLoadError {
  revision: string;
  message: string;
  at: number;
}

export interface ConfigChangeEvent {
  kind: 'config' | 'monitors';
  snapshot: ConfigSnapshot;
  previous?: ConfigSnapshot;
  trigger: ConfigTrigger;
  /** Re-apply even when the revision is unchanged (explicit `/config reload`). */
  force: boolean;
}

export interface RefreshResult {
  status: 'changed' | 'unchanged' | 'rejected' | 'missing';
  snapshot?: ConfigSnapshot;
  error?: ConfigLoadError;
}

type Listener = (event: ConfigChangeEvent) => Promise<void> | void;

const WATCH_DEBOUNCE_MS = 300;
const POLL_INTERVAL_MS = 3_000;

/**
 * Process-wide view of one config file. Holds the last good snapshot: an
 * invalid edit is reported once per revision and never replaces it, so a
 * typo cannot break running readers (3FS/Envoy-style validate-then-swap).
 *
 * Every trigger — file watch, SIGHUP, `/config reload`, writers after save,
 * and readers noticing a new revision — funnels into {@link refresh}, which
 * notifies subscribers exactly once per accepted revision.
 */
export class ConfigSource {
  private good?: ConfigSnapshot;
  private failure?: ConfigLoadError;
  private reading: Promise<unknown> = Promise.resolve();
  private notifying: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<Listener>();
  private reportedFailure?: string;
  /** Last observed monitors file (path and text); undefined before the first check. */
  private monitors?: { path: string; text: string | undefined };

  constructor(readonly path: string, private readonly monitorsPath?: (root: RootConfig) => string | undefined) {}

  /** Last accepted snapshot without touching the disk. */
  get snapshot(): ConfigSnapshot | undefined { return this.good; }
  /** Error for the newest on-disk revision, while it is not accepted. */
  get error(): ConfigLoadError | undefined { return this.failure; }

  /**
   * Fresh-if-valid read for running consumers: picks up a new valid revision
   * (notifying subscribers in the background), otherwise returns the last good
   * config. Throws only when no valid config was ever loaded.
   */
  async current(): Promise<RootConfig | undefined> {
    const result = await this.load('read');
    if (result.status === 'missing') return undefined;
    if (!this.good) throw new Error(result.error?.message ?? 'config not loaded');
    if (result.status === 'changed') void this.publish('config', 'read', false, result.previous);
    return cloneRootConfig(this.good.root);
  }

  /** Read, validate and publish. Resolves after subscribers have applied the change. */
  async refresh(trigger: ConfigTrigger, options: { force?: boolean } = {}): Promise<RefreshResult> {
    const result = await this.load(trigger);
    if (result.status === 'changed' || (options.force && this.good)) {
      await this.publish('config', trigger, options.force === true, result.previous);
    }
    if (this.good) await this.checkMonitors(trigger);
    return { status: result.status, snapshot: this.good, error: result.error };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Watch the config (and monitors) file. `fs.watch` on the directory catches
   * atomic rename-replace; a stat poll covers filesystems without inotify.
   */
  watch(): () => void {
    let timer: NodeJS.Timeout | undefined;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void this.refresh('watch'); }, WATCH_DEBOUNCE_MS);
      timer.unref?.();
    };
    const watchers: FSWatcher[] = [];
    const polled = new Set<string>();
    const files = () => [this.path, this.good && this.monitorsPath?.(this.good.root)].filter((v): v is string => !!v);
    const attach = () => {
      for (const file of files()) {
        if (polled.has(file)) continue;
        polled.add(file);
        watchFile(file, { interval: POLL_INTERVAL_MS, persistent: false }, schedule);
      }
    };
    for (const dir of new Set(files().map(file => dirname(file)))) {
      try {
        const watcher = watch(dir, { persistent: false }, (_event, name) => {
          const changed = name ? resolve(dir, String(name)) : undefined;
          if (!changed || files().some(file => resolve(file) === changed || basename(file) === String(name))) schedule();
        });
        watcher.on('error', error => log.warn('config', 'watch-failed', { dir, err: String(error) }));
        watchers.push(watcher);
      } catch (error) {
        log.warn('config', 'watch-failed', { dir, err: String(error) });
      }
    }
    attach();
    const unsubscribe = this.subscribe(attach);
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      for (const file of polled) unwatchFile(file, schedule);
    };
  }

  private load(trigger: ConfigTrigger): Promise<RefreshResult & { previous?: ConfigSnapshot }> {
    const next = this.reading.then(async () => {
      let text: string;
      try { text = await readFile(this.path, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' as const };
        throw error;
      }
      const revision = configRevision(text);
      if (revision === this.good?.revision) {
        this.failure = undefined;
        return { status: 'unchanged' as const, snapshot: this.good };
      }
      if (revision === this.failure?.revision) return { status: 'rejected' as const, error: this.failure };
      try {
        const root = parseRootConfig(text, this.path);
        const previous = this.good;
        this.good = { root, text, revision, loadedAt: Date.now() };
        this.failure = undefined;
        this.reportedFailure = undefined;
        log.info('config', 'loaded', { revision: revision.slice(0, 12), trigger });
        return { status: 'changed' as const, snapshot: this.good, previous };
      } catch (error) {
        this.failure = { revision, message: error instanceof Error ? error.message : String(error), at: Date.now() };
        if (this.reportedFailure !== revision) {
          this.reportedFailure = revision;
          log.warn('config', 'reload-rejected', { revision: revision.slice(0, 12), trigger, error: this.failure.message,
            keptRevision: this.good?.revision.slice(0, 12) ?? null });
        }
        return { status: 'rejected' as const, error: this.failure };
      }
    });
    this.reading = next.catch(() => undefined);
    return next;
  }

  private async checkMonitors(trigger: ConfigTrigger): Promise<void> {
    const path = this.good && this.monitorsPath?.(this.good.root);
    if (!path) { this.monitors = undefined; return; }
    const text = await readFile(path, 'utf8').catch(() => undefined);
    const previous = this.monitors;
    if (previous?.path === path && previous.text === text) return;
    this.monitors = { path, text };
    // A path switch is already published as a config change.
    if (previous?.path === path) await this.publish('monitors', trigger, false);
  }

  private publish(kind: ConfigChangeEvent['kind'], trigger: ConfigTrigger, force: boolean, previous?: ConfigSnapshot): Promise<void> {
    const snapshot = this.good;
    if (!snapshot) return this.notifying;
    const event: ConfigChangeEvent = { kind, snapshot, ...(previous ? { previous } : {}), trigger, force };
    const next = this.notifying.then(async () => {
      for (const listener of [...this.listeners]) {
        try { await listener(event); }
        catch (error) { log.warn('config', 'apply-listener-failed', { kind, trigger, err: String(error) }); }
      }
    });
    this.notifying = next;
    return next;
  }
}

const sources = new Map<string, ConfigSource>();

/** Shared source for a config path; monitors-file resolution is attached by the monitoring module. */
export function configSource(path: string): ConfigSource {
  const key = resolve(path);
  let source = sources.get(key);
  if (!source) sources.set(key, source = new ConfigSource(path, root => monitorsFile(root, path)));
  return source;
}

function monitorsFile(root: RootConfig, configPath: string): string | undefined {
  return typeof root.monitorConfigFile === 'string' && root.monitorConfigFile.trim()
    ? resolve(dirname(configPath), root.monitorConfigFile) : undefined;
}

