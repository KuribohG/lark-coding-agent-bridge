import { describe, expect, it } from 'vitest';
import {
  mergeSpawnEnv,
  resolveProviderValue,
  runEnvSnapshot,
} from '../../../bin/pi-host-protocol.mjs';

// The host serves many sessions from one process, so these helpers are what
// keeps one run's bindings out of every other session's process environment.

describe('pi host protocol', () => {
  it('snapshots only string run bindings, dropping functions and numbers', () => {
    expect(runEnvSnapshot({ AGENT_WORKFLOW_TOKEN: 'attempt-one', RETRIES: 3, undefinedValue: undefined }))
      .toEqual({ AGENT_WORKFLOW_TOKEN: 'attempt-one' });
  });

  it('resets rather than merges between runs', () => {
    expect(runEnvSnapshot(undefined)).toEqual({});
    expect(runEnvSnapshot(null)).toEqual({});
  });

  it('copies the bindings so a later run cannot mutate a live spawn context', () => {
    const source = { AGENT_WORKFLOW_TOKEN: 'attempt-one' };
    const snapshot = runEnvSnapshot(source);
    source.AGENT_WORKFLOW_TOKEN = 'attempt-two';
    expect(snapshot.AGENT_WORKFLOW_TOKEN).toBe('attempt-one');
  });

  it('overlays the run bindings on the tool environment without dropping base variables', () => {
    expect(mergeSpawnEnv({ PATH: '/usr/bin', AGENT_WORKFLOW_TOKEN: 'host-wide' },
      { AGENT_WORKFLOW_TOKEN: 'attempt-one' })).toEqual({
      PATH: '/usr/bin',
      AGENT_WORKFLOW_TOKEN: 'attempt-one',
    });
  });

  it('resolves provider credentials from the run bindings before the host environment', () => {
    expect(resolveProviderValue('$KEY', { KEY: 'run-key' }, { KEY: 'host-key' })).toBe('run-key');
    expect(resolveProviderValue('${KEY}', { KEY: 'run-key' }, {})).toBe('run-key');
    expect(resolveProviderValue('$KEY', undefined, { KEY: 'host-key' })).toBe('host-key');
  });

  it('keeps an unresolved reference so the provider still names the missing variable', () => {
    expect(resolveProviderValue('$MISSING', {}, {})).toBe('$MISSING');
    expect(resolveProviderValue('$MISSING', { MISSING: '' }, {})).toBe('$MISSING');
  });

  it('leaves literal values and non-references untouched', () => {
    expect(resolveProviderValue('sk-literal-value', {}, {})).toBe('sk-literal-value');
    expect(resolveProviderValue('Bearer $KEY', { KEY: 'run-key' }, {})).toBe('Bearer $KEY');
    expect(resolveProviderValue(undefined, {}, {})).toBeUndefined();
  });
});
