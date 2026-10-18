import { storageScope, type StorageState } from '../../storage-monitor/service';
import { join } from 'node:path';
import { readFile, mkdir, open } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig, saveRootConfig, withConfigFileLock } from '../../config/profile-store';
import { normalizeInbox } from '../../inbox/config';
import { normalizeGitLabCi } from '../../gitlab-ci/config';
import { formatMonitorConfig, parseMonitorConfig, validateMonitorReferences } from '../../monitoring/config';
import { loadMonitorRoot, monitorConfigPath, readMonitorFile } from '../../monitoring/store';

type Options = { config?: string };
const rootPath = (opts: Options) => opts.config ?? resolveAppPaths().configFile;

export async function initMonitors(opts: Options & { output?: string }): Promise<void> {
  const path = rootPath(opts);
  await withConfigFileLock(path, async () => {
    const root = await loadRootConfig(path);
    if (!root) throw new Error('Bridge root configuration not found');
    if (root.monitorConfigFile !== undefined) {
      await loadMonitorRoot(path);
      console.log(`监控已使用统一配置：${monitorConfigPath(root, path)}`); return;
    }
    const target = opts.output ? resolve(opts.output) : resolve(dirname(path), 'monitors.toml');
    if (target === resolve(path)) throw new Error('监控配置文件不能覆盖 Bridge 主配置');
    const text = formatMonitorConfig({ inbox: root.inbox ?? normalizeInbox(undefined), gitlabCi: root.gitlabCi ?? normalizeGitLabCi(undefined), ...(root.storageMonitor ? { storageMonitor: root.storageMonitor } : {}) });
    validateMonitorReferences(parseMonitorConfig(text), root);
    await mkdir(dirname(target), { recursive: true });
    // Until the root points at it, this new file is not consumed by either source.
    const file = await open(target, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    root.monitorConfigFile = relative(dirname(resolve(path)), target);
    await saveRootConfig(root, path);
    console.log(`已将飞书与 GitLab 监控配置迁移到 ${target}；原开关、模型和范围保持不变。`);
  });
}

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
  if (!target) throw new Error('尚未使用统一监控文件，请先运行 monitors init 或指定待检查文件');
  const settings = parseMonitorConfig(await readMonitorFile(target));
  validateMonitorReferences(settings, root);
  console.log(`监控配置检查通过：${target}\n仅检查格式和本地引用，未读取凭据或请求监控来源。`);
}

export async function statusMonitors(opts: Options): Promise<void> {
  const path = rootPath(opts); const root = await loadMonitorRoot(path);
  if (!root) throw new Error('Bridge root configuration not found');
  let storageState: StorageState | undefined;
  if (root.storageMonitor) {
    try { storageState = JSON.parse(await readFile(join(dirname(path), 'storage-monitor', `${storageScope(root.storageMonitor)}.json`), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('存储监控状态文件无法读取'); }
  }
  console.log(JSON.stringify({ storageState, file: monitorConfigPath(root, path) ?? null, mode: root.monitorConfigFile === undefined ? 'legacy-json' : 'toml',
    sources: [
      { id: 'lark', enabled: root.inbox?.enabled ?? false, executorProfile: root.inbox?.executorProfile ?? '', pollSeconds: root.inbox?.pollSeconds },
      { id: 'gitlab_ci', enabled: root.gitlabCi?.enabled ?? false, executorProfile: root.gitlabCi?.executorProfile ?? '',
        pollSeconds: root.gitlabCi?.pollSeconds, repositories: root.gitlabCi?.repositories.map(r => r.project) ?? [] },
      { id: 'storage', enabled: root.storageMonitor?.enabled ?? false, executorProfile: root.storageMonitor?.executorProfile ?? '',
        pollSeconds: root.storageMonitor?.pollSeconds, watches: root.storageMonitor?.watches ?? [] },
    ], note: '配置状态；enabled 不代表来源或执行器在线。' }, null, 2));
}
