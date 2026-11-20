import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PiConfig } from '../pi/config';

/** Minimum Node version the Pi SDK supports. */
export const PI_SDK_MIN_NODE = [22, 19, 0] as const;

export interface PiSdkPaths {
  /** Node binary used to run pi-host (must satisfy {@link PI_SDK_MIN_NODE}). */
  nodePath: string;
  /** `@earendil-works/pi-coding-agent/dist/index.js`. */
  sdkPath: string;
  /** Bridge-owned long-lived host entry point. */
  hostScript: string;
}

export class PiSdkPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiSdkPathError';
  }
}

/**
 * Resolve the host launch paths. Explicit config wins; otherwise derive them
 * from the configured `pi` launcher, which the shipped installer writes as a
 * shell wrapper around the Pi Node runtime and the bundled CLI entry point.
 */
export function resolvePiSdkPaths(config: Pick<PiConfig, 'binaryPath' | 'sdkPath' | 'nodePath' | 'hostScript'>): PiSdkPaths {
  const derived = config.sdkPath && config.nodePath ? {} : deriveFromLauncher(config.binaryPath);
  const sdkPath = config.sdkPath?.trim() || derived.sdkPath;
  if (!sdkPath) {
    throw new PiSdkPathError(
      'cannot locate the Pi SDK (pi-coding-agent/dist/index.js). ' +
      'Set agents.pi.launch.sdkPath (and nodePath when the runtime is not next to the package).',
    );
  }
  const nodePath = config.nodePath?.trim()
    || derived.nodePath
    || nodeNextToSdk(sdkPath)
    || process.execPath;
  return {
    nodePath,
    sdkPath,
    hostScript: config.hostScript?.trim() || defaultPiHostScript(),
  };
}

export function resolvePiAgentDir(config: Pick<PiConfig, 'agentDir'>): string {
  return config.agentDir?.trim()
    || process.env.PI_CODING_AGENT_DIR?.trim()
    || join(homedir(), '.pi', 'agent');
}

export function nodeVersionAtLeast(version: string | undefined, minimum: readonly number[]): boolean {
  if (!version) return false;
  const parts = version.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < minimum.length; index += 1) {
    if ((parts[index] ?? 0) > minimum[index]!) return true;
    if ((parts[index] ?? 0) < minimum[index]!) return false;
  }
  return true;
}

/** Resolve the host script relative to the running module (src or dist build). */
function defaultPiHostScript(): string {
  if (import.meta.url.endsWith('.ts')) return fileURLToPath(new URL('../../../bin/pi-host.mjs', import.meta.url));
  const bundled = fileURLToPath(new URL('./bin/pi-host.mjs', import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL('../bin/pi-host.mjs', import.meta.url));
}

interface DerivedLauncherPaths {
  sdkPath?: string;
  nodePath?: string;
}

function deriveFromLauncher(binaryPath: string | undefined): DerivedLauncherPaths {
  if (!binaryPath) return {};
  let launcher: string;
  try {
    launcher = resolveCommand(binaryPath);
  } catch {
    return {};
  }
  // `pi` installed as a JS entry point: derive the SDK next to it directly.
  const directCli = launcher.match(/(?:\/|\\)pi-coding-agent(?:\/|\\)dist(?:\/|\\)(?:bundle(?:\/|\\))?cli\.js$/);
  if (directCli) {
    return { sdkPath: sdkEntryFromCli(launcher) };
  }
  let text: string;
  try {
    const stat = statSync(launcher);
    if (!stat.isFile() || stat.size > 256 * 1024) return {};
    text = readFileSync(launcher, 'utf8');
  } catch {
    return {};
  }
  const cliMatch = text.match(/(?:"|')?([A-Za-z]:)?([^\s"'`]*[\\/]pi-coding-agent[\\/]dist[\\/](?:bundle[\\/])?cli\.js)(?:"|')?/);
  const nodeMatch = text.match(/(?:"|')?([A-Za-z]:)?([^\s"'`]*[\\/]node[\\/]bin[\\/]node(?:\.exe)?)(?:"|')?/);
  const sdkPath = cliMatch ? sdkEntryFromCli(`${cliMatch[1] ?? ''}${cliMatch[2]!}`) : undefined;
  return {
    ...(sdkPath ? { sdkPath } : {}),
    ...(nodeMatch ? { nodePath: `${nodeMatch[1] ?? ''}${nodeMatch[2]!}` } : {}),
  };
}

function sdkEntryFromCli(cliPath: string): string {
  const dir = dirname(cliPath);
  return /[\\/]bundle$/.test(dir) ? resolve(dir, '..', 'index.js') : resolve(dir, 'index.js');
}

function nodeNextToSdk(sdkPath: string): string | undefined {
  // <runtime>/node_modules/node/bin/node next to
  // <runtime>/node_modules/@earendil-works/pi-coding-agent/dist/index.js.
  const candidate = resolve(dirname(sdkPath), '..', '..', '..', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  return existsSync(candidate) ? candidate : undefined;
}

function resolveCommand(command: string): string {
  if (isAbsolute(command)) return command;
  if (command.includes('/') || command.includes('\\')) return resolve(command);
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of commandCandidates(command)) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  throw new PiSdkPathError(`executable not found: ${command}`);
}

function commandCandidates(command: string): string[] {
  if (process.platform !== 'win32' || command.includes('.')) return [command];
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return [command, ...exts.map((ext) => `${command}${ext.toLowerCase()}`)];
}
