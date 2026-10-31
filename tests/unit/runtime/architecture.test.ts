import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import ts from 'typescript';

it('keeps execution runtime independent of channel hosts and concrete adapters', async () => {
  const directory = new URL('../../../src/runtime/', import.meta.url);
  // These composition roots assemble hosts; they do not implement execution.
  const composition = new Set(['supervisor.ts', 'profile-runtime.ts', 'public.ts']);
  const violations: string[] = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.ts') || composition.has(name)) continue;
    const path = new URL(name, directory);
    const source = ts.createSourceFile(fileURLToPath(path), await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) && /(?:^|\/)(?:bot|channels)\/|agent\/[^/]+\/adapter/.test(node.text)) {
        violations.push(`${name}: ${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
