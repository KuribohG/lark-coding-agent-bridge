import { describe, expect, it } from 'vitest';
import { MODEL_GATE_DEFAULTS, normalizeModelGate } from '../../../src/model-gate/config';
import { documentToRoot, formatDocument, parseDocument, rootToDocument } from '../../../src/config/document';

describe('normalizeModelGate', () => {
  it('treats a missing table as no gate at all', () => {
    expect(normalizeModelGate(undefined)).toBeUndefined();
  });

  it('defaults to 1000 rpm, a burst of one minute of requests, and 100 in flight', () => {
    const config = normalizeModelGate({})!;
    expect(config).toMatchObject({
      enabled: true,
      failOpen: true,
      leaseSeconds: 600,
      defaults: MODEL_GATE_DEFAULTS,
      providers: {},
    });
    expect(MODEL_GATE_DEFAULTS).toEqual({ rpm: 1000, burst: 1000, concurrency: 100 });
  });

  it('lets a burst nobody named follow the rpm of its bucket', () => {
    const config = normalizeModelGate({
      defaults: { rpm: 300 },
      providers: { fast: { rpm: 5000 }, slow: { rpm: 60, concurrency: 0 }, plain: { concurrency: 8 } },
    })!;
    expect(config.defaults).toEqual({ rpm: 300, burst: 300, concurrency: 100 });
    expect(config.providers.fast).toEqual({ rpm: 5000, burst: 5000, concurrency: 100 });
    expect(config.providers.slow).toEqual({ rpm: 60, burst: 60, concurrency: 0 });
    expect(config.providers.plain).toEqual({ rpm: 300, burst: 300, concurrency: 8 });
    // Without a `defaults` table at all, the same holds.
    expect(normalizeModelGate({ providers: { fast: { rpm: 5000 } } })!.providers.fast).toEqual({ rpm: 5000, burst: 5000, concurrency: 100 });
  });

  it('keeps a burst that was named: its own, or the one of the defaults', () => {
    const config = normalizeModelGate({
      defaults: { rpm: 1000, burst: 200 },
      providers: { inherits: { rpm: 5000 }, own: { rpm: 5000, burst: 50 } },
    })!;
    expect(config.providers.inherits).toEqual({ rpm: 5000, burst: 200, concurrency: 100 });
    expect(config.providers.own).toEqual({ rpm: 5000, burst: 50, concurrency: 100 });
  });

  it('lets one provider override only the dimension it names', () => {
    const config = normalizeModelGate({
      defaults: { rpm: 500, burst: 40, concurrency: 20 },
      providers: { deepseek: { rpm: 1000 } },
    })!;
    expect(config.defaults).toEqual({ rpm: 500, burst: 40, concurrency: 20 });
    expect(config.providers.deepseek).toEqual({ rpm: 1000, burst: 40, concurrency: 20 });
  });

  it('derives a burst that cannot exceed one minute of refill', () => {
    const config = normalizeModelGate({
      defaults: { rpm: 30, burst: 500 },
    })!;
    expect(config.defaults.burst).toBe(30);
  });

  it('rejects unknown settings instead of silently ignoring typos', () => {
    expect(() => normalizeModelGate({ enabled: true, failopen: true })).toThrow(/gate\.failopen: unknown setting/);
    expect(() => normalizeModelGate({ defaults: { rpm: 10, limit: 3 } })).toThrow(/gate\.defaults\.limit/);
  });

  it('rejects out-of-range values', () => {
    expect(() => normalizeModelGate({ defaults: { rpm: 0 } })).toThrow(/expected integer 1/);
    expect(() => normalizeModelGate({ defaults: { concurrency: 100_000 } })).toThrow(/expected integer 0\.\.4096/);
    expect(() => normalizeModelGate({ defaults: { concurrency: -1 } })).toThrow(/expected integer 0\.\.4096/);
    expect(() => normalizeModelGate({ lease_seconds: 5 })).toThrow(/expected integer 10/);
  });

  it('reads concurrency 0 as "this provider has no in-flight limit"', () => {
    const config = normalizeModelGate({ providers: { deepseek: { concurrency: 0 } } })!;
    expect(config.providers.deepseek?.concurrency).toBe(0);
    // The other dimensions still come from the defaults.
    expect(config.providers.deepseek).toMatchObject({ rpm: 1000, burst: 1000 });
  });
});

describe('[gate] in the config document', () => {
  const base = `
version = 3
[bridge]
active_profile = "main"
[profiles.main]
agent = "pi"
[profiles.main.accounts.app]
id = "cli_test"
secret = "secret"
tenant = "feishu"
`;

  it('survives a parse and write round trip', () => {
    const text = `${base}
[gate]
enabled = true
lease_seconds = 120
[gate.defaults]
rpm = 1000
burst = 100
concurrency = 100
[gate.providers.deepseek]
concurrency = 32
`;
    const doc = parseDocument(text);
    const root = documentToRoot(doc);
    expect(root.modelGate).toMatchObject({
      enabled: true,
      leaseSeconds: 120,
      providers: { deepseek: { rpm: 1000, burst: 100, concurrency: 32 } },
    });

    const written = rootToDocument(root);
    expect(written.gate).toMatchObject({
      enabled: true,
      lease_seconds: 120,
      providers: { deepseek: { concurrency: 32 } },
    });
    // A config write must not drop the table: parse the rendered output again.
    const reread = parseDocument(formatDocument(rootToDocument(root)));
    expect(documentToRoot(reread).modelGate?.providers['deepseek']?.concurrency).toBe(32);
  });

  it('rejects an invalid gate table at parse time', () => {
    expect(() => parseDocument(`${base}\n[gate]\nrpm = 5\n`)).toThrow(/gate\.rpm: unknown setting/);
  });
});
