import { monitorConfigs } from './sources/configs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { RootConfig } from '../config/profile-schema';
import { saveRootConfig } from '../config/profile-store';
import { configSource } from '../config/config-source';
import { writeFileAtomic } from '../platform/atomic-write';
import { formatMonitorConfig, monitorReferenceErrors, parseMonitorConfig, parseMonitorSections, type MonitorSectionErrors } from './config';
import type { MonitorSettings } from './module';
import { log } from '../core/logger';
import { parseWorkItemConcurrency } from '../work-items/concurrency';

const snapshots = new WeakMap<RootConfig, { path: string; text: string }>();
const sectionErrors = new WeakMap<RootConfig, MonitorSectionErrors>();
/** Per monitors file: last accepted value of each section, used while that section is invalid. */
const lastGoodSections = new Map<string, Map<string, unknown>>();
const reported = new Map<string, string>();

/** Sections of the monitors file currently running on their last good config (id → error). */
export function monitorSectionErrors(root: RootConfig | undefined): MonitorSectionErrors {
  return (root && sectionErrors.get(root)) ?? {};
}

const SECTION_KEYS: Record<string, keyof MonitorSettings> = Object.fromEntries([
  ['concurrency', 'workItemConcurrency'], ...monitorConfigs.map(source => [source.id, source.key]),
]);

export function concurrencyConfigRevision(root: RootConfig): string {
  return createHash('sha256').update(JSON.stringify([snapshots.get(root)?.path, parseWorkItemConcurrency(root.workItemConcurrency)])).digest('hex');
}

/** Optimistic-lock token for workbench saves; inline monitoring is versioned by its own content. */
export function larkConfigRevision(root: RootConfig): string {
  const snapshot = snapshots.get(root);
  return createHash('sha256').update(JSON.stringify([snapshot?.path ?? '(inline)', root.inbox])).digest('hex');
}

export function monitorConfigPath(root: RootConfig, configPath: string): string | undefined {
  if (root.monitorConfigFile === undefined) return undefined;
  if (typeof root.monitorConfigFile !== 'string' || !root.monitorConfigFile.trim()) throw new Error('monitorConfigFile 需要非空文件路径');
  const path = resolve(dirname(configPath), root.monitorConfigFile);
  if (path === resolve(configPath)) throw new Error('监控配置文件不能覆盖 Bridge 主配置');
  return path;
}

export async function readMonitorFile(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? '不存在' : '无法读取';
    throw new Error(`监控配置文件${reason}：${path}；未回退到旧 JSON 配置`);
  }
}

/**
 * Only monitoring consumers resolve this file; a typo cannot break
 * account/profile loading. Each section is validated on its own: a broken
 * section keeps its last good value (or stays off), the others are unaffected.
 */
export async function loadMonitorRoot(configPath: string): Promise<RootConfig | undefined> {
  const root = await configSource(configPath).current();
  if (!root) return undefined;
  const path = monitorConfigPath(root, configPath);
  if (!path) {
    // Legacy inline [monitoring] keeps its lenient shape (it predates the
    // monitors file); only cross-file references are checked per source.
    applySections(`${resolve(configPath)}#monitoring`, root, monitorReferenceErrors(root, root));
    return root;
  }
  const text = await readMonitorFile(path);
  let parsed;
  try { parsed = parseMonitorSections(text); }
  catch (error) { throw new Error(`${path}: ${error instanceof Error ? error.message : '监控配置无效'}`); }
  const { settings } = parsed;
  applySections(path, settings, { ...parsed.errors, ...monitorReferenceErrors(settings, root) });
  for (const source of monitorConfigs) delete root[source.key];
  delete root.workItemConcurrency;
  Object.assign(root, settings);
  snapshots.set(root, { path, text });
  const errors = sectionErrors.get(settings as RootConfig);
  if (errors) sectionErrors.set(root, errors);
  return root;
}

/** Swap invalid sections for their last good value and remember valid ones. Mutates `settings`. */
function applySections(scope: string, settings: MonitorSettings, errors: MonitorSectionErrors): void {
  const good = lastGoodSections.get(scope) ?? new Map<string, unknown>();
  lastGoodSections.set(scope, good);
  for (const [id, key] of Object.entries(SECTION_KEYS)) {
    if (errors[id]) {
      // Keep the running section; with no earlier good value the section stays off.
      if (good.has(id)) Object.assign(settings, { [key]: structuredClone(good.get(id)) });
      else delete settings[key];
      const message = `${scope}: ${errors[id]}`;
      if (reported.get(`${scope}\0${id}`) !== message) {
        reported.set(`${scope}\0${id}`, message);
        log.warn('monitoring', 'section-rejected', { section: id, error: errors[id], keptLastGood: good.has(id) });
      }
    } else {
      if (settings[key] === undefined) good.delete(id);
      else good.set(id, structuredClone(settings[key]));
      reported.delete(`${scope}\0${id}`);
    }
  }
  if (Object.keys(errors).length) sectionErrors.set(settings as RootConfig, errors);
}

/** Caller holds the ordinary config lock. Only monitoring fields are written here. */
export async function saveMonitorRoot(root: RootConfig, configPath: string): Promise<void> {
  const invalid = Object.entries(monitorSectionErrors(root));
  if (invalid.length) {
    // Saving would overwrite the broken section with its last good value.
    throw new Error(`监控配置中有无效配置，请先修复后再保存：${invalid.map(([id, error]) => `${id}（${error}）`).join('；')}`);
  }
  const path = monitorConfigPath(root, configPath);
  if (!path) { await saveRootConfig(root, configPath); return; }
  const snapshot = snapshots.get(root);
  if (!snapshot || snapshot.path !== path) throw new Error('请重新读取监控配置后再保存');
  if (await readMonitorFile(path) !== snapshot.text) throw new Error('监控配置文件已被修改，请重新读取后再保存；本次未覆盖');
  const text = formatMonitorConfig(root);
  const settings = parseMonitorConfig(text);
  if (JSON.stringify(settings) === JSON.stringify(parseMonitorConfig(snapshot.text))) return;
  await writeFileAtomic(`${path}.bak`, snapshot.text, { mode: 0o600 });
  if (await readMonitorFile(path) !== snapshot.text) throw new Error('监控配置文件已被修改，请重新读取后再保存；本次未覆盖');
  await writeFileAtomic(path, text, { mode: 0o600 });
  snapshots.set(root, { path, text });
}
