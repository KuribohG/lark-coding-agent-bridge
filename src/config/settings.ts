/**
 * How each resolved setting takes effect in a running bridge. This is the
 * single declaration of reload semantics: the reload planner, `/config show`,
 * `config describe` and the docs table are all derived from it.
 *
 * Paths address the resolved runtime DTO ({@link RootConfig} / ProfileConfig),
 * not the sparse TOML layers: `defaults.run.model`, `agents.codex.run.model`
 * and `profiles.x.run.model` all resolve into `profiles.x.preferences.model`.
 */
export type ApplyClass =
  /** Consumers read the value on use; the next message / run / tick sees it. */
  | 'live'
  /** Default agent adapter is rebuilt for future runs; active runs keep theirs. */
  | 'execution'
  /** Meeting manager is attached or detached on the live connection. */
  | 'meeting'
  /** lark-cli identity policy (strict-mode / default-as) is re-applied. */
  | 'lark-cli'
  /** Monitor sources pick it up on their next reconcile; each source keeps its last good config. */
  | 'monitoring'
  /** Needs a new Lark connection: `/reconnect` (stops active runs) applies it. */
  | 'reconnect'
  /** Read once by the process; restart the bridge to apply. */
  | 'restart';

/** Classes applied automatically when the config file changes. */
export const AUTO_APPLY: ReadonlySet<ApplyClass> = new Set(['live', 'execution', 'meeting', 'lark-cli', 'monitoring']);

export interface SettingSpec {
  /** Dotted path pattern. `*` matches one segment; a trailing `**` matches the subtree. */
  path: string;
  apply: ApplyClass;
  /** User-facing TOML location, for messages and docs. */
  toml: string;
  note?: string;
  /** Read only by a standalone host process; the Lark supervisor ignores it. */
  host?: 'web' | 'slack';
  /** Derived copy of another setting; changes are classified through the original. */
  derived?: boolean;
}

/** Settings inside one resolved profile, relative to `profiles.<name>`. */
export const PROFILE_SETTINGS: readonly SettingSpec[] = [
  { path: 'schemaVersion', apply: 'live', toml: '(internal)', derived: true },
  { path: 'agentKind', apply: 'execution', toml: 'profiles.<p>.agent', note: '新任务使用新引擎；运行中的任务不受影响' },
  { path: 'mode', apply: 'lark-cli', toml: 'profiles.<p>.mode', note: '访问控制立即生效，并重新应用 lark-cli 身份策略' },
  { path: 'accounts.**', apply: 'reconnect', toml: 'profiles.<p>.accounts.**' },
  { path: 'secrets.**', apply: 'reconnect', toml: 'secrets.** / profiles.<p>.secrets.**' },
  { path: 'channels.lark.network.**', apply: 'reconnect', toml: 'channels.lark[.profiles.<p>].network.**' },
  { path: 'channels.lark.**', apply: 'live', toml: 'channels.lark[.profiles.<p>].**' },
  { path: 'channels.web.**', apply: 'restart', host: 'web', toml: 'channels.web[.profiles.<p>].**', note: '独立 Web 进程启动时读取' },
  { path: 'channels.slack.**', apply: 'restart', host: 'slack', toml: 'channels.slack[.profiles.<p>].**', note: '独立 Slack 进程启动时读取' },
  { path: 'preferences.**', apply: 'live', toml: 'defaults.run / agents.<a>.run / profiles.<p>.run', note: '下一次任务生效；调大并发会立即放行排队任务' },
  { path: 'access.**', apply: 'live', toml: 'profiles.<p>.access.**' },
  { path: 'workspaces.**', apply: 'live', toml: 'profiles.<p>.workspaces.**', note: '新会话生效；已绑定目录的会话不变' },
  { path: 'permissionSource', apply: 'execution', toml: '(derived from permissions)', derived: true },
  { path: 'permissions.**', apply: 'execution', toml: 'profiles.<p>.permissions.**' },
  { path: 'sandbox.**', apply: 'execution', toml: '(derived from permissions)', derived: true },
  { path: 'state.**', apply: 'execution', toml: 'state.**' },
  { path: 'claude.**', apply: 'execution', toml: 'agents.claude.launch / profiles.<p>.launch' },
  { path: 'codex.**', apply: 'execution', toml: 'agents.codex.launch / profiles.<p>.launch', note: 'Codex daemon 环境变化在空闲时重启 daemon' },
  { path: 'pi.**', apply: 'execution', toml: 'agents.pi.launch / profiles.<p>.launch' },
  { path: 'agy.**', apply: 'execution', toml: 'agents.agy.launch / profiles.<p>.launch' },
  { path: 'attachments.**', apply: 'live', toml: 'profiles.<p>.attachments.**' },
  { path: 'comments.**', apply: 'live', toml: '(reserved)' },
  { path: 'meeting.enabled', apply: 'meeting', toml: 'profiles.<p>.meeting.enabled' },
  { path: 'meeting.**', apply: 'live', toml: 'profiles.<p>.meeting.**', note: '新会议生效' },
  { path: 'larkCli.identityPreset', apply: 'lark-cli', toml: 'profiles.<p>.larkCli.identityPreset' },
  { path: 'larkCli.**', apply: 'live', toml: 'profiles.<p>.larkCli.**' },
];

