import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { profileWorkflowStores } from '../../../src/cli/commands/dashboard';

const cleanup: string[] = [];
afterEach(async () => { for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-home-'));
  cleanup.push(root);
  for (const profile of ['codex', 'bot2', 'idle']) await mkdir(join(root, 'profiles', profile), { recursive: true });
  for (const profile of ['codex', 'bot2']) await writeFile(join(root, 'profiles', profile, 'workflows.sqlite'), '');
  return root;
}

describe('workflow stores of a bridge home', () => {
  it('finds the profiles that have a workflow store', async () => {
    const root = await home();
    expect(profileWorkflowStores(root)).toEqual([
      { name: 'bot2', path: join(root, 'profiles', 'bot2', 'workflows.sqlite') },
      { name: 'codex', path: join(root, 'profiles', 'codex', 'workflows.sqlite') },
    ]);
  });

  it('lists a named profile even before its first workflow', async () => {
    const root = await home();
    expect(profileWorkflowStores(root, ['idle', 'codex']).map(source => source.name)).toEqual(['idle', 'codex']);
  });

  it('finds nothing in a home without profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dashboard-home-'));
    cleanup.push(root);
    expect(profileWorkflowStores(root)).toEqual([]);
  });
});
