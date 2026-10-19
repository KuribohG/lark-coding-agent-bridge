import { parseKeyPath } from '../../config/toml-edit';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig } from '../../config/profile-store';
import { inspectConfig, migrateConfig, parseSetting, patchConfig } from '../../config/service';
import { loadMonitorRoot } from '../../monitoring/store';

type Options = { config?: string; profile?: string; sources?: boolean; output?: string; dryRun?: boolean };
const path = (opts: Options) => opts.config ?? resolveAppPaths().configFile;
export async function checkConfig(opts: Options) {
  const root = await loadRootConfig(path(opts));
  if (!root) throw new Error('root config not found');
  if (root.monitorConfigFile) await loadMonitorRoot(path(opts));
  console.log('配置校验通过；未读取凭据、请求模型或修改运行进程。');
}
export async function showConfig(opts: Options) { console.log(JSON.stringify(await inspectConfig(path(opts), opts.profile), null, 2)); }
export async function setConfig(key: string, value: string, opts: Options) {
  await patchConfig(path(opts), parseKeyPath(key), parseSetting(value));
  console.log('已保存；请在受影响的 bot 执行 /config reload，启动参数变化需重启。');
}
export async function unsetConfig(key: string, opts: Options) {
  await patchConfig(path(opts), parseKeyPath(key), undefined);
  console.log('已清除覆盖；请在受影响的 bot 执行 /config reload。');
}
export async function migrateToToml(opts: Options) { console.log(JSON.stringify(await migrateConfig(path(opts), opts.output, opts.dryRun === true), null, 2)); }
