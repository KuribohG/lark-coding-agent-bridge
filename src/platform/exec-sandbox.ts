import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Kernel-enforced exec sandbox for agent runs (Linux Landlock, ABI 4+).
 *
 * The bridge wraps every agent process in `bin/landlock-exec`, which denies all
 * filesystem writes except the paths listed here and lets the whole process
 * tree inherit that domain. It is a blast-radius limit, not an anti-tamper
 * boundary: reads are granted on `/`, and Landlock does not mediate socket
 * connects, so `docker.sock`-style escapes stay possible. See docs/exec-sandbox.md.
 */
export interface ExecSandboxSettings {
  enabled: boolean;
  /** Refuse to start a run when the launcher or Landlock is unavailable. */
  requireLandlock: boolean;
  /** false denies every TCP bind/connect; unix sockets are unaffected. */
  allowTcp: boolean;
  /** Extra writable paths on top of the built-in defaults (`~/...` allowed). */
  readWrite: readonly string[];
  /** Extra read-only paths; `/` is already read-only. */
  readOnly: readonly string[];
}

export const DEFAULT_EXEC_SANDBOX: ExecSandboxSettings = Object.freeze({
  enabled: false,
  requireLandlock: false,
  allowTcp: true,
  readWrite: Object.freeze([]) as readonly string[],
  readOnly: Object.freeze([]) as readonly string[],
});

export interface ExecSandboxInput {
  settings: ExecSandboxSettings | undefined;
  /** The run's working directory; always writable. */
  cwd?: string | undefined;
  /** The env the agent will run with; state directories are derived from it. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Backend id, used to pick the harness state directory. */
  agent?: string | undefined;
  platform?: NodeJS.Platform;
  launcher?: string;
  home?: string;
  tempDir?: string;
}

export interface ExecSandboxCommand {
  command: string;
  args: string[];
  sandboxed: boolean;
}

/** Path of the compiled launcher; resolved the same way as bin/deadline-guard.mjs. */
function execSandboxLauncherPath(): string {
  return fileURLToPath(new URL(
    import.meta.url.endsWith('.ts') ? '../../bin/landlock-exec' : '../bin/landlock-exec', import.meta.url,
  ));
}

/**
 * Caches that build tools and package managers write outside the workspace.
 * Missing directories are skipped by the launcher, so the list can be static.
 */
const SHARED_WRITE_DIRS = [
  '.cache',
  '.config',
  '.local/share',
  '.local/state',
  '.npm',
  '.pnpm-store',
  '.cargo',
  '.rustup',
  '.ccache',
];

/** Harness state that must stay writable, mirroring agent/state-layout.ts. */
function stateDirectories(agent: string | undefined, env: NodeJS.ProcessEnv, home: string): string[] {
  switch (agent) {
    case 'claude':
      return [env.CLAUDE_CONFIG_DIR || join(home, '.claude'), join(home, '.claude.json')];
    case 'codex':
      return [env.CODEX_HOME || join(home, '.codex')];
    case 'pi':
      return [env.PI_CODING_AGENT_DIR || join(home, '.pi')];
    default:
      return [];
  }
}

export function expandSandboxPath(path: string, home: string = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  if (path.startsWith('$HOME/')) return join(home, path.slice('$HOME/'.length));
  return path;
}

function sandboxPathList(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`exec_sandbox.${key}: expected an array of paths`);
  }
  return value.map(item => {
    const path = item.trim();
    if (!isAbsolute(path) && !path.startsWith('~/') && !path.startsWith('$HOME/')) {
      throw new Error(`exec_sandbox.${key}: expected an absolute or ~/ path, got ${path}`);
    }
    return path;
  });
}

/** Validate the TOML `exec_sandbox` table; absent means disabled. */
export function normalizeExecSandbox(input: unknown): ExecSandboxSettings {
  if (input === undefined) return DEFAULT_EXEC_SANDBOX;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('exec_sandbox: expected a table');
  }
  const raw = input as Record<string, unknown>;
  const boolean = (key: string, fallback: boolean): boolean => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new Error(`exec_sandbox.${key}: expected boolean`);
    return value;
  };
  return {
    enabled: boolean('enabled', false),
    requireLandlock: boolean('require_landlock', false),
    allowTcp: boolean('allow_tcp', true),
    readWrite: sandboxPathList(raw.read_write, 'read_write'),
    readOnly: sandboxPathList(raw.read_only, 'read_only'),
  };
}

/** The writable paths a run gets: built-in defaults, harness state, then config extras. */
export function execSandboxWritePaths(input: ExecSandboxInput): string[] {
  const env = input.env ?? process.env;
  const home = input.home ?? env.HOME ?? homedir();
  // Follow the child's environment, not the bridge's, when it changes TMPDIR.
  const tempDir = input.tempDir ?? env.TMPDIR ?? env.TMP ?? env.TEMP ?? tmpdir();
  const paths = [
    ...(input.cwd ? [input.cwd] : []),
    tempDir,
    '/dev',
    ...SHARED_WRITE_DIRS.map(dir => join(home, dir)),
    ...stateDirectories(input.agent, env, home),
    ...(env.LARKSUITE_CLI_CONFIG_DIR ? [env.LARKSUITE_CLI_CONFIG_DIR] : []),
    ...(input.settings?.readWrite ?? []).map(path => expandSandboxPath(path, home)),
  ];
  return [...new Set(paths)].filter(path => path.length > 0);
}

export function execSandboxReadOnlyPaths(input: ExecSandboxInput): string[] {
  const env = input.env ?? process.env;
  const home = input.home ?? env.HOME ?? homedir();
  const paths = ['/', ...(input.settings?.readOnly ?? []).map(path => expandSandboxPath(path, home))];
  return [...new Set(paths)].filter(path => path.length > 0);
}

/**
 * Wrap a command line in the launcher. Returns it unchanged when the sandbox is
 * off, unsupported, or (without `requireLandlock`) missing, so callers can pass
 * every spawn through here unconditionally.
 */
export function buildExecSandboxCommand(
  command: string,
  args: readonly string[],
  input: ExecSandboxInput,
): ExecSandboxCommand {
  const settings = input.settings;
  if (!settings?.enabled) return { command, args: [...args], sandboxed: false };
  const platform = input.platform ?? process.platform;
  const launcher = input.launcher ?? execSandboxLauncherPath();
  if (platform !== 'linux' || !existsSync(launcher)) {
    const reason = platform !== 'linux' ? `unsupported on ${platform}` : `missing ${launcher}`;
    if (settings.requireLandlock) throw new Error(`exec sandbox is required but unavailable: ${reason}`);
    return { command, args: [...args], sandboxed: false };
  }
  const flags: string[] = [];
  for (const path of execSandboxReadOnlyPaths(input)) flags.push('--ro', path);
  for (const path of execSandboxWritePaths(input)) flags.push('--rw', path);
  if (!settings.allowTcp) flags.push('--no-tcp');
  if (settings.requireLandlock) flags.push('--require');
  flags.push('--', command, ...args);
  return { command: launcher, args: flags, sandboxed: true };
}
