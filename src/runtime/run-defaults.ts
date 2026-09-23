import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseEffort, type ModelSettings } from '../agent/model-settings';
import { validateModelId } from '../agent/models';
import { resolveAppPaths } from '../config/app-paths';
import type { MutableProfileState } from '../config/config-ops';
import type { AgentKind } from '../config/profile-schema';
import { writeFileAtomic } from '../platform/atomic-write';
import { parseRunDeadline } from './run-deadline';

/** Reusable input rules; absolute timestamps belong only to individual jobs. */
export interface RunDefaults extends ModelSettings {
  until: string;
  timeZone: string;
  marginMinutes: number;
}

export function builtinRunDefaults(): RunDefaults {
  return { until: '2h', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, marginMinutes: 5 };
}

export function parseRunSettings(form: Record<string, unknown>, defaults: RunDefaults, agentKind: AgentKind): RunDefaults {
  const until = String(form.until ?? defaults.until).trim();
  const timeZone = String(form.time_zone ?? defaults.timeZone).trim();
  const marginMinutes = form.margin === undefined || String(form.margin).trim() === ''
    ? defaults.marginMinutes : Number(form.margin);
  if (!Number.isFinite(marginMinutes) || marginMinutes < 0 || marginMinutes > 120) {
    throw new Error('安全余量应为 0～120 分钟。');
  }
  const model = String(form.model_pick && form.model_pick !== '__manual__'
    ? form.model_pick : form.model ?? defaults.model ?? '').trim();
  if (form.model_pick === '__manual__' && !String(form.model ?? '').trim()) throw new Error('请填写本次使用的模型名。');
  return {
    until, timeZone, marginMinutes,
    model: model && model !== 'default' ? validateModelId(model) : undefined,
    reasoningEffort: parseEffort(form.effort ?? defaults.reasoningEffort, agentKind, { timedRun: true }),
  };
}

export function runDefaultsPath(state: Pick<MutableProfileState, 'configPath' | 'profile'>): string {
  const paths = resolveAppPaths({ rootDir: dirname(state.configPath), profile: state.profile });
  return join(paths.profileDir, 'run-defaults.json');
}

export async function readRunDefaults(state: MutableProfileState): Promise<RunDefaults> {
  try {
    const raw = JSON.parse(await readFile(runDefaultsPath(state), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('限时任务默认值格式无效。');
    const settings = parseRunSettings({
      until: raw.until, time_zone: raw.timeZone, margin: raw.marginMinutes,
      model: raw.model, effort: raw.reasoningEffort,
    }, builtinRunDefaults(), state.profileConfig.agentKind);
    validateReusable(settings);
    return settings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return builtinRunDefaults();
    throw err;
  }
}

export async function saveRunDefaults(state: MutableProfileState, settings: RunDefaults): Promise<void> {
  validateReusable(settings);
  await writeFileAtomic(runDefaultsPath(state), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

function validateReusable(settings: RunDefaults): void {
  if (!Number.isFinite(settings.marginMinutes) || settings.marginMinutes < 0 || settings.marginMinutes > 120) {
    throw new Error('安全余量应为 0～120 分钟。');
  }
  if (!/^(?:\d{2}:\d{2}|\d+(?:\.\d+)?[mh])$/.test(settings.until)) {
    throw new Error('默认截止时间应为 01:00、2h 或 90m 等可重复使用的规则，不能保存固定日期。');
  }
  const now = Date.now();
  const at = parseRunDeadline(settings.until, settings.timeZone, now);
  if (!settings.until.includes(':') && at - settings.marginMinutes * 60_000 - now < 10_000) {
    throw new Error('默认时长扣除安全余量后不足 10 秒。');
  }
}
