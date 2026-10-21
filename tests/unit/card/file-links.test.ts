import { parseDocument, documentToRoot } from '../../../src/config/document';
import { describe, expect, it } from 'vitest';
import { rewriteFileLinks } from '../../../src/card/file-links';
import { normalizeFileLinks } from '../../../src/config/file-links';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, formatRootConfig } from '../../../src/config/profile-store';
import { renderText } from '../../../src/card/text-renderer';
import { renderCard } from '../../../src/card/run-renderer';
import type { RunState } from '../../../src/card/run-state';

const rules = [{ localRoot: '/exports', fileBaseUrl: 'https://example.com/files/', browseBaseUrl: 'https://example.com/lab/tree/' }];
const rewrite = (s: string, streaming = false) => rewriteFileLinks(s, rules, streaming);
const raw = '/exports/report.html';
const linked = '[report](https://example.com/files/report.html)';

describe('file links', () => {
  it('routes Markdown to an optional preview and preserves other destinations', () => {
    const mapping = [{...rules[0]!, markdownPreviewUrl:'https://example.com/custom/reader/index.html'}];
    const url = 'https://example.com/custom/reader/index.html?path=%2Fexports%2Fmy+report.md';
    expect(rewriteFileLinks('[report](</exports/my report.md>)', mapping)).toBe(`[report](${url})`);
    expect(rewriteFileLinks('`/exports/my report.md`', mapping)).toBe(`[/exports/my report.md](${url})`);
    expect(rewriteFileLinks('[report](/exports/README.MARKDOWN)', mapping)).toContain('?path=%2Fexports%2FREADME.MARKDOWN');
    expect(rewriteFileLinks('[code](/exports/code.py)', mapping)).toBe('[code](https://example.com/lab/tree/code.py)');
    expect(rewriteFileLinks('[image](/exports/image.png)', mapping)).toBe('[image](https://example.com/files/image.png)');
    expect(rewriteFileLinks('[report](/exports/report.md)', rules)).toBe('[report](https://example.com/lab/tree/report.md)');
    expect(rewriteFileLinks(rewriteFileLinks('[x](/exports/a.md)', mapping), mapping)).toBe(rewriteFileLinks('[x](/exports/a.md)', mapping));
  });
  it.each([
    ['[report](/exports/report.html)', linked],
    ['[report](</exports/my report.html>)', '[report](https://example.com/files/my%20report.html)'],
    ['[report](/exports/my%20report.html "title")', '[report](https://example.com/files/my%20report.html "title")'],
    ['[图](/exports/中文.png)', '[图](https://example.com/files/%E4%B8%AD%E6%96%87.png)'],
    ['[plot](/exports/plot(1).png)', '[plot](https://example.com/files/plot%281%29.png)'],
    ['[file](/exports/code.py:42:3)', '[file](https://example.com/lab/tree/code.py)'],
    ['[file](/exports/code.py#L42-L50)', '[file](https://example.com/lab/tree/code.py)'],
    ['`/exports/my report#1?.html`', '[/exports/my report#1?.html](https://example.com/files/my%20report%231%3F.html)'],
    ['see /exports/report.html.', 'see [/exports/report.html](https://example.com/files/report.html).'],
    ['（见 /exports/report.html，结束）', '（见 [/exports/report.html](https://example.com/files/report.html)，结束）'],
    ['(/exports/report.html)', '([/exports/report.html](https://example.com/files/report.html))'],
    ['see /exports/plot(1).png', 'see [/exports/plot(1).png](https://example.com/files/plot%281%29.png)'],
    ['[folder](/exports)', '[folder](https://example.com/lab/tree/)'],
    ['[folder](/exports/logs/)', '[folder](https://example.com/lab/tree/logs/)'],
  ])('rewrites %s', (input, output) => expect(rewrite(input)).toBe(output));

  it.each([
    '[web](https://example.com/exports/report.html)',
    '[web /exports/report.html](https://example.com)',
    'https://example.com/exports/report.html',
    '<https://example.com/exports/report.html>',
    '`cat /exports/report.html`',
    '`/exports/run.sh --flag`',
    '> ```sh\n> /exports/report.html\n> ```',
    '- ```sh\n  /exports/report.html\n  ```',
    '`cat\n/exports/report.html`',
    '[web\n/exports/report.html](https://example.com)',
    '```sh\ncat /exports/report.html\n```',
    '~~~\n/exports/report.html\n~~~',
    '    cat /exports/report.html',
    '\t/exports/report.html',
    '/exports-other/report.html',
    '/outside/report.html',
    '[escape](/exports/../outside/report.html)',
    '[escape](/exports/%2e%2e/outside/report.html)',
    '[bad](/exports/%xx.html)',
    '[incomplete](/exports/report.html',
    '`/exports/report.html',
    '[ref]: /exports/report.html',
  ])('preserves %s', input => expect(rewrite(input)).toBe(input));

  it('leaves inputs unchanged without configuration and is idempotent', () => {
    const input = `[report](${raw}) and \`${raw}\``;
    expect(rewriteFileLinks(input)).toBe(input);
    expect(rewrite(rewrite(input))).toBe(rewrite(input));
  });

  it('preserves malformed Unicode instead of failing the reply', () => {
    const input = '`/exports/\ud800.txt`';
    expect(rewrite(input)).toBe(input);
  });

  it('uses the most specific root', () => {
    expect(rewriteFileLinks('[x](/exports/special/a.txt)', [...rules, {
      ...rules[0]!, localRoot: '/exports/special', fileBaseUrl: 'https://special.example/files/',
    }])).toBe('[x](https://special.example/files/a.txt)');
  });

  it('waits for a boundary or completion before linking a streaming bare path', () => {
    expect(rewrite('see /exports/report', true)).toBe('see /exports/report');
    expect(rewrite('see /exports/report.html', true)).toBe('see /exports/report.html');
    expect(rewrite('see /exports/report.html\n', true)).toContain('https://example.com/files/report.html');
    expect(rewrite('[report](/exports/report.html)', true)).toBe(linked);
  });

  it('only changes text blocks and leaves the source state and tools intact', () => {
    const state: RunState = { blocks: [
      { kind: 'text', content: `[report](${raw})`, streaming: false },
      { kind: 'tool', tool: { id: 't', name: 'Bash', status: 'done', input: { command: `cat ${raw}` }, output: raw } },
    ], reasoning: { content: '', active: false }, terminal: 'done', footer: null };
    const before = structuredClone(state);
    const options = { fileLinks: rules };
    expect(renderText(state, options)).toContain(linked);
    expect(JSON.stringify(renderCard(state, options))).toContain(linked);
    expect(JSON.stringify(renderCard(state, options))).toContain(`cat ${raw}`);
    expect(state).toEqual(before);
  });
});

