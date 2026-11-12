import { constants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

interface LocatedBinary {
  /** Path as found; this is what gets written to the config. */
  path: string;
  /** Symlink-resolved path, used to fold duplicates such as nvm shims. */
  realpath: string;
  /** Whether the bridge process would find it through PATH without an explicit binaryPath. */
  onPath: boolean;
}

export interface LocateOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Directory of the running Node; `npm install -g` puts CLI shims next to it. */
  nodeDir?: string;
  /** Machine-wide install directories; overridable so tests do not see the host's installs. */
  systemDirs?: readonly string[];
}

/**
 * Directories where agent CLIs usually land on Linux/macOS but that a login shell,
 * service manager or SSH session may leave out of PATH.
 */
async function commonAgentBinDirs(opts: LocateOptions = {}): Promise<string[]> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const dirs = [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.yarn', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.local', 'share', 'pnpm'),
    ...(opts.systemDirs ?? ['/usr/local/bin', '/opt/homebrew/bin']),
    opts.nodeDir ?? dirname(process.execPath),
  ];
  for (const name of ['PNPM_HOME', 'VOLTA_HOME', 'BUN_INSTALL']) {
    const value = env[name];
    if (value) dirs.push(name === 'PNPM_HOME' ? value : join(value, 'bin'));
  }
  for (const prefix of [env.npm_config_prefix, env.NPM_CONFIG_PREFIX]) {
    if (prefix) dirs.push(join(prefix, 'bin'));
  }
  const versioned: Array<[string, string]> = [
    [env.NVM_DIR ? join(env.NVM_DIR, 'versions', 'node') : join(home, '.nvm', 'versions', 'node'), 'bin'],
    [join(home, '.local', 'share', 'fnm', 'node-versions'), join('installation', 'bin')],
  ];
  for (const [root, suffix] of versioned) {
    for (const version of await listDirectories(root)) dirs.push(join(root, version, suffix));
  }
  return [...new Set(dirs)];
}

/** Every distinct executable named `command`, PATH hits first (in PATH order). */
export async function locateBinaries(command: string, opts: LocateOptions = {}): Promise<LocatedBinary[]> {
  const env = opts.env ?? process.env;
  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const found: LocatedBinary[] = [];
  const seen = new Set<string>();
  const visit = async (dir: string, onPath: boolean): Promise<void> => {
    const candidate = join(dir, command);
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) return;
      const resolved = await realpath(candidate);
      if (seen.has(resolved)) return;
      seen.add(resolved);
      found.push({ path: candidate, realpath: resolved, onPath });
    } catch {
      // Not installed here.
    }
  };
  for (const dir of pathDirs) await visit(dir, true);
  for (const dir of await commonAgentBinDirs(opts)) await visit(dir, false);
  return found;
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse();
  } catch {
    return [];
  }
}
