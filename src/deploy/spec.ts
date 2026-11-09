import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ConfigDocument } from '../config/document';
import { LARK_CHANNEL_ENV_KEYS } from '../agent/lark-channel-env';

/** What `up` should be running, resolved from `[deploy]` and its defaults. */
export interface DeploySpec {
  configPath: string;
  /** `self` runs the installation that executes `up`; `git` builds a release per commit. */
  source: { kind: 'self' } | { kind: 'git'; url: string; ref: string };
  profiles: string[];
  node: string;
  cwd: string;
  root: string;
  keep: number;
  env: Record<string, string>;
  readyTimeoutMs: number;
}

export function resolveDeploySpec(doc: ConfigDocument, configPath: string): DeploySpec {
  const d = doc.deploy ?? {};
  const base = dirname(configPath);
  const path = (value: string) => {
    const expanded = value === '~' || value.startsWith('~/') ? join(homedir(), value.slice(1)) : value;
    return isAbsolute(expanded) ? expanded : resolve(base, expanded);
  };
  const profiles: string[] = d.profiles ?? doc.bridge?.autostart_profiles
    ?? (doc.bridge?.active_profile ? [doc.bridge.active_profile] : Object.keys(doc.profiles).slice(0, 1));
  return {
    configPath,
    source: d.git ? { kind: 'git', url: d.git, ref: d.ref ?? 'HEAD' } : { kind: 'self' },
    profiles: [...profiles],
    node: d.node ? path(d.node) : process.execPath,
    cwd: d.cwd ? path(d.cwd) : homedir(),
    root: d.root ? path(d.root) : join(base, 'deploy'),
    keep: d.keep ?? 3,
    env: { ...(d.env ?? {}) },
    readyTimeoutMs: (d.ready_timeout_seconds ?? 180) * 1000,
  };
}

/** Settings whose change needs a new process; the bridge hot-reloads the rest of the file itself. */
export function launchFingerprint(spec: Pick<DeploySpec, 'profiles' | 'node' | 'cwd' | 'env'>): string {
  const env = Object.fromEntries(Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify([spec.profiles, spec.node, spec.cwd, env])).digest('hex').slice(0, 16);
}

/**
 * The bridge's environment: the shell running `up` plus `[deploy].env`. Run
 * bindings a bridge injects into its agents must not leak into the next bridge
 * when an agent runs `up`; the config file's directory is the bridge root.
 */
export function bridgeEnvironment(spec: Pick<DeploySpec, 'env' | 'configPath'>, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  for (const key of [...LARK_CHANNEL_ENV_KEYS, 'LARK_RUN_STOP_AT']) delete env[key];
  return { ...env, LARK_CHANNEL_HOME: dirname(spec.configPath), ...spec.env };
}

/** `run` arguments selecting the profiles; one profile keeps the classic single-profile mode. */
export function runArgs(configPath: string, profiles: readonly string[]): string[] {
  const selector = profiles.length === 1 ? ['--profile', profiles[0]!] : ['--profiles', ...profiles];
  return ['run', ...selector, '--config', configPath];
}
