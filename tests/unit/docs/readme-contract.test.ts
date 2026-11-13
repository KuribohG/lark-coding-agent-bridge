import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('documentation runtime contract', () => {
  it.each(['README.md', 'README.zh.md'])('keeps %s to the Linux setup path', async file => {
    const readme = await readFile(new URL(`../../../${file}`, import.meta.url), 'utf8');
    expect(readme.split('\n').length).toBeLessThan(60);
    for (const entry of [
      'npx --yes pnpm@10.33.0 install --frozen-lockfile',
      'node bin/lark-channel-bridge.mjs guide',
      'node bin/lark-channel-bridge.mjs run --profile',
      'node bin/lark-channel-bridge.mjs up',
      'quick-start.md',
    ]) expect(readme).toContain(entry);
    for (const moved of ['web --agent', 'start-web.ps1', '--web-ui']) expect(readme).not.toContain(moved);
  });

  it.each(['docs/quick-start.md', 'docs/user-guide/quick-start.md'])('keeps every runnable entry point in %s', async file => {
    const guide = await readFile(new URL(`../../../${file}`, import.meta.url), 'utf8');
    for (const entry of [
      'npx --yes pnpm@10.33.0 install --frozen-lockfile',
      'web --agent codex --workspace . --state-dir .web-local/chat',
      'node bin/lark-channel-bridge.mjs run --web-ui --detach',
      'bin\\windows\\start-web.ps1',
      '#token=',
      'configuration.md',
      'examples/web-native.toml',
      'examples/web-responses.toml',
    ]) expect(guide).toContain(entry);
  });

  it('documents maintained runtime surfaces in user-visible docs', async () => {
    const docs = await readDocs();

    for (const phrase of [
      'per-profile service',
      'workspaces.default',
      '/invite user',
      '/remove user',
      '/invite group',
      '/remove group',
      '/invite all group',
      'Windows',
      '.cmd',
      'profile export',
      'profile remove',
      '--purge --yes',
      '--include-secrets --yes',
      'lark-cli identity policy',
      'profile-local lark-cli directory',
      'lark-cli 身份策略',
      '当前 profile 的 lark-cli 目录',
      'pnpm test',
      'pnpm typecheck',
      'pnpm build',
    ]) {
      expect(docs).toContain(phrase);
    }
  });

  it('keeps CLI help aligned with profile-aware service and first-run workspace flags', async () => {
    const [cli, help, configCard] = await Promise.all([
      readFile(new URL('../../../src/cli/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/card/templates.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/card/config-card.ts', import.meta.url), 'utf8'),
    ]);

    expect(cli).toContain('--workspace <path>');
    expect(cli).toContain('profile name (defaults to active profile)');
    expect(cli).toContain('Archive a profile and its local state');
    expect(help).not.toContain('/doc ws');
    expect(configCard).not.toContain('`/doc`');
  });

  it('does not document trusted or allowed directory authorization', async () => {
    const docs = await readDocs();

    for (const phrase of [
      '允许访问目录',
      '可信目录',
      '安全目录',
      'trustedRoots',
      '/ws add',
      '/ws remove --root',
      'allowed directory',
      'allowed directories',
      'trusted directory',
      'safe directory',
    ]) {
      expect(docs).not.toContain(phrase);
    }
  });

  it('documents access control commands instead of config-only access management', async () => {
    const docs = await readDocs();

    expect(docs).not.toContain('`/config` only adjusts presentation preferences. Manage access in the profile config.');
    expect(docs).not.toContain('`/config` 只调整展示偏好，不再维护访问名单。请在 profile config 里维护。');
  });

  it('documents cloud-doc comments as document-scoped instead of access-gated', async () => {
    const docs = await readDocs();

    expect(docs).toContain('Cloud-doc comments are document-scoped');
    expect(docs).toContain('云文档评论按文档权限生效');
    expect(docs).not.toContain('comments.enabled');
    expect(docs).not.toContain('comments.rateLimit');
    expect(docs).not.toContain('/doc ws bind');
  });

  it('documents canonical permissions', async () => {
    const docs = await readDocs();

    expect(docs).toContain('"permissions"');
    expect(docs).toContain('"defaultAccess": "full"');
    expect(docs).toContain('"maxAccess": "full"');
    expect(docs).not.toContain('"sandbox"');
  });
});

async function readDocs(): Promise<string> {
  const documents = await Promise.all([
    readFile(new URL('../../../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../README.zh.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../docs/quick-start.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../docs/user-guide/quick-start.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../docs/runtime-reference.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../docs/user-guide/runtime-reference.md', import.meta.url), 'utf8'),
  ]);
  return documents.join('\n');
}
