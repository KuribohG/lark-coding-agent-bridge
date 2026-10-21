import { readFile, open, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { configDocument, configRevision, loadRootConfig, normalizeRootConfig, runtimeProfileConfig, withConfigFileLock } from './profile-store';
import { documentToRoot, formatDocument, parseDocument, resolveRun, rootToDocument, RUN_KEYS } from './document';
import { diffValues, editToml, getPath } from './toml-edit';
import type { MutableProfileState } from './config-ops';
import { writeFileAtomic } from '../platform/atomic-write';
import { larkDisplay } from './lark-display';
import { WEB_DISPLAY_DEFAULTS } from '../channels/web/config';
import { getMaxConcurrentRuns, getRunIdleTimeoutMs, getAgentStopGraceMs } from './schema';

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
      : key === 'stop_grace_ms' ? getAgentStopGraceMs(p) : 'native'),
    source: sources[key] ?? (key === 'model' || key === 'effort' ? 'native CLI' : 'built-in'),
  }]));
  const channels = { lark: larkDisplay(p), web: { ...WEB_DISPLAY_DEFAULTS, ...p.channels?.web } };
  const display = Object.fromEntries(Object.entries(channels).map(([channel, fields]) => [channel,
    Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'file_links').map(([key, value]) => {
      const override = `channels.${channel}.profiles.${name}.${key}`;
      const common = `channels.${channel}.${key}`;
      return [key, { value, source: getPath(doc, ['channels', channel, 'profiles', name, key]) !== undefined ? override
        : getPath(doc, ['channels', channel, key]) !== undefined ? common : 'built-in' }];
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

/** Refresh only settings that existing services consult without reconstruction. */
export async function reloadProfile(state: MutableProfileState) {
  const root = await loadRootConfig(state.configPath);
  const next = root?.profiles[state.profile];
  if (!root || !next) throw new Error('profile not found');
  const safe = new Set(['preferences', 'channels', 'access']);
  const restart = [...new Set(diffValues(state.profileConfig, next).map(c => c.path[0]!).filter(k => !safe.has(k)))];
  if (restart.includes('agentKind')) return { restart, revision: configDocument(root)?.revision, applied: [] };
  state.profileConfig = { ...state.profileConfig, preferences: next.preferences, channels: next.channels, access: next.access };
  state.cfg = { ...state.cfg, ...state.profileConfig };
  return { restart, revision: configDocument(root)?.revision, applied: ['run', 'channels', 'access'] };
}

/** Produce a candidate file; never edits source, credentials, cursors or live processes. */
export async function migrateConfig(path: string, output: string | undefined, dryRun: boolean) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  if (raw.schemaVersion !== 2) throw new Error('offline conversion accepts only version-2 profile JSON');
  const allowedRoot = ['schemaVersion', 'activeProfile', 'preferences', 'monitorConfigFile', 'inbox', 'gitlabCi', 'storageMonitor', 'modelServices', 'secrets', 'migrations', 'profiles'];
  for (const key of Object.keys(raw)) if (!allowedRoot.includes(key)) throw new Error(`unknown legacy field: ${key}`);
  if (Object.keys(raw.preferences ?? {}).length) throw new Error('legacy root preferences is not empty; review before migration');
  const preferences = [...Object.values(RUN_KEYS), 'messageReply', 'messageReplyMigrated', 'showToolCalls', 'cotMessages', 'fileLinks', 'access', 'requireMentionInGroup'];
  const profileKeys = ['schemaVersion', 'agentKind', 'mode', 'accounts', 'secrets', 'preferences', 'access', 'workspaces', 'sandbox', 'permissions', 'permissionSource', 'codex', 'claude', 'pi', 'channels', 'attachments', 'comments', 'meeting', 'larkCli'];
  for (const [name,p] of Object.entries(raw.profiles) as [string, Record<string, any>][]) {
    for (const key of Object.keys(p)) if (!profileKeys.includes(key)) throw new Error(`unknown legacy field: profiles.${name}.${key}`);
    for (const key of Object.keys(p.preferences ?? {})) if (!preferences.includes(key)) throw new Error(`unknown legacy preference: profiles.${name}.${key}`);
  }
  const root = normalizeRootConfig(raw);
  if (!root) throw new Error('root config not found');
  const doc = rootToDocument(root);
  const text = formatDocument(doc);
  const migrated = documentToRoot(parseDocument(text));
  for (const [name, original] of Object.entries(root.profiles)) {
    const p = migrated.profiles[name]!;
    for (const key of ['accounts', 'access', 'workspaces', 'permissions', 'attachments', 'meeting', 'larkCli', 'codex', 'claude', 'pi'] as const) {
      if (JSON.stringify(original[key]) !== JSON.stringify(p[key])) throw new Error(`migration mismatch: ${name}.${key}`);
    }
    if (JSON.stringify(larkDisplay(original)) !== JSON.stringify(larkDisplay(p))) throw new Error(`display migration mismatch: ${name}`);
    for (const key of Object.values(RUN_KEYS)) if (original.preferences[key] !== p.preferences[key]) throw new Error(`run migration mismatch: ${name}.${key}`);
  }
  if (!dryRun) {
    if (!output || !output.endsWith('.toml')) throw new Error('请用 --output 明确指定新的 .toml 文件；不会覆盖原配置');
    if (resolve(output) === resolve(path)) throw new Error('migration target must differ from source');
    if (resolve(dirname(output)) !== resolve(dirname(path))) throw new Error('配置须与原文件同目录，以保留监控引用和 profile 状态路径');
    await mkdir(dirname(output), { recursive: true });
    const file = await open(output, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  }
  return { profiles: Object.keys(root.profiles), output: dryRun ? undefined : output, dryRun,
    note: '执行和飞书展示配置已分离；未重启进程，未迁移凭据或会话状态。' };
}
