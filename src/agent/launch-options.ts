export type AgentAuthMode = 'oauth' | 'api_key';
export type AgentLaunchEnvironment = Record<string, string | undefined>;
export type AgentLaunchConfig = Record<string, string | number | boolean | string[] | AgentLaunchEnvironment>;

export interface ExecutableLaunchConfig {
  binaryPath: string;
  env?: AgentLaunchEnvironment;
  unsetEnv?: string[];
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeAuthMode(input: unknown, context: string): AgentAuthMode {
  if (input !== 'oauth' && input !== 'api_key') {
    throw new Error(`${context}: expected oauth or api_key`);
  }
  return input;
}

export function normalizeUnsetEnv(input: unknown, context = 'launch unsetEnv'): string[] {
  if (!Array.isArray(input)) {
    throw new Error(`${context} must be an array of variable names`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of input) {
    if (typeof key !== 'string' || !ENV_NAME_PATTERN.test(key)) {
      throw new Error(`${context} has invalid variable name: ${String(key)}`);
    }
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function normalizeLaunchEnvironment(input: unknown): { env: Record<string, string>; unsetKeys: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('launch env must be a table of string values');
  }
  const env: Record<string, string> = {};
  const unsetKeys: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!ENV_NAME_PATTERN.test(key)) {
      throw new Error(`launch env has invalid variable name: ${key}`);
    }
    if (value === undefined) {
      unsetKeys.push(key);
      continue;
    }
    if (typeof value !== 'string') {
      throw new Error(`launch env ${key} must be a string`);
    }
    env[key] = value;
  }
  return { env, unsetKeys };
}

export function normalizeExecutableFields(input: Partial<ExecutableLaunchConfig>): Partial<ExecutableLaunchConfig> {
  const normalizedEnv = input.env !== undefined ? normalizeLaunchEnvironment(input.env) : undefined;
  const explicitUnset = input.unsetEnv !== undefined ? normalizeUnsetEnv(input.unsetEnv) : undefined;
  const unsetEnv = [...new Set([...(explicitUnset ?? []), ...(normalizedEnv?.unsetKeys ?? [])])];
  return {
    ...(typeof input.binaryPath === 'string' && input.binaryPath ? { binaryPath: input.binaryPath } : {}),
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(normalizedEnv !== undefined ? { env: normalizedEnv.env } : {}),
    ...(unsetEnv.length > 0 || explicitUnset !== undefined ? { unsetEnv } : {}),
  };
}

export function normalizeExecutableLaunch(input: ExecutableLaunchConfig, backend: string): ExecutableLaunchConfig {
  if (!input || typeof input.binaryPath !== 'string' || !input.binaryPath) throw new Error(`${backend}.binaryPath is required`);
  return { ...normalizeExecutableFields(input), binaryPath: input.binaryPath };
}
