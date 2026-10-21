import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScopeExecutionStore } from '../../../src/session/scope-execution';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ScopeExecutionStore', () => {
  it('persists independent engine overrides per chat and topic', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scope-execution-'));
    dirs.push(dir);
    const path = join(dir, 'scope-execution.json');
    const store = new ScopeExecutionStore(path);
    await store.load();

    await store.set('oc_chat', 'codex');
    await store.set('oc_chat:omt_topic', 'pi');
    await store.set('oc_other', 'claude');

    const loaded = new ScopeExecutionStore(path);
    await loaded.load();
    expect(loaded.get('oc_chat')).toBe('codex');
    expect(loaded.get('oc_chat:omt_topic')).toBe('pi');
    expect(loaded.get('oc_other')).toBe('claude');

    await loaded.clear('oc_chat:omt_topic');
    await loaded.clearAgentKind('claude');
    expect(loaded.entries()).toEqual([{ scope: 'oc_chat', agentKind: 'codex' }]);
  });
});
