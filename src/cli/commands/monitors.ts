import { monitorConfigs } from '../../monitoring/sources/configs';
import { storageScope, type StorageState } from '../../monitoring/sources/storage/service';
import { dirname, relative, resolve } from 'node:path';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig, saveRootConfig, withConfigFileLock } from '../../config/profile-store';
import { parseMonitorConfig, validateMonitorReferences } from '../../monitoring/config';
import { loadMonitorRoot, monitorConfigPath, readMonitorFile } from '../../monitoring/store';
import { parseWorkItemConcurrency } from '../../work-items/concurrency';
import { collectorStates } from '../../work-items/registry';

type Options = { config?: string };
const rootPath = (opts: Options) => opts.config ?? resolveAppPaths().configFile;

export async function configureMonitors(file: string, opts: Options): Promise<void> {
  const path = rootPath(opts); const target = resolve(file);
  await withConfigFileLock(path, async () => {
    const root = await loadRootConfig(path);
    if (!root) throw new Error('Bridge root configuration not found');
    root.monitorConfigFile = relative(dirname(resolve(path)), target);
    monitorConfigPath(root, path);
    validateMonitorReferences(parseMonitorConfig(await readMonitorFile(target)), root);
    await saveRootConfig(root, path);
  });
  console.log(`监控配置已指向 ${target}；支持此功能的 Bridge 在下次配置检查时加载。`);
}

export async function checkMonitors(file: string | undefined, opts: Options): Promise<void> {
  const path = rootPath(opts); const root = await loadRootConfig(path);
  if (!root) throw new Error('Bridge root configuration not found');
  const target = file ? resolve(file) : monitorConfigPath(root, path);
  if (!target) throw new Error('尚未使用统一监控文件，请先运行 monitors configure 或指定待检查文件');
  const settings = parseMonitorConfig(await readMonitorFile(target));
  validateMonitorReferences(settings, root);
  console.log(`监控配置检查通过：${target}\n仅检查格式和本地引用，未读取凭据或请求监控来源。`);
}

export async function statusMonitors(opts: Options): Promise<void> {
  const path = rootPath(opts); const root = await loadMonitorRoot(path);
  if (!root) throw new Error('Bridge root configuration not found');
  let storageState: StorageState | undefined;
  if (root.storageMonitor) {
    const scope = storageScope(root.storageMonitor);
    storageState = (await collectorStates(path, 'storage-monitor')).map(entry => entry.state as StorageState)
      .find(state => state.scope === scope);
  }
  console.log(JSON.stringify({ storageState, concurrency: parseWorkItemConcurrency(root.workItemConcurrency), file: monitorConfigPath(root, path) ?? null, mode: root.monitorConfigFile === undefined ? 'legacy-json' : 'toml',
    sources: monitorConfigs.map(source => source.summary(root)), note: '配置状态；enabled 不代表来源或执行器在线。' }, null, 2));
}
