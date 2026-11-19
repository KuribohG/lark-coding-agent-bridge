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

/** A shell tool definition whose calls run under the bridge's time limits; the definition itself when there are none. */
export function boundShellTool<T extends { execute(toolCallId: string, params: any, ...rest: any[]): Promise<unknown> }>(
  definition: T,
  limits?: { defaultSeconds?: number; maxSeconds?: number; defaultHint?: string; cappedHint?: string } | null,
): T;
