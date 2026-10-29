export type AgentLaunchEnvironment = Record<string, string>;
export type AgentLaunchConfig = Record<string, string | number | boolean | AgentLaunchEnvironment>;

export interface ExecutableLaunchConfig {
  binaryPath: string;
  env?: AgentLaunchEnvironment;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
}

function normalizeLaunchEnvironment(input: unknown): AgentLaunchEnvironment {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('launch env must be a table of string values');
  }
  const entries = Object.entries(input);
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`launch env has invalid variable name: ${key}`);
    }
    if (typeof value !== 'string') {
      throw new Error(`launch env ${key} must be a string`);
    }
  }
  return Object.fromEntries(entries) as AgentLaunchEnvironment;
}


export function normalizeExecutableFields(input: Partial<ExecutableLaunchConfig>): Partial<ExecutableLaunchConfig> {
  return {
    ...(typeof input.binaryPath === 'string' && input.binaryPath ? { binaryPath: input.binaryPath } : {}),
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(input.env !== undefined ? { env: normalizeLaunchEnvironment(input.env) } : {}),
  };
}

export function normalizeExecutableLaunch(input: ExecutableLaunchConfig, backend: string): ExecutableLaunchConfig {
  if (!input || typeof input.binaryPath !== 'string' || !input.binaryPath) throw new Error(`${backend}.binaryPath is required`);
  return { ...normalizeExecutableFields(input), binaryPath: input.binaryPath };
}
