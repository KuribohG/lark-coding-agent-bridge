import { describe, expect, it } from 'vitest';
import { documentToRoot, formatDocument, parseDocument, resolveChannels, rootToDocument } from '../../../src/config/document';

const base = `version = 3
[profiles.a]
agent = "codex"
[profiles.a.accounts.app]
id = "app-a"
secret = "test-secret"
tenant = "feishu"
[profiles.b]
agent = "claude"
[profiles.b.accounts.app]
id = "app-b"
secret = "test-secret"
tenant = "lark"
`;

describe('Lark network configuration', () => {
  it('merges common network settings with profile overrides and preserves them on save', () => {
    const doc = parseDocument(base + `
[channels.lark.network]
proxy = "http://proxy.example:3128"
no_proxy = "localhost,.internal"
[channels.lark.profiles.a.network]
proxy = "direct"
[channels.lark.profiles.b.network]
no_proxy = ""
`);
    expect(resolveChannels(doc, 'a').lark.network).toEqual({ proxy: 'direct', no_proxy: 'localhost,.internal' });
    expect(resolveChannels(doc, 'b').lark.network).toEqual({ proxy: 'http://proxy.example:3128', no_proxy: '' });
    const roundTrip = parseDocument(formatDocument(rootToDocument(documentToRoot(doc))));
    for (const profile of ['a', 'b']) {
      expect(resolveChannels(roundTrip, profile).lark.network).toEqual(resolveChannels(doc, profile).lark.network);
    }
  });

  it.each([
    'proxy = "socks5://localhost:1080"',
    'proxy = ""',
    'proxy = "http://localhost:3128/path"',
    'proxy = "http://user:secret@localhost:3128"',
    'proxy = false',
    'no_proxy = []',
    'noProxy = "localhost"',
  ])('rejects invalid network settings: %s', settings => {
    expect(() => parseDocument(base + '\n[channels.lark.network]\n' + settings)).toThrow(/channels\.lark\.network/);
    expect(() => parseDocument(base + '\n[channels.lark.profiles.a.network]\n' + settings)).toThrow(/channels\.lark\.profiles\.a\.network/);
  });

  it('does not put proxy credentials into validation errors', () => {
    try {
      parseDocument(base + '\n[channels.lark.network]\nproxy = "http://user:secret@localhost:3128"');
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('user:secret');
    }
  });
});
