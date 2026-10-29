import { isAgentKind } from '../agent/backend-spec';
import { documentToRoot, parseDocument, rootToDocument, formatDocument, type ConfigDocument } from './document';
import { diffValues, editToml } from './toml-edit';
import { chmod, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../platform/atomic-write';
import { resolveAppPaths } from './app-paths';
import {
  normalizeProfileConfig,
  type AgentKind,
  type ProfileConfig,
  type RootConfig,
} from './profile-schema';
import type { AppConfig } from './schema';
import { parseWorkItemConcurrency } from '../work-items/concurrency';
import { normalizeMonitorRootValues } from '../monitoring/sources/configs';
import { normalizeModelServices } from '../model-service/config';
import { configRevision } from './revision';

export { configRevision } from './revision';

interface DocumentSnapshot { text: string; document: ConfigDocument; root: RootConfig; revision: string }
const documents = new WeakMap<RootConfig, DocumentSnapshot>();
export const configDocument = (root: RootConfig) => documents.get(root);
export async function loadRootConfig(path: string): Promise<RootConfig | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    const document = parseDocument(text);
    const root = normalizeRootConfig(documentToRoot(document));
    documents.set(root, { text, document, root: structuredClone(root), revision: configRevision(text) });
    return root;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export function normalizeRootConfig(root: RootConfig): RootConfig {
  const profiles: RootConfig['profiles'] = {};
  for (const [name, profile] of Object.entries(root.profiles)) {
    profiles[name] = normalizeProfileConfig(profile);
  }
  const migrations = normalizeRootMigrations(root.migrations);
  const monitoring = normalizeMonitorRootValues({
    inbox: root.inbox,
    gitlabCi: root.gitlabCi,
    storageMonitor: root.monitorConfigFile === undefined ? root.storageMonitor : undefined,
  });
  return {
    schemaVersion: 2,
    activeProfile: root.activeProfile,
    ...(root.autostartProfiles !== undefined
      ? { autostartProfiles: uniqueSortedStrings(root.autostartProfiles).filter(name => Boolean(profiles[name])) }
      : {}),
    preferences: {},
    ...(root.monitorConfigFile !== undefined ? { monitorConfigFile: root.monitorConfigFile } : {}),
    ...monitoring,
    ...(root.monitorConfigFile === undefined && root.workItemConcurrency !== undefined ? { workItemConcurrency: parseWorkItemConcurrency(root.workItemConcurrency) } : {}),
    ...(root.modelServices ? { modelServices: normalizeModelServices(root.modelServices) } : {}),
    ...(root.secrets ? { secrets: root.secrets } : {}),
    ...(migrations ? { migrations } : {}),
    profiles,
  };
}

export async function saveRootConfig(root: RootConfig, path: string, resetPaths: string[][] = []): Promise<void> {
  let snapshot = documents.get(root);
  if (!snapshot) {
    const current = await loadRootConfig(path);
    snapshot = current ? documents.get(current) : undefined;
  }
  let text = snapshot?.text ?? formatDocument(rootToDocument(normalizeRootConfig(root)));
  if (snapshot) {
    if (await readFile(path, 'utf8') !== snapshot.text) throw new Error('配置文件已改变，请重新读取后保存');
    for (const change of diffValues(rootToDocument(snapshot.root), rootToDocument(root))) {
      text = editToml(text, change.path, change.value);
    }
  }
  for (const path of resetPaths) text = editToml(text, path, undefined);
  const document = parseDocument(text);
  const resolved = normalizeRootConfig(documentToRoot(document));
  if (text !== snapshot?.text) {
    if (snapshot && await readFile(path, 'utf8') !== snapshot.text) throw new Error('配置文件已改变，请重新读取后保存');
    await writeFileAtomic(path, text, { mode: 0o600 });
  }
  for (const key of Object.keys(root)) delete (root as unknown as Record<string, unknown>)[key];
  Object.assign(root, resolved);
  documents.set(root, { text, document, root: structuredClone(root), revision: configRevision(text) });
}

/** Export a standalone TOML document with this profile's effective settings. */
export function formatRootConfig(root: RootConfig): string {
  return formatDocument(rootToDocument(root));
}

export async function withConfigFileLock<T>(configPath: string, fn: () => Promise<T>): Promise<T> {
  const lockTarget = `${configPath}.lock`;
  await mkdir(dirname(lockTarget), { recursive: true });
  await writeFile(lockTarget, '', { flag: 'a', mode: 0o600 });
  await chmod(lockTarget, 0o600).catch(() => {});
  const release = await lockfile.lock(lockTarget, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: {
      retries: 10,
      minTimeout: 10,
      maxTimeout: 100,
    },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function readActiveProfile(rootDir?: string): Promise<string | undefined> {
  // The sidecar is the runtime source of truth; config.toml.activeProfile is
  // the serialized mirror used when importing or rebuilding a config.
  const activeProfileFile = join(
    rootDir ?? process.env.LARK_CHANNEL_HOME ?? resolveAppPaths().rootDir,
    'active-profile',
  );
  try {
    const text = await readFile(activeProfileFile, 'utf8');
    const profile = text.trim();
    return profile || undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function writeActiveProfile(rootDir: string, profile: string): Promise<void> {
  const activeProfileFile = join(rootDir, 'active-profile');
  await writeFileAtomic(activeProfileFile, `${profile}\n`, { mode: 0o600 });
}

/** Supervisor boot set. Missing config preserves the legacy active-profile behavior. */
export function getAutostartProfiles(root: Pick<RootConfig, 'activeProfile' | 'autostartProfiles' | 'profiles'>): string[] {
  const configured = root.autostartProfiles ?? (root.activeProfile ? [root.activeProfile] : []);
  return uniqueSortedStrings(configured).filter(name => Boolean(root.profiles[name]));
}

export function runtimeProfileConfig(root: RootConfig, profile: string): AppConfig & ProfileConfig {
  const cfg = root.profiles[profile];
  if (!cfg) {
    throw new Error(`profile not found: ${profile}`);
  }
  return {
    ...cfg,
    ...(cfg.secrets ?? root.secrets ? { secrets: cfg.secrets ?? root.secrets } : {}),
  };
}

export function createRootConfig(profile: string, cfg: ProfileConfig, secrets = cfg.secrets): RootConfig {
  return {
    schemaVersion: 2,
    activeProfile: profile,
    preferences: {},
    ...(secrets ? { secrets } : {}),
    migrations: { permissionDefaultsV1: [profile] },
    profiles: {
      [profile]: {
        ...cfg,
        secrets: undefined,
      },
    },
  };
}

export function hasPermissionDefaultsMigration(root: RootConfig, profile: string): boolean {
  return root.migrations?.permissionDefaultsV1?.includes(profile) ?? false;
}

export function markPermissionDefaultsMigration(root: RootConfig, profile: string): RootConfig {
  const permissionDefaultsV1 = uniqueSortedStrings([
    ...(root.migrations?.permissionDefaultsV1 ?? []),
    profile,
  ]);
  return {
    ...root,
    migrations: {
      ...root.migrations,
      permissionDefaultsV1,
    },
  };
}

function normalizeRootMigrations(input: RootConfig['migrations'] | undefined): RootConfig['migrations'] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const permissionDefaultsV1 = uniqueSortedStrings(input.permissionDefaultsV1);
  return permissionDefaultsV1.length > 0 ? { permissionDefaultsV1 } : undefined;
}

function uniqueSortedStrings(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0))]
    .sort();
}

export interface RemoveProfileOptions {
  purge?: boolean;
  now?: () => Date;
}

export interface RemoveProfileResult {
  root: RootConfig;
  archivedTo?: string;
  purged?: boolean;
  restore?: () => Promise<void>;
  cleanup?: () => Promise<void>;
}

export async function removeProfile(
  root: RootConfig,
  profile: string,
  rootDir: string,
  opts: RemoveProfileOptions = {},
): Promise<RemoveProfileResult> {
  if (!root.profiles[profile]) throw new Error(`profile not found: ${profile}`);
  const next: RootConfig = {
    ...root,
    profiles: { ...root.profiles },
  };
  delete next.profiles[profile];
  if (root.activeProfile === profile) {
    next.activeProfile = Object.keys(next.profiles).sort((a, b) => a.localeCompare(b))[0] ?? '';
  }
  if (root.autostartProfiles !== undefined) {
    next.autostartProfiles = root.autostartProfiles.filter(name => name !== profile);
  }
  const profileDir = resolveAppPaths({ rootDir, profile }).profileDir;
  if (opts.purge) {
    if (!(await pathExists(profileDir))) return { root: next, purged: true };
    const trashDir = join(rootDir, '.trash');
    await mkdir(trashDir, { recursive: true });
    const stagedTo = await nextArchivePath(trashDir, profile, opts.now?.() ?? new Date());
    await rename(profileDir, stagedTo);
    return {
      root: next,
      archivedTo: stagedTo,
      purged: true,
      restore: async () => {
        await rename(stagedTo, profileDir);
      },
      cleanup: async () => {
        await rm(stagedTo, { recursive: true, force: true });
        await rmdir(trashDir).catch(() => {});
      },
    };
  }

  const trashDir = join(rootDir, '.trash');
  await mkdir(trashDir, { recursive: true });
  const archivedTo = await nextArchivePath(trashDir, profile, opts.now?.() ?? new Date());
  await rename(profileDir, archivedTo);
  return {
    root: next,
    archivedTo,
    restore: async () => {
      await rename(archivedTo, profileDir);
    },
  };
}

async function nextArchivePath(trashDir: string, profile: string, now: Date): Promise<string> {
  const base = join(trashDir, `${profile}-${archiveTimestamp(now)}`);
  for (let suffix = 0; ; suffix++) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    if (!(await pathExists(candidate))) return candidate;
  }
}

function archiveTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function agentKindFromString(value: string | undefined): AgentKind | undefined {
  if (isAgentKind(value)) return value;
  if (value === undefined) return undefined;
  throw new Error(`unsupported agent: ${value}`);
}
