import {
  AUTO_APPLY,
  findSetting,
  leafChanges,
  PROFILE_SETTINGS,
  ROOT_SETTINGS,
  setPathValue,
  settingLabel,
  type ApplyClass,
  type SettingSpec,
} from './settings';

export interface SettingChange {
  path: string[];
  label: string;
  apply: ApplyClass;
  /** Value the process is running with. */
  running: unknown;
  /** Value in the accepted config file. */
  disk: unknown;
  spec?: SettingSpec;
}

export interface FailedComponent {
  component: ApplyClass;
  error: string;
  paths: string[];
  /** Valid but postponed to avoid disrupting active runs; retried automatically. */
  deferred?: boolean;
}

/** Result of reconciling one running profile with the accepted config. */
export interface ConfigApplyReport {
  profile?: string;
  trigger: string;
  /** Accepted config revision the report refers to. */
  revision?: string;
  at: number;
  applied: string[];
  components: ApplyClass[];
  /** Settings that differ from disk and need `/reconnect` or a restart. */
  pending: SettingChange[];
  failed: FailedComponent[];
  /** The newest file revision was rejected; the report describes the last good one. */
  rejected?: { revision: string; message: string };
}

const show = (value: unknown) => value === undefined ? '(未设置)' : JSON.stringify(value);
const SENSITIVE = /secret|token|password|passwd|api_?key|credential|(^|\.)env\./i;

function classify(specs: readonly SettingSpec[], change: { path: string[]; before: unknown; after: unknown }, prefix: string[] = []): SettingChange {
  const spec = findSetting(specs, change.path);
  return { path: change.path, label: settingLabel([...prefix, ...change.path]), apply: spec?.apply ?? 'restart',
    running: change.before, disk: change.after, ...(spec ? { spec } : {}) };
}

/** Leaf-level difference between a running profile view and the accepted one, classified by the registry. */
export function planProfileChanges(running: object, next: object, host: 'lark' | 'web' | 'slack' = 'lark'): SettingChange[] {
  return leafChanges(running, next)
    .map(change => classify(PROFILE_SETTINGS, change))
    .filter(change => change.spec?.host === undefined || change.spec.host === host);
}

/** Bridge-wide changes; profile-scoped content is planned per running profile. */
export function planRootChanges(running: object, next: object): SettingChange[] {
  const strip = (root: object) => {
    const { profiles, ...rest } = root as { profiles?: Record<string, unknown> };
    return { ...rest, profiles: Object.fromEntries(Object.keys(profiles ?? {}).map(name => [name, true])) };
  };
  return leafChanges(strip(running), strip(next)).map(change => classify(ROOT_SETTINGS, change));
}

export function autoApplied(changes: readonly SettingChange[]): SettingChange[] {
  return changes.filter(change => AUTO_APPLY.has(change.apply));
}

/** Copy of `base` with the given leaves taken from their `disk` (or `running`) side. */
export function withChanges<T extends object>(base: T, changes: readonly SettingChange[], side: 'disk' | 'running' = 'disk'): T {
  const next = structuredClone(base) as Record<string, unknown>;
  for (const change of changes) setPathValue(next, change.path, change[side]);
  return next as T;
}

/** One-line description; values of credential-like settings are never echoed. */
function describeChange(change: SettingChange): string {
  if (SENSITIVE.test(change.label)) return `${change.label}（已修改，值不显示）`;
  const text = `${show(change.running)} → ${show(change.disk)}`;
  return `${change.label}: ${text.length > 160 ? `${text.slice(0, 157)}...` : text}`;
}

const COMPONENT_LABELS: Record<ApplyClass, string> = {
  live: '即时', execution: '执行引擎', meeting: '会议', 'lark-cli': 'lark-cli 身份', monitoring: '监控',
  reconnect: '飞书连接', restart: '进程',
};

const list = (items: string[], limit = 12) => items.length > limit
  ? `${items.slice(0, limit).join('、')} 等 ${items.length} 项` : items.join('、');

/** Chat/CLI rendering shared by `/config reload`, `/config show` and `config reload`. */
export function formatApplyReport(report: ConfigApplyReport, options: { title?: string } = {}): string {
  const lines = [`**${options.title ?? '配置已重新加载'}**${report.revision ? `（revision ${report.revision.slice(0, 12)}）` : ''}`];
  if (report.rejected) {
    lines.push(`⚠️ 配置文件最新修改无效，继续使用上一份有效配置：${report.rejected.message}`);
  }
  lines.push(report.applied.length ? `✓ 已生效：${list(report.applied)}` : '✓ 没有需要即时生效的变化');
  const rebuilt = report.components.filter(c => c !== 'live').map(c => COMPONENT_LABELS[c]);
  if (rebuilt.length) lines.push(`↻ 已重建：${rebuilt.join('、')}`);
  for (const failure of report.failed) {
    lines.push(failure.deferred
      ? `⏸ ${COMPONENT_LABELS[failure.component]}暂缓切换：${failure.error}`
      : `✗ ${COMPONENT_LABELS[failure.component]}重建失败，保留原配置：${failure.error}`);
  }
  if (report.pending.length) {
    lines.push('⏳ 尚未生效：');
    const groups = new Map<string, SettingChange[]>();
    const deferred = new Set(report.failed.filter(f => f.deferred).map(f => f.component));
    for (const change of report.pending) {
      const hint = deferred.has(change.apply) ? '空闲后自动生效' : pendingHint(change.apply);
      groups.set(hint, [...groups.get(hint) ?? [], change]);
    }
    for (const [hint, changes] of groups) {
      lines.push(`- ${hint}：`);
      for (const change of changes.slice(0, 10)) lines.push(`  - ${describeChange(change)}`);
      if (changes.length > 10) lines.push(`  - …另有 ${changes.length - 10} 项`);
    }
  }
  return lines.join('\n');
}

const PENDING_HINT: Partial<Record<ApplyClass, string>> = {
  reconnect: '/reconnect 后生效（会停止运行中的任务）',
  restart: '重启 bridge 后生效',
};

function pendingHint(apply: ApplyClass): string {
  return PENDING_HINT[apply] ?? '组件重建失败，修复后 /config reload 重试';
}
