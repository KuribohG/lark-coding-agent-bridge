import { mergeProcessEnv } from '../platform/spawn';
import type { AgentLaunchEnvironment } from '../config/profile-schema';

const REFERENCE = /\$(?:\$|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * Build host and launch environment overrides for an agent process. Launch env
 * values may reference the Bridge environment so configs can copy secrets
 * without storing their resolved values in TOML.
 */
export function buildAgentEnvironment(
  hostEnv: NodeJS.ProcessEnv,
  launchEnv?: AgentLaunchEnvironment,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const source = mergeProcessEnv(inheritedEnv, hostEnv);
  return mergeProcessEnv(hostEnv, expandLaunchEnvironment(launchEnv, source));
}

export function expandLaunchEnvironment(
  launchEnv: AgentLaunchEnvironment | undefined,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!launchEnv) return {};
  return Object.fromEntries(
    Object.entries(launchEnv).map(([key, value]) => [key, expandValue(key, value, source)]),
  );
}

function expandValue(key: string, value: string, source: NodeJS.ProcessEnv): string {
  return value.replace(REFERENCE, (match, braced: string | undefined, bare: string | undefined) => {
    if (match === '$$') return '$';
    const name = braced ?? bare!;
    const resolved = readEnvironment(source, name);
    if (resolved === undefined) {
      throw new Error(`launch env ${key} references missing environment variable ${name}`);
    }
    return resolved;
  });
}

function readEnvironment(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const wanted = name.toLowerCase();
  return Object.entries(env).find(([key]) => key.toLowerCase() === wanted)?.[1];
}
