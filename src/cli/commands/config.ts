import { parseKeyPath } from '../../config/toml-edit';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig } from '../../config/profile-store';
import { inspectConfig, migrateConfig, parseSetting, patchConfig } from '../../config/service';
import { loadMonitorRoot } from '../../monitoring/store';
import { readConfigRevision } from '../../config/revision';
import { isAlive, readAndPrune } from '../../runtime/registry';
import { APPLY_DESCRIPTIONS, classifyDocumentPath, PROFILE_SETTINGS, ROOT_SETTINGS, type SettingSpec } from '../../config/settings';
import { dirname, resolve } from 'node:path';

type Options = { config?: string; profile?: string; sources?: boolean; output?: string; dryRun?: boolean; json?: boolean; timeout?: string };
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
  console.log(`已保存。运行中的 bridge 会自动加载：${APPLY_DESCRIPTIONS[classifyDocumentPath(parseKeyPath(key))]}。`);
}
export async function unsetConfig(key: string, opts: Options) {
  await patchConfig(path(opts), parseKeyPath(key), undefined);
  console.log(`已清除覆盖。运行中的 bridge 会自动加载：${APPLY_DESCRIPTIONS[classifyDocumentPath(parseKeyPath(key))]}。`);
}

/** The reload-semantics registry, like `pg_settings.context`. */
export function describeConfig(opts: Options) {
  const rows = (scope: string, specs: readonly SettingSpec[]) => specs.filter(spec => !spec.derived)
    .map(spec => ({ scope, path: spec.path, apply: spec.apply, toml: spec.toml, ...(spec.host ? { host: spec.host } : {}), ...(spec.note ? { note: spec.note } : {}) }));
  const all = [...rows('profile', PROFILE_SETTINGS), ...rows('bridge', ROOT_SETTINGS)];
  if (opts.json) { console.log(JSON.stringify(all, null, 2)); return; }
  for (const [apply, description] of Object.entries(APPLY_DESCRIPTIONS)) {
    const items = all.filter(row => row.apply === apply);
    if (!items.length) continue;
    console.log(`\n[${apply}] ${description}`);
    for (const row of items) console.log(`  ${row.toml}${row.note ? `  — ${row.note}` : ''}`);
  }
}

/** Ask running bridges on this config to reload (SIGHUP) and report whether they accepted the file. */
export async function reloadConfig(opts: Options) {
  const configPath = resolve(path(opts));
  const registry = resolveAppPaths({ rootDir: dirname(configPath) }).userRegistryFile;
  const live = readAndPrune(registry).filter(entry => resolve(entry.configPath) === configPath && isAlive(entry.pid));
  if (!live.length) { console.log('没有使用该配置的运行中 bridge；下次启动时加载。'); return; }
  if (process.platform === 'win32') throw new Error('Windows 不支持 SIGHUP；运行中的 bridge 会自动监听文件变化，也可在飞书中执行 /config reload。');
  // Older processes would be terminated by SIGHUP; never signal them.
  for (const entry of live.filter(entry => entry.reloadSignal !== 'SIGHUP')) {
    console.log(`${entry.profileName} (pid ${entry.pid})：该版本不支持信号重载，请在飞书中执行 /config reload 或重启。`);
  }
  const pids = [...new Set(live.filter(entry => entry.reloadSignal === 'SIGHUP').map(entry => entry.pid))];
  if (!pids.length) { process.exitCode = 1; return; }
  const revision = await readConfigRevision(configPath);
  for (const pid of pids) process.kill(pid, 'SIGHUP');
  const deadline = Date.now() + Math.max(1, Number(opts.timeout ?? 10)) * 1000;
  for (;;) {
    const entries = readAndPrune(registry).filter(entry => resolve(entry.configPath) === configPath && pids.includes(entry.pid));
    const done = entries.every(entry => entry.appliedConfigRevision === revision);
    if (done || Date.now() > deadline) {
      for (const entry of entries) {
        const applied = entry.appliedConfigRevision === revision;
        console.log(`${entry.profileName} (pid ${entry.pid})：${applied ? '已加载' : '未加载最新修改（文件无效或仍在应用），见 /config show 或日志 config.reload-rejected'}` +
          `${applied && entry.configPendingCount ? `；${entry.configPendingCount} 项待 /reconnect 或重启` : ''}`);
      }
      if (!done) process.exitCode = 1;
      return;
    }
    await new Promise(r => setTimeout(r, 300));
  }
}
export async function migrateToToml(opts: Options) { console.log(JSON.stringify(await migrateConfig(path(opts), opts.output, opts.dryRun === true), null, 2)); }