/** Bridge-wide settings, relative to the resolved root. */
export const ROOT_SETTINGS: readonly SettingSpec[] = [
  { path: 'schemaVersion', apply: 'live', toml: 'version', derived: true },
  { path: 'preferences.**', apply: 'live', toml: '(internal)', derived: true },
  { path: 'activeProfile', apply: 'restart', toml: 'bridge.active_profile', note: '仅决定命令行默认 profile' },
  { path: 'autostartProfiles.**', apply: 'restart', toml: 'bridge.autostart_profiles', note: '运行中可在控制台启停 profile' },
  { path: 'monitorConfigFile', apply: 'monitoring', toml: 'bridge.monitors_file' },
  { path: 'workItemConcurrency.**', apply: 'monitoring', toml: 'monitors.toml concurrency' },
  { path: 'inbox.**', apply: 'monitoring', toml: 'monitors.toml sources.lark' },
  { path: 'gitlabCi.**', apply: 'monitoring', toml: 'monitors.toml sources.gitlab_ci' },
  { path: 'storageMonitor.**', apply: 'monitoring', toml: 'monitors.toml sources.storage' },
  { path: 'agentState.**', apply: 'execution', toml: 'state.**', derived: true },
  { path: 'agentLaunches.**', apply: 'execution', toml: 'agents.<a>.launch', derived: true },
  { path: 'modelServices.**', apply: 'execution', toml: 'model_services.**', note: '模型列表与 provider 解析同时更新' },
  { path: 'secrets.**', apply: 'reconnect', toml: 'secrets.**' },
  { path: 'migrations.**', apply: 'live', toml: 'migrations.**' },
  { path: 'profiles.*', apply: 'restart', toml: 'profiles.<p>', note: '新增或删除 profile：在控制台启停，或重启 bridge' },
];

function matches(pattern: string[], path: readonly string[]): number | undefined {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '**') return i === pattern.length - 1 ? i : undefined;
    if (i >= path.length) return undefined;
    if (pattern[i] !== '*' && pattern[i] !== path[i]) return undefined;
  }
  return pattern.length === path.length ? pattern.length : undefined;
}

const compiled = new WeakMap<readonly SettingSpec[], [string[], SettingSpec][]>();
function compile(specs: readonly SettingSpec[]): [string[], SettingSpec][] {
  let value = compiled.get(specs);
  if (!value) compiled.set(specs, value = specs.map(spec => [spec.path.split('.'), spec]));
  return value;
}

/** First matching spec in declaration order; specific entries precede their `**` parents. */
export function findSetting(specs: readonly SettingSpec[], path: readonly string[]): SettingSpec | undefined {
  for (const [pattern, spec] of compile(specs)) if (matches(pattern, path) !== undefined) return spec;
  return undefined;
}

/** Unknown paths are treated as restart-only so a missing declaration is never silently hot. */
export function classifySetting(specs: readonly SettingSpec[], path: readonly string[]): ApplyClass {
  return findSetting(specs, path)?.apply ?? 'restart';
}

/** Display path for a changed leaf, e.g. `preferences.maxConcurrentRuns`. */
export function settingLabel(path: readonly string[]): string {
  return path.join('.');
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Changed leaves between two resolved configs. A table appearing or vanishing
 * is expanded against `{}` so every change lands on a classifiable leaf;
 * arrays are compared as values.
 */
export function leafChanges(before: unknown, after: unknown, path: string[] = []): { path: string[]; before: unknown; after: unknown }[] {
  if (plain(before) || plain(after)) {
    if (!plain(before) && before !== undefined || !plain(after) && after !== undefined) {
      return [{ path, before, after }];
    }
    const b = (before ?? {}) as Record<string, unknown>;
    const a = (after ?? {}) as Record<string, unknown>;
    return [...new Set([...Object.keys(b), ...Object.keys(a)])]
      .flatMap(key => leafChanges(b[key], a[key], [...path, key]));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path, before, after }];
}

