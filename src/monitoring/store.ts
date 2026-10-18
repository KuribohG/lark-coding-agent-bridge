import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { RootConfig } from '../config/profile-schema';
import { loadRootConfig, saveRootConfig } from '../config/profile-store';
import { writeFileAtomic } from '../platform/atomic-write';
import { formatMonitorConfig, parseMonitorConfig, validateMonitorReferences } from './config';

const snapshots = new WeakMap<RootConfig, { path: string; text: string }>();

export function larkConfigRevision(root: RootConfig): string | undefined {
  const snapshot = snapshots.get(root);
  return snapshot ? createHash('sha256').update(JSON.stringify([snapshot.path, root.inbox])).digest('hex') : undefined;
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

/** Only monitoring consumers resolve this file; a typo cannot break account/profile loading. */
export async function loadMonitorRoot(configPath: string): Promise<RootConfig | undefined> {
  const root = await loadRootConfig(configPath);
  if (!root) return undefined;
  const path = monitorConfigPath(root, configPath);
  if (!path) return root;
  const text = await readMonitorFile(path);
  let settings;
  try { settings = parseMonitorConfig(text); validateMonitorReferences(settings, root); }
  catch (error) { throw new Error(`${path}: ${error instanceof Error ? error.message : '监控配置无效'}`); }
  delete root.inbox; delete root.gitlabCi; delete root.storageMonitor;
  Object.assign(root, settings);
  snapshots.set(root, { path, text });
  return root;
}

/** Caller holds the ordinary config lock. Only monitoring fields are written here. */
export async function saveMonitorRoot(root: RootConfig, configPath: string): Promise<void> {
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
