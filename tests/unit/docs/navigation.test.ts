import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : Promise.resolve(entry.name.endsWith('.md') ? [path] : []);
  }));
  return groups.flat();
}

function withoutCodeBlocks(markdown: string): string {
  return markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
}

function headingIds(markdown: string): Set<string> {
  const headings = withoutCodeBlocks(markdown).matchAll(/^#{1,6}\s+(.+)$/gm);
  const counts = new Map<string, number>();
  const ids = new Set<string>();
  for (const heading of headings) {
    const slug = heading[1]!.trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    ids.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return ids;
}

describe('documentation navigation', () => {
  it('keeps local Markdown links and heading anchors valid after moving README details', async () => {
    const files = [join(root, 'README.md'), join(root, 'README.zh.md'), ...await markdownFiles(join(root, 'docs'))];
    const failures: string[] = [];
    for (const file of files) {
      const content = withoutCodeBlocks(await readFile(file, 'utf8'));
      for (const match of content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
        const link = match[1]!;
        if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(link)) continue;
        const [path = '', fragment] = link.split('#', 2);
        const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
        const info = await stat(target).catch(() => undefined);
        const label = `${relative(root, file)} -> ${link}`;
        if (!info) failures.push(`Missing file: ${label}`);
        else if (fragment && info.isFile() && target.endsWith('.md')) {
          const ids = headingIds(await readFile(target, 'utf8'));
          if (!ids.has(decodeURIComponent(fragment))) failures.push(`Missing heading: ${label}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('includes the new guides, examples and references in the published package', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { files: string[] };
    for (const file of [
      'docs/README.md',
      'docs/runtime-reference.md',
      'docs/windows-web-validation.md',
      'docs/user-guide/web-chat.md',
      'docs/user-guide/configuration.md',
      'docs/user-guide/runtime-reference.md',
      'docs/user-guide/examples/web-native.toml',
      'docs/user-guide/examples/web-responses.toml',
      'docs/user-guide/examples/lark-codex.toml',
    ]) {
      expect(manifest.files.some(entry => file === entry || file.startsWith(`${entry}/`)), file).toBe(true);
    }
  });
});
