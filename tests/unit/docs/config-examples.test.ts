import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDocument, resolveChannels, resolveExecutionProfile, resolveRun } from '../../../src/config/document';
import { loadRootConfig } from '../../../src/config/profile-store';

const exampleUrl = (name: string) => new URL(`../../../docs/user-guide/examples/${name}.toml`, import.meta.url);

describe('copyable configuration examples', () => {
  it.each(['web-native', 'web-responses', 'lark-codex'])('loads %s with the production config loader without resolving credentials', async name => {
    await expect(loadRootConfig(fileURLToPath(exampleUrl(name)))).resolves.toBeDefined();
  });

  it('keeps native Web setup independent of Lark and delegates model selection', async () => {
    const doc = parseDocument(await readFile(exampleUrl('web-native'), 'utf8'));
    expect(doc.profiles).toEqual({});
    expect(resolveExecutionProfile(doc, 'codex', {
      fallbackPermissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
    })).toMatchObject({
      agentKind: 'codex', codex: { binaryPath: 'codex', inheritCodexHome: true },
      permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
    });
    expect(resolveRun(doc, 'codex').preferences.model).toBeUndefined();
    expect(resolveRun(doc, 'codex').preferences.reasoningEffort).toBeUndefined();
    expect(resolveChannels(doc).web).toEqual({ show_tools: true, show_reasoning: false });
  });

  it('selects the declared Responses service with an environment reference, not a key', async () => {
    const root = await loadRootConfig(fileURLToPath(exampleUrl('web-responses')));
    const doc = parseDocument(await readFile(exampleUrl('web-responses'), 'utf8'));
    expect(doc.profiles).toEqual({});
    expect(resolveRun(doc, 'codex').preferences.model).toBe('gateway/example-model');
    expect(root?.modelServices?.gateway).toMatchObject({
      protocol: 'responses', baseUrl: 'https://api.example.com/v1', model: 'example-model',
      apiKey: { source: 'env', id: 'BRIDGE_MODEL_API_KEY' },
    });
  });

  it('keeps the Lark sample explicit about account credentials and workspace permissions', async () => {
    const root = await loadRootConfig(fileURLToPath(exampleUrl('lark-codex')));
    expect(root?.activeProfile).toBe('codex');
    expect(root?.profiles.codex).toMatchObject({
      agentKind: 'codex',
      permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
      accounts: { app: { id: 'cli_REPLACE_ME', secret: { source: 'env', id: 'FEISHU_APP_SECRET' } } },
    });
  });
});
