import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveAppPaths } from '../../config/app-paths';
import { withConfigFileLock } from '../../config/profile-store';
import { loadMonitorRoot, saveMonitorRoot } from '../../monitoring/store';
import { normalizeGitLabCi, validateGitLabCi } from '../../monitoring/sources/gitlab-ci/config';
import { supportsBackgroundProfile } from '../../runtime/agent-capabilities';

export async function configureCiWatch(file: string, opts: { config?: string }): Promise<void> {
  const config = normalizeGitLabCi(JSON.parse(await readFile(file, 'utf8')));
  validateGitLabCi(config);
  const path = opts.config ?? resolveAppPaths().configFile;
  await withConfigFileLock(path, async () => {
    const root = await loadMonitorRoot(path);
    if (!root) throw new Error('Bridge root configuration not found');
    const profile = root.profiles[config.executorProfile];
    if (config.enabled && (!profile || !supportsBackgroundProfile(profile))) {
      throw new Error('GitLab CI requires a personal executor profile with background analysis support');
    }
    root.gitlabCi = config;
    await saveMonitorRoot(root, path);
  });
  console.log('GitLab CI configuration saved; a running bridge with CI watch support reloads it within 15 seconds.');
}

export async function statusCiWatch(opts: { config?: string }): Promise<void> {
  const path = opts.config ?? resolveAppPaths().configFile;
  const root = await loadMonitorRoot(path);
  let state: unknown;
  try { state = JSON.parse(await readFile(join(dirname(path), 'gitlab-ci', 'state.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  console.log(JSON.stringify({ config: normalizeGitLabCi(root?.gitlabCi), state: state ?? null,
    note: 'Persisted status only; enabled does not prove that the executor is online.' }, null, 2));
}
