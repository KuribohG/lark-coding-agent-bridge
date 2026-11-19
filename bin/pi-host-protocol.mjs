/**
 * Pure helpers shared by `pi-host.mjs`, split into their own module so the
 * rules that keep concurrent sessions apart can be unit tested without
 * booting the SDK host (which needs Pi's own Node build).
 */

/** The run bindings a session may expose to its shell tools; never process.env. */
export function runEnvSnapshot(runEnv) {
  const snapshot = {};
  if (runEnv && typeof runEnv === 'object') {
    for (const [name, value] of Object.entries(runEnv)) {
      if (typeof value === 'string') snapshot[name] = value;
    }
  }
  return snapshot;
}

/** A spawn sees the tool's own environment plus the bindings of the owning run. */
export function mergeSpawnEnv(baseEnv, runEnv) {
  return { ...baseEnv, ...runEnv };
}

/**
 * Resolve a `$NAME` reference from the run's own bindings first, then the host
 * environment. Returning the literal value instead of writing it into
 * process.env is what makes two concurrent runs with different credentials
 * safe; an unresolved reference stays a reference so the provider still names
 * the missing variable when it fails.
 */
export function resolveProviderValue(reference, providerEnv, hostEnv = process.env) {
  if (typeof reference !== 'string') return reference;
  const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(reference);
  if (!match) return reference;
  const name = match[1];
  const fromRun = providerEnv?.[name];
  if (typeof fromRun === 'string' && fromRun) return fromRun;
  const fromHost = hostEnv?.[name];
  return typeof fromHost === 'string' && fromHost ? fromHost : reference;
}

/**
 * Pi's shell tools wait for ever on a call without `timeout`. The bridge gives
 * such a call a default and caps an explicit one; src/agent/pi/bash-timeout.ts
 * has the reasoning, and the CLI transport does the same in an extension. The
 * numbers and the hints come from the bridge with the session.
 */
export function boundShellTool(definition, limits) {
  const positive = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined);
  const defaultSeconds = positive(limits?.defaultSeconds);
  const maxSeconds = positive(limits?.maxSeconds);
  if (defaultSeconds === undefined && maxSeconds === undefined) return definition;
  const execute = definition.execute;
  return {
    ...definition,
    async execute(toolCallId, params, ...rest) {
      const asked = params?.timeout;
      let bounded = params;
      let hint;
      if (asked === undefined || asked === null) {
        if (defaultSeconds !== undefined) {
          bounded = { ...params, timeout: defaultSeconds };
          hint = limits.defaultHint;
        }
      } else if (maxSeconds !== undefined && typeof asked === 'number' && asked > maxSeconds) {
        bounded = { ...params, timeout: maxSeconds };
        hint = limits.cappedHint;
      }
      try {
        return await execute(toolCallId, bounded, ...rest);
      } catch (error) {
        // Tell the model the limit that stopped the call was not its own.
        if (typeof hint === 'string' && error instanceof Error
          && error.message.includes(`Command timed out after ${bounded.timeout} seconds`)) {
          throw new Error(`${error.message}\n\n${hint}`);
        }
        throw error;
      }
    },
  };
}
