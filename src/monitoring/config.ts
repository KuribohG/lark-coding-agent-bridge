import { parse, stringify, TomlError } from 'smol-toml';
import type { RootConfig } from '../config/profile-schema';
import type { MonitorSettings } from './module';
import { monitorConfigs } from './sources/configs';
import { table, integer, fail } from './validation';
import { parseWorkItemConcurrency } from '../work-items/concurrency';
export type { MonitorSettings } from './module';

/** Strict parse: any invalid section rejects the file (CLI validation, workbench saves). */
export function parseMonitorConfig(text: string): MonitorSettings {
  const { settings, errors } = parseMonitorSections(text);
  const first = Object.values(errors)[0];
  if (first) throw new Error(first);
  return settings;
}

/** Section id → error. `concurrency` and each source id are independent sections. */
export type MonitorSectionErrors = Record<string, string>;

/**
 * Per-section parse for running monitors: the file shape (syntax, version,
 * known section names) must be valid, but one source's mistake only drops
 * that source, so the others keep running with their own config.
 */
export function parseMonitorSections(text: string): { settings: MonitorSettings; errors: MonitorSectionErrors } {
  let value: Record<string, unknown>;
  try { value = parse(text); }
  catch (error) {
    // Parser code blocks may contain accidentally pasted credentials.
    throw new Error(error instanceof TomlError ? `监控 TOML 语法错误：第 ${error.line} 行，第 ${error.column} 列` : '监控 TOML 语法错误');
  }
  const settings: MonitorSettings = {};
  const errors: MonitorSectionErrors = {};
  const fields = Object.fromEntries(monitorConfigs.map(source => [source.id, () => {}]));
  table({ version: integer(1, 1), sources: table(fields), concurrency: () => {} })(value, 'monitors');
  if (value.version !== 1 || !value.sources) fail('monitors', '需要 version = 1 和 [sources]');
  const sources = value.sources as Record<string, unknown>;
  const section = (id: string, parse: () => void) => {
    try { parse(); } catch (error) { errors[id] = error instanceof Error ? error.message : String(error); }
  };
  if (value.concurrency !== undefined) {
    section('concurrency', () => { settings.workItemConcurrency = parseWorkItemConcurrency(value.concurrency, 'monitors.concurrency'); });
  }
  for (const source of monitorConfigs) if (Object.hasOwn(sources, source.id)) {
    section(source.id, () => source.parseInto(settings, sources[source.id]));
  }
  return { settings, errors };
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
    stringify(JSON.parse(JSON.stringify({ version: 1,
      ...(settings.workItemConcurrency !== undefined ? { concurrency: parseWorkItemConcurrency(settings.workItemConcurrency) } : {}), sources }))) + '\n';
}

/** Checks references without reading credentials or contacting any source. */
export function validateMonitorReferences(settings: MonitorSettings, root: RootConfig): void {
  for (const source of monitorConfigs) source.validateReferences(settings, root);
}

/** Per-source reference check; a dangling reference disables only that source. */
export function monitorReferenceErrors(settings: MonitorSettings, root: RootConfig): MonitorSectionErrors {
  const errors: MonitorSectionErrors = {};
  for (const source of monitorConfigs) {
    try { source.validateReferences(settings, root); }
    catch (error) { errors[source.id] = error instanceof Error ? error.message : String(error); }
  }
  return errors;
}
