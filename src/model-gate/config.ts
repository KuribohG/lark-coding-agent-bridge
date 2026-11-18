/**
 * Operator-facing limits for the model gate: one bucket per model provider.
 *
 * A provider is the thing a quota belongs to — an endpoint plus a credential —
 * not a workflow. Limits are therefore configured per provider and shared by
 * every run of every profile that reaches that provider.
 */

/** Limits of one provider. */
export interface ModelGateBucketConfig {
  /** Requests per minute. Refill is continuous, as the provider's own token bucket is. */
  rpm: number;
  /** Requests that may start back to back after an idle period; ≤ the provider's bucket capacity. */
  burst: number;
  /**
   * Model requests in flight at once. A request holds a slot only while the
   * provider is answering. `0` means the provider imposes no such limit: only
   * the rate bucket applies.
   */
  concurrency: number;
}

export interface ModelGateConfig {
  enabled: boolean;
  /**
   * When the gate cannot be reached, runs proceed unthrottled. A broken gate
   * must not take the bridge down; the provider's own 429s remain the backstop.
   */
  failOpen: boolean;
  /** A permit not released within this many seconds is reclaimed so a dead run cannot leak a slot. */
  leaseSeconds: number;
  /** Limits for a provider with no entry of its own. */
  defaults: ModelGateBucketConfig;
  /** Per-provider overrides, keyed by the model provider id workers report. */
  providers: Record<string, ModelGateBucketConfig>;
}

export const MODEL_GATE_DEFAULTS: ModelGateBucketConfig = Object.freeze({
  rpm: 1000,
  burst: 100,
  concurrency: 100,
});

const DEFAULT_LEASE_SECONDS = 600;

/** The bucket a provider falls under: its own entry, or the defaults. */
export function bucketFor(config: ModelGateConfig, provider: string): ModelGateBucketConfig {
  return config.providers[provider] ?? config.defaults;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${path}: expected integer ${min}..${max}`);
  }
  return value as number;
}

function bucket(value: unknown, path: string, base: ModelGateBucketConfig): ModelGateBucketConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected a table`);
  const table = value as Record<string, unknown>;
  for (const key of Object.keys(table)) {
    if (!['rpm', 'burst', 'concurrency'].includes(key)) throw new Error(`${path}.${key}: unknown setting`);
  }
  const rpm = table.rpm === undefined ? base.rpm : integer(table.rpm, `${path}.rpm`, 1, 1_000_000);
  const burst = table.burst === undefined
    ? base.burst : integer(table.burst, `${path}.burst`, 1, 1_000_000);
  // 0 is "no in-flight limit"; it is a deliberate choice, not a missing value.
  const concurrency = table.concurrency === undefined
    ? base.concurrency : integer(table.concurrency, `${path}.concurrency`, 0, 4096);
  // More burst than a whole minute of refill is never useful and only makes the
  // first second of a minute indistinguishable from an outage.
  return { rpm, burst: Math.min(burst, rpm), concurrency };
}

/**
 * Validate a `[gate]` table. Returns undefined when the table is absent so a
 * bridge without gate configuration keeps its previous behaviour exactly.
 */
export function normalizeModelGate(raw: unknown): ModelGateConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('gate: expected a table');
  const table = raw as Record<string, unknown>;
  for (const key of Object.keys(table)) {
    if (!['enabled', 'fail_open', 'lease_seconds', 'defaults', 'providers'].includes(key)) {
      throw new Error(`gate.${key}: unknown setting`);
    }
  }
  const enabled = table.enabled === undefined ? true : table.enabled;
  if (typeof enabled !== 'boolean') throw new Error('gate.enabled: expected boolean');
  const failOpen = table.fail_open === undefined ? true : table.fail_open;
  if (typeof failOpen !== 'boolean') throw new Error('gate.fail_open: expected boolean');
  const leaseSeconds = table.lease_seconds === undefined
    ? DEFAULT_LEASE_SECONDS : integer(table.lease_seconds, 'gate.lease_seconds', 10, 86_400);
  const defaults = table.defaults === undefined
    ? MODEL_GATE_DEFAULTS : bucket(table.defaults, 'gate.defaults', MODEL_GATE_DEFAULTS);
  const providers: Record<string, ModelGateBucketConfig> = {};
  if (table.providers !== undefined) {
    if (!table.providers || typeof table.providers !== 'object' || Array.isArray(table.providers)) {
      throw new Error('gate.providers: expected a table');
    }
    for (const [name, value] of Object.entries(table.providers as Record<string, unknown>)) {
      if (!name.trim()) throw new Error('gate.providers: empty provider name');
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
        throw new Error(`gate.providers: invalid provider name: ${name}`);
      }
      // A provider overrides only the dimensions it names; the rest come from `defaults`.
      providers[name] = bucket(value, `gate.providers.${name}`, defaults);
    }
  }
  return { enabled, failOpen, leaseSeconds, defaults, providers };
}

/** Render the config back into the TOML table, so a config write keeps it. */
export function modelGateTable(config: ModelGateConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    enabled: config.enabled,
    fail_open: config.failOpen,
    lease_seconds: config.leaseSeconds,
    defaults: { ...config.defaults },
  };
  if (Object.keys(config.providers).length > 0) {
    out.providers = Object.fromEntries(Object.entries(config.providers).map(([name, value]) => [name, { ...value }]));
  }
  return out;
}
