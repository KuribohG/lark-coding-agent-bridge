import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentAdapter } from '../../src/agent/backends';
import type { AgentExecutionProfile, AgentKind } from '../../src/config/profile-schema';

const dirs: string[] = [];

afterEach(async () => {
  delete process.env.LAUNCH_ENV_PROCESS_PROXY;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('agent launch environment process contract', () => {
  it.each(['claude', 'codex', 'pi'] as const)(
    'passes resolved launch env to the %s version check',
    async (kind) => {
      const dir = await mkdtemp(join(tmpdir(), `launch-env-${kind}-`));
      dirs.push(dir);
      const binary = join(dir, 'agent');
      await writeFile(binary, '#!/bin/sh\nprintf "%s\\n" "${HTTPS_PROXY:-missing}"\n');
      await chmod(binary, 0o700);
      process.env.LAUNCH_ENV_PROCESS_PROXY = 'http://proxy.internal:8443';

      const profile = launchProfile(kind, binary);
      const adapter = createAgentAdapter({
        profile,
        profileDir: dir,
        env: { LARK_CHANNEL: '1' },
        systemPrompt: '',
      });

      await expect(adapter.checkAvailability?.()).resolves.toMatchObject({
        ok: true,
        version: 'http://proxy.internal:8443',
      });
    },
  );
});

function launchProfile(kind: AgentKind, binaryPath: string): AgentExecutionProfile {
  const base = {
    agentKind: kind,
    permissions: { defaultAccess: 'full' as const, maxAccess: 'full' as const },
  };
  const launch = { binaryPath, env: { HTTPS_PROXY: '$LAUNCH_ENV_PROCESS_PROXY' } };
  if (kind === 'claude') return { ...base, claude: launch };
  if (kind === 'codex') return { ...base, codex: launch };
  return { ...base, pi: launch };
}
