import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSource, type ConfigChangeEvent } from '../../../src/config/config-source';
import { log } from '../../../src/core/logger';

const base = (limit: number) => `version = 3
[profiles.bot]
agent = "claude"
[profiles.bot.accounts.app]
id = "cli_a"
secret = { source = "env", id = "S" }
tenant = "feishu"
[profiles.bot.run]
max_concurrent_runs = ${limit}
`;

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function setup(text = base(3)) {
  const dir = await mkdtemp(join(tmpdir(), 'config-source-')); dirs.push(dir);
  const path = join(dir, 'config.toml');
  await writeFile(path, text);
  const source = new ConfigSource(path, root => root.monitorConfigFile ? join(dir, root.monitorConfigFile) : undefined);
  const events: ConfigChangeEvent[] = [];
  source.subscribe(event => { events.push(event); });
  return { dir, path, source, events };
}

describe('ConfigSource', () => {
  it('keeps the last good config when an edit is invalid and reports it once', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { path, source, events } = await setup();
    expect((await source.current())!.profiles.bot!.preferences.maxConcurrentRuns).toBe(3);
    await writeFile(path, base(3) + 'typo_key = 1\n');
    const rejected = await source.refresh('watch');
    expect(rejected.status).toBe('rejected');
    expect(rejected.error?.message).toContain('typo_key');
    expect((await source.current())!.profiles.bot!.preferences.maxConcurrentRuns).toBe(3);
    await source.refresh('watch');
    expect(warn.mock.calls.filter(([, event]) => event === 'reload-rejected')).toHaveLength(1);
    expect(source.error?.message).toContain('typo_key');

    await writeFile(path, base(7));
    expect((await source.refresh('watch')).status).toBe('changed');
    expect(source.error).toBeUndefined();
    expect(events.map(e => [e.kind, e.trigger, e.snapshot.root.profiles.bot!.preferences.maxConcurrentRuns]))
      .toEqual([['config', 'read', 3], ['config', 'watch', 7]]);
  });

  it('publishes once per accepted revision, and again only when forced', async () => {
    const { path, source, events } = await setup();
    await source.refresh('startup');
    await source.refresh('watch');
    expect(events).toHaveLength(1);
    await source.refresh('command', { force: true });
    expect(events.map(e => [e.trigger, e.force])).toEqual([['startup', false], ['command', true]]);
    await writeFile(path, base(4));
    await source.refresh('save');
    expect(events.at(-1)!.previous!.root.profiles.bot!.preferences.maxConcurrentRuns).toBe(3);
  });

  it('throws only when no valid config was ever loaded', async () => {
    const { source } = await setup('version = 3\nbad = true\n');
    await expect(source.current()).rejects.toThrow('bad');
  });

  it('returns independent copies to readers', async () => {
    const { source } = await setup();
    const first = (await source.current())!;
    first.profiles.bot!.preferences.maxConcurrentRuns = 99;
    expect((await source.current())!.profiles.bot!.preferences.maxConcurrentRuns).toBe(3);
  });

  it('reports a missing file without an error', async () => {
    const { path, source } = await setup();
    await rm(path);
    expect(await source.current()).toBeUndefined();
    expect((await source.refresh('watch')).status).toBe('missing');
  });

  it('publishes monitors-file edits separately from the main config', async () => {
    const { dir, path, source, events } = await setup(base(3).replace('version = 3\n', 'version = 3\n[bridge]\nmonitors_file = "monitors.toml"\n'));
    await writeFile(join(dir, 'monitors.toml'), 'version = 1\n[sources]\n');
    await source.refresh('startup');
    await writeFile(join(dir, 'monitors.toml'), 'version = 1\n[sources.gitlab_ci]\nenabled = false\n');
    await source.refresh('watch');
    expect(events.map(e => e.kind)).toEqual(['config', 'monitors']);
    expect(path).toBeTruthy();
  });

  it('reloads after a file watch event', async () => {
    const { path, source, events } = await setup();
    await source.refresh('startup');
    const stop = source.watch();
    try {
      await writeFile(path, base(9));
      await vi.waitFor(() => expect(events.at(-1)?.snapshot.root.profiles.bot!.preferences.maxConcurrentRuns).toBe(9),
        { timeout: 8000, interval: 100 });
      expect(events.at(-1)!.trigger).toBe('watch');
    } finally { stop(); }
  });

  it('isolates subscriber failures', async () => {
    const { path, source } = await setup();
    const warn = vi.spyOn(log, 'warn');
    const later = vi.fn();
    source.subscribe(() => { throw new Error('boom'); });
    source.subscribe(later);
    await writeFile(path, base(5));
    await source.refresh('watch');
    expect(later).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('config', 'apply-listener-failed', expect.objectContaining({ err: 'Error: boom' }));
  });

  it('publishes a monitors file that appears after startup', async () => {
    const { dir, source, events } = await setup(base(3).replace('version = 3\n', 'version = 3\n[bridge]\nmonitors_file = "monitors.toml"\n'));
    await source.refresh('startup');
    await writeFile(join(dir, 'monitors.toml'), 'version = 1\n[sources]\n');
    await source.refresh('watch');
    expect(events.map(e => e.kind)).toEqual(['config', 'monitors']);
  });
});
