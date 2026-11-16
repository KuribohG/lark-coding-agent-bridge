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
