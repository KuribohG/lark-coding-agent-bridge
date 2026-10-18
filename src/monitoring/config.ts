import { parse, stringify, TomlError } from 'smol-toml';
import type { RootConfig } from '../config/profile-schema';
import type { MonitorSettings } from './module';
import { monitorConfigs } from './sources/configs';
import { table, integer, fail } from './validation';
export type { MonitorSettings } from './module';

export function parseMonitorConfig(text: string): MonitorSettings {
  let value: Record<string, unknown>;
  try { value = parse(text); }
  catch (error) {
    // Parser code blocks may contain accidentally pasted credentials.
    throw new Error(error instanceof TomlError ? `监控 TOML 语法错误：第 ${error.line} 行，第 ${error.column} 列` : '监控 TOML 语法错误');
  }
  const settings: MonitorSettings = {};
  const fields = Object.fromEntries(monitorConfigs.map(source => [source.id, () => {}]));
  table({ version: integer(1, 1), sources: table(fields) })(value, 'monitors');
  if (value.version !== 1 || !value.sources) fail('monitors', '需要 version = 1 和 [sources]');
  const sources = value.sources as Record<string, unknown>;
  for (const source of monitorConfigs) if (Object.hasOwn(sources, source.id)) source.parseInto(settings, sources[source.id]);
  return settings;
}

export function formatMonitorConfig(settings: MonitorSettings): string {
  const sources = Object.fromEntries(monitorConfigs.flatMap(source => {
    const config = source.format(settings);
    return config ? [[source.id, config]] : [];
  }));
  return '# Bridge 监控配置：飞书、GitLab CI 与存储/任务监控共用此文件。\n' +
    '# enabled 控制来源开关；executorProfile 选择执行身份；pollSeconds 单位为秒。\n' +
    '# 凭据只填环境变量名或文件路径，密钥保留在现有凭据存储中。\n' +
    '# 工作台保存会规范化格式，原文件（含注释）保存在同路径的 .bak 文件。\n\n' +
    stringify(JSON.parse(JSON.stringify({ version: 1, sources }))) + '\n';
}

/** Checks references without reading credentials or contacting any source. */
export function validateMonitorReferences(settings: MonitorSettings, root: RootConfig): void {
  for (const source of monitorConfigs) source.validateReferences(settings, root);
}
