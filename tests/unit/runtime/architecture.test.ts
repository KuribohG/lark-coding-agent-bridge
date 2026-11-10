import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
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

it('keeps Lark input, execution, prompt and transport modules independent of the composition root', async () => {
  for (const name of ['intake', 'run', 'prompt', 'sdk', 'turns']) {
    const path = new URL(`../../../src/channels/lark/${name}.ts`, import.meta.url);
    const source = ts.createSourceFile(fileURLToPath(path), await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = source.statements.filter(ts.isImportDeclaration).map(node => (node.moduleSpecifier as ts.StringLiteral).text);
    for (const root of ['./channel', './index']) expect(imports, name).not.toContain(root);
    if (name === 'intake') expect(imports).not.toContain('./run');
    if (name === 'prompt' || name === 'sdk' || name === 'turns') {
      expect(imports.filter(path => /(?:workflows|commands)(?:\/|$)/.test(path)), name).toEqual([]);
    }
  }
});

async function importsUnder(directory: string): Promise<Array<{ file: string; target: string; typeOnly: boolean }>> {
  const root = fileURLToPath(new URL('../../../src/', import.meta.url));
  const found: Array<{ file: string; target: string; typeOnly: boolean }> = [];
  for (const entry of await readdir(join(root, directory), { recursive: true })) {
    if (!entry.endsWith('.ts')) continue;
    const file = join(root, directory, entry);
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || !node.moduleSpecifier) continue;
      const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
      if (!specifier.startsWith('.')) continue;
      const typeOnly = ts.isImportDeclaration(node) ? Boolean(node.importClause?.isTypeOnly) : node.isTypeOnly;
      found.push({ file: relative(root, file), target: relative(root, resolve(dirname(file), specifier)), typeOnly });
    }
  }
  return found;
}

it('keeps lower layers from importing the hosts built on top of them', async () => {
  const rules: Array<[string, RegExp]> = [
    ['agent', /^(?:runtime|channels|commands|card|cli)\//],
    ['config', /^(?:runtime|channels|commands|card|cli)\//],
    ['runtime', /^cli\//],
  ];
  const composition = new Set(['runtime/supervisor.ts', 'runtime/profile-runtime.ts', 'runtime/public.ts']);
  const violations: string[] = [];
  for (const [directory, forbidden] of rules) {
    for (const edge of await importsUnder(directory)) {
      if (composition.has(edge.file) && directory === 'runtime') continue;
      if (forbidden.test(edge.target)) violations.push(`${edge.file} -> ${edge.target}`);
    }
  }
  expect(violations).toEqual([]);
});

it('keeps card rendering independent of channel and command implementations', async () => {
  const violations = (await importsUnder('card'))
    .filter(edge => !edge.typeOnly && /^(?:channels|commands)\//.test(edge.target) && edge.target !== 'commands/catalog')
    .map(edge => `${edge.file} -> ${edge.target}`);
  expect(violations).toEqual([]);
});

it('runs every channel conversation turn through the shared turn pipeline', async () => {
  // Hosts call startTurn so session tracking, idle watchdog and stop grace are
  // implemented once; startRunFlow stays reachable only from the runtime itself.
  const hosts = ['runtime/conversation.ts', 'channels/lark/run.ts'];
  const root = fileURLToPath(new URL('../../../src/', import.meta.url));
  for (const file of hosts) {
    const text = await readFile(join(root, file), 'utf8');
    expect(text, file).toMatch(/\bstartTurn\(/);
    expect(text, file).not.toMatch(/\b(?:startRunFlow|trackRunSession|presentRunOutput)\(/);
  }
});
