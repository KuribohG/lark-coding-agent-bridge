import { describe, expect, it } from 'vitest';
import {
  boundShellTool,
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

describe('pi host shell time limits', () => {
  const limits = { defaultSeconds: 600, maxSeconds: 14_400, defaultHint: 'default hint', cappedHint: 'capped hint' };
  /** A shell tool that records the parameters it ran with and stops the way Pi's does at its timeout. */
  const tool = (stop = false) => {
    const seen: Array<{ command: string; timeout?: number }> = [];
    return { seen, definition: { name: 'bash', async execute(_id: string, params: { command: string; timeout?: number }) {
      seen.push(params);
      if (stop) throw new Error(`partial\n\nCommand timed out after ${params.timeout} seconds`);
      return 'ok';
    } } };
  };

  it('returns the definition untouched when the session has no limits', () => {
    const { definition } = tool();
    expect(boundShellTool(definition, undefined)).toBe(definition);
    expect(boundShellTool(definition, { defaultSeconds: 0, maxSeconds: 0 })).toBe(definition);
  });

  it('fills in the default, caps an excessive timeout and passes a chosen one through', async () => {
    const { seen, definition } = tool();
    const bound = boundShellTool(definition, limits);
    expect(bound.name).toBe('bash');
    await bound.execute('a', { command: 'ls' });
    await bound.execute('b', { command: 'make', timeout: 3600 });
    await bound.execute('c', { command: 'sleep 1d', timeout: 86_400 });
    expect(seen.map(params => params.timeout)).toEqual([600, 3600, 14_400]);
  });

  it('explains a stop by a limit the model did not choose and leaves other failures as they are', async () => {
    const bound = boundShellTool(tool(true).definition, limits);
    await expect(bound.execute('a', { command: 'find /' })).rejects.toThrow(/Command timed out after 600 seconds\n\ndefault hint$/);
    await expect(bound.execute('b', { command: 'sleep 1d', timeout: 86_400 })).rejects.toThrow(/capped hint$/);
    const own = bound.execute('c', { command: 'make', timeout: 60 });
    await expect(own).rejects.toThrow(/Command timed out after 60 seconds$/);
  });
});
