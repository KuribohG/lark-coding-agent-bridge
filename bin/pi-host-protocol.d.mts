/** Types for `pi-host-protocol.mjs`, which `pi-host.mjs` runs without a build step. */

export function runEnvSnapshot(runEnv: unknown): Record<string, string>;

export function mergeSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runEnv: Record<string, string>,
): NodeJS.ProcessEnv;

export function resolveProviderValue(
  reference: unknown,
  providerEnv?: Record<string, string | undefined> | undefined,
  hostEnv?: NodeJS.ProcessEnv,
): unknown;
