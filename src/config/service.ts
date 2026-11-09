import { readFile } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { configDocument, configRevision, loadRootConfig, normalizeRootConfig, runtimeProfileConfig, withConfigFileLock } from './profile-store';
import { documentToRoot, parseDocument, resolveRun, RUN_KEYS } from './document';
import { editToml, getPath } from './toml-edit';
import type { MutableProfileState } from './config-ops';
import { writeFileAtomic } from '../platform/atomic-write';
import { larkDisplay } from './lark-display';
import { SLACK_DISPLAY_DEFAULTS, WEB_DISPLAY_DEFAULTS } from './channel-display';
import { getMaxConcurrentRuns, getRunIdleTimeoutMs, getAgentStopGraceMs, getWorkflowTimeoutMinutes } from './schema';

export async function readProfileSnapshot(state: MutableProfileState) {
  const root = await loadRootConfig(state.configPath);
  if (!root?.profiles[state.profile]) throw new Error('profile not found');
  return { state: { ...state, profileConfig: root.profiles[state.profile]!, cfg: runtimeProfileConfig(root, state.profile) },
    revision: configDocument(root)!.revision };
}

export async function inspectConfig(path: string, profile?: string) {
  const root = await loadRootConfig(path);
  if (!root) throw new Error('root config not found');
  const name = profile ?? root.activeProfile;
  const p = root.profiles[name];
  if (!p) throw new Error(`profile not found: ${name}`);
  const snapshot = configDocument(root)!;
  const doc = snapshot.document;
  const sources = resolveRun(doc, p.agentKind, name).sources;
  const run = Object.fromEntries(Object.entries(RUN_KEYS).map(([key, internal]) => [key, {
    value: p.preferences[internal] ?? (key === 'max_concurrent_runs' ? getMaxConcurrentRuns(p)
      : key === 'idle_timeout_minutes' ? (getRunIdleTimeoutMs(p) ?? 0) / 60000
      : key === 'workflow_timeout_minutes' ? getWorkflowTimeoutMinutes(p)
      : key === 'stop_grace_ms' ? getAgentStopGraceMs(p) : 'native'),
    source: sources[key] ?? (key === 'model' || key === 'effort' ? 'native CLI' : 'built-in'),
  }]));
  const channels = {
    lark: larkDisplay(p),
    web: { ...WEB_DISPLAY_DEFAULTS, ...p.channels?.web },
    slack: { ...SLACK_DISPLAY_DEFAULTS, ...p.channels?.slack },
  };
  const display = Object.fromEntries(Object.entries(channels).map(([channel, fields]) => [channel,
    Object.fromEntries([
      ...Object.entries(fields).filter(([key]) => key !== 'file_links' && key !== 'network'),
      ...(channel === 'lark' ? [
        ['network.proxy', p.channels?.lark?.network?.proxy ?? 'env'],
        ['network.no_proxy', p.channels?.lark?.network?.no_proxy ?? '(environment)'],
      ] : []),
    ].map(([key, value]) => {
      const parts = String(key).split('.');
      const override = `channels.${channel}.profiles.${name}.${key}`;
      const common = `channels.${channel}.${key}`;
      return [key, { value, source: getPath(doc, ['channels', channel, 'profiles', name, ...parts]) !== undefined ? override
        : getPath(doc, ['channels', channel, ...parts]) !== undefined ? common : 'built-in' }];
    })),
  ]));
  return { file: path, format: 'toml', profile: name, agent: p.agentKind,
    revision: snapshot.revision, run, channels: display };
}

export async function patchConfig(path: string, key: string[], value: unknown, revision?: string): Promise<void> {
  await withConfigFileLock(path, async () => {
    const text = await readFile(path, 'utf8');
    if (revision && revision !== configRevision(text)) throw new Error('配置已改变，请重新打开设置');
    parseDocument(text);
    const next = editToml(text, key, value);
    normalizeRootConfig(documentToRoot(parseDocument(next)));
    if (next === text) return;
    if (await readFile(path, 'utf8') !== text) throw new Error('配置文件已被其他编辑器修改');
    await writeFileAtomic(path, next, { mode: 0o600 });
  });
}

export function parseSetting(value: string): unknown {
  try { return parse(`value = ${value}`).value; } catch { return value; }
}