describe('file link configuration', () => {
  it('retains an optional Markdown preview endpoint across serialization', () => {
    const mapping = [{...rules[0]!, markdownPreviewUrl:'https://example.com/reader.html'}];
    const profile = createDefaultProfileConfig({agentKind:'claude', accounts:{app:{id:'test',secret:'test',tenant:'feishu'}}, preferences:{fileLinks:mapping}});
    const serialized = parseDocument(formatRootConfig(createRootConfig('test',profile)));
    expect(documentToRoot(serialized).profiles.test!.channels?.lark?.file_links).toEqual(mapping);
  });
  it('normalizes and retains mappings across profile serialization', () => {
    const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'test', secret: 'test', tenant: 'feishu' } },
      preferences: { fileLinks: [{ localRoot: '/exports/', fileBaseUrl: 'https://example.com/files', browseBaseUrl: 'https://example.com/lab/tree' }] } });
    const serialized = parseDocument(formatRootConfig(createRootConfig('test', profile)));
    expect(documentToRoot(serialized).profiles.test!.channels?.lark?.file_links).toEqual(rules);
  });

  it.each([null, {}, [{...rules[0],localRoot:'/'}], [{...rules[0],localRoot:'relative'}],
    [{...rules[0],localRoot:'/exports/../other'}], [...rules,...rules],
    [{...rules[0],fileBaseUrl:'http://example.com/'}], [{...rules[0],fileBaseUrl:'https://user:pass@example.com/'}],
    [{...rules[0],browseBaseUrl:'https://example.com/?token=secret'}], [{...rules[0],browseBaseUrl:'https://example.com/#frag'}],
    [{...rules[0],markdownPreviewUrl:'javascript:alert(1)'}], [{...rules[0],markdownPreviewUrl:'https://user:secret@example.com/view'}],
    [{...rules[0],markdownPreviewUrl:'https://example.com/?token=secret'}], [{...rules[0],markdownPreviewUrl:'https://example.com/#path'}],
  ])('rejects invalid configuration %#', value => expect(() => normalizeFileLinks(value)).toThrow());
});