/** Set or delete (`undefined`) one leaf, creating intermediate tables. Mutates `target`. */
export function setPathValue(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  if (!path.length) return;
  let cursor = target;
  for (const key of path.slice(0, -1)) {
    if (!plain(cursor[key])) {
      if (value === undefined) return;
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  const last = path[path.length - 1]!;
  if (value === undefined) delete cursor[last];
  else cursor[last] = structuredClone(value);
}

const BRIDGE_KEYS: Record<string, string> = {
  active_profile: 'activeProfile', autostart_profiles: 'autostartProfiles', monitors_file: 'monitorConfigFile',
};
const RUN_INTERNAL: Record<string, string> = {
  model: 'model', effort: 'reasoningEffort', max_concurrent_runs: 'maxConcurrentRuns',
  idle_timeout_minutes: 'runIdleTimeoutMinutes', stop_grace_ms: 'agentStopGraceMs', workflow_timeout_minutes: 'workflowTimeoutMinutes',
};

/**
 * Map a TOML document path (as used by `config set`) to the resolved setting
 * it feeds, so editors can say up front how an edit will take effect.
 */
function resolveDocumentPath(path: readonly string[]): { specs: readonly SettingSpec[]; path: string[] } | undefined {
  const [head, ...rest] = path;
  const run = (keys: string[]) => ({ specs: PROFILE_SETTINGS, path: ['preferences', ...(keys[0] ? [RUN_INTERNAL[keys[0]] ?? keys[0]] : [])] });
  switch (head) {
    case 'defaults': return rest[0] === 'run' ? run(rest.slice(1)) : undefined;
    case 'agents': {
      const [kind, layer, ...keys] = rest;
      if (layer === 'run') return run(keys);
      return layer === 'launch' && kind ? { specs: PROFILE_SETTINGS, path: [kind, ...keys] } : undefined;
    }
    case 'profiles': {
      const [, key, ...keys] = rest;
      if (key === undefined) return { specs: ROOT_SETTINGS, path: ['profiles', rest[0] ?? '*'] };
      if (key === 'run') return run(keys);
      if (key === 'agent') return { specs: PROFILE_SETTINGS, path: ['agentKind'] };
      if (key === 'launch') return { specs: PROFILE_SETTINGS, path: ['codex', ...keys] };
      return { specs: PROFILE_SETTINGS, path: [key, ...keys] };
    }
    case 'channels': {
      const [channel, ...keys] = rest;
      const local = keys[0] === 'profiles' ? keys.slice(2) : keys;
      return channel ? { specs: PROFILE_SETTINGS, path: ['channels', channel, ...local] } : undefined;
    }
    case 'bridge': return rest[0] ? { specs: ROOT_SETTINGS, path: [BRIDGE_KEYS[rest[0]] ?? rest[0]] } : undefined;
    case 'model_services': return { specs: ROOT_SETTINGS, path: ['modelServices', ...rest] };
    case 'secrets': return { specs: ROOT_SETTINGS, path: ['secrets', ...rest] };
    case 'state': return { specs: PROFILE_SETTINGS, path: ['state', ...rest] };
    case 'migrations': return { specs: ROOT_SETTINGS, path: ['migrations', ...rest] };
    default: return undefined;
  }
}

export function classifyDocumentPath(path: readonly string[]): ApplyClass {
  const resolved = resolveDocumentPath(path);
  return resolved ? classifySetting(resolved.specs, resolved.path) : 'restart';
}

export const APPLY_DESCRIPTIONS: Record<ApplyClass, string> = {
  live: '立即生效（下一条消息 / 下一次任务）',
  execution: '自动重建执行引擎，新任务生效，运行中的任务不受影响',
  meeting: '自动接入或退出会议能力',
  'lark-cli': '自动重新应用 lark-cli 身份策略',
  monitoring: '监控来源在下一轮协调时生效（最多约 15 秒）',
  reconnect: '需 /reconnect（会停止运行中的任务）',
  restart: '需重启 bridge 进程',
};
