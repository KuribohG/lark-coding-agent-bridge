import { describe, expect, it } from 'vitest';
import { documentToRoot, formatDocument, parseDocument, rootToDocument } from '../../../src/config/document';
import { normalizeRootConfig, parseRootConfig } from '../../../src/config/profile-store';

const base = `version = 3
[profiles.a]
agent = "claude"
[profiles.a.accounts.app]
id = "app-a"
secret = "test-secret"
tenant = "feishu"
`;

const gate = `
[gate]
enabled = true

[gate.defaults]
rpm = 1000

[gate.providers.lark_high_five_ai_01b55021b1f8]
rpm = 1000
`;

describe('model gate through the root config', () => {
  it('survives the normalization the running bridge applies to every read', () => {
    // parseRootConfig is the path startup and config reload actually take.
    const root = parseRootConfig(base + gate, '/tmp/config.toml');
    expect(root.modelGate?.enabled).toBe(true);
    expect(root.modelGate?.providers.lark_high_five_ai_01b55021b1f8?.rpm).toBe(1000);
  });

  it('is still there after a canonical save round trip', () => {
    const root = normalizeRootConfig(documentToRoot(parseDocument(base + gate)));
    const text = formatDocument(rootToDocument(root));
    expect(text).toContain('[gate]');
    const reread = parseRootConfig(text, '/tmp/config.toml');
    expect(reread.modelGate?.providers.lark_high_five_ai_01b55021b1f8?.rpm).toBe(1000);
  });

  it('stays absent when the file has no gate table', () => {
    expect(parseRootConfig(base, '/tmp/config.toml').modelGate).toBeUndefined();
  });
});
