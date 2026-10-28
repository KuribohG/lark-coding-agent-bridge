import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const collectTsFiles = (path: string): string[] => {
  const fullPath = join(root, path);
  if (!existsSync(fullPath)) return [];

  if (statSync(fullPath).isFile()) {
    return path.endsWith('.ts') ? [path] : [];
  }

  return readdirSync(fullPath)
    .flatMap((entry) => collectTsFiles(join(path, entry)))
    .sort();
};

function internalCycles(): string[][] {
  const files = collectTsFiles('src');
  const known = new Set(files.map((file) => resolve(root, file)));
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const absolute = resolve(root, file);
    const source = read(file);
    const imports: string[] = [];
    const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^;\n]*?\s+from\s+)?["']([^"']+)["']/g;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier?.startsWith('.')) continue;
      const base = resolve(dirname(absolute), specifier);
      const resolved = [`${base}.ts`, join(base, 'index.ts'), base]
        .find((candidate) => known.has(candidate));
      if (resolved) imports.push(resolved);
    }
    graph.set(absolute, imports);
  }

  let index = 0;
  const stack: string[] = [];
  const active = new Set<string>();
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const cycles: string[][] = [];
  const visit = (node: string): void => {
    indices.set(node, index);
    low.set(node, index++);
    stack.push(node);
    active.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (active.has(next)) {
        low.set(node, Math.min(low.get(node)!, indices.get(next)!));
      }
    }
    if (low.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let current: string;
    do {
      current = stack.pop()!;
      active.delete(current);
      component.push(current);
    } while (current !== node);
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) {
      cycles.push(component.map((item) => item.replace(`${root}/`, '')).sort());
    }
  };
  for (const file of graph.keys()) if (!indices.has(file)) visit(file);
  return cycles;
}

describe('static architecture contracts', () => {
  it('does not route production runs by importing Codex internals in shared bot/card code', () => {
    const sharedFiles = [
      ...collectTsFiles('src/bot'),
      ...collectTsFiles('src/card'),
      ...collectTsFiles('src/commands'),
    ];
    for (const file of sharedFiles) {
      expect(read(file), file).not.toMatch(/agent\/codex/);
    }
  });

  it('routes shared agent behavior through the backend descriptor', () => {
    const descriptorConsumers = [
      'src/commands/recent.ts',
      'src/commands/resume.ts',
      'src/commands/status.ts',
      'src/agent/model-service.ts',
      'src/agent/model-settings.ts',
      'src/model-provider/provider.ts',
      'src/runtime/background-model.ts',
      'src/runtime/locks.ts',
      'src/runtime/registry.ts',
      'src/session/catalog.ts',
    ];
    for (const file of descriptorConsumers) {
      expect(read(file), file).not.toMatch(
        /(?:agentKind|agentId|kind)\s*===\s*['"](?:claude|codex|pi)['"]/,
      );
    }
  });

  it('does not keep legacy open access semantics in config helpers', () => {
    const schema = read('src/config/schema.ts');
    expect(schema).not.toMatch(/legacy-open|access\.semantics/);

    const legacyOpenAccessPatterns = [
      /Empty\/undefined = allow everyone/,
      /Empty\/undefined =\s*\n\s*\* respond in all chats it's invited to\./,
      /Empty \/\s*\n\s*\* undefined = no admin restriction/,
      /Empty list = allow all/,
      /if \(!list \|\| list\.length === 0\) return true;/,
    ];
    for (const pattern of legacyOpenAccessPatterns) {
      expect(schema).not.toMatch(pattern);
    }
  });

  it('persists profile runtime state through atomic 0600 writes', () => {
    for (const file of ['src/session/store.ts', 'src/workspace/store.ts', 'src/card/callback-store.ts']) {
      const source = read(file);
      expect(source, file).toContain('writeFileAtomic');
      expect(source, file).toContain('mode: 0o600');
      expect(source, file).not.toMatch(/\bwriteFile\(/);
    }
  });

  it('keeps generic runtime and work-item domains independent from Lark adapters', () => {
    const runtimeFiles = ['src/runtime/agent-runtime.ts', 'src/runtime/execution-controller.ts'];
    for (const file of runtimeFiles) {
      expect(read(file), file).not.toMatch(/channels\/lark|@larksuite\/channel/);
    }
    for (const file of collectTsFiles('src/work-items')) {
      expect(read(file), file).not.toMatch(/from ['"](?:\.\.\/)+inbox/);
      expect(read(file), file).not.toMatch(
        /\b(?:ownerOpenId|chatId|chatType|senderOpenId|parentId|analysisTopic)\b/,
      );
      expect(read(file), file).not.toMatch(/applink\.(?:feishu\.cn|larksuite\.com)/);
    }
    for (const file of collectTsFiles('src/config')) {
      expect(read(file), file).not.toMatch(/channels\/lark/);
    }
  });

  it('keeps core command, UI and supervisor code independent from concrete feature plugins', () => {
    const coreFiles = [
      'src/commands/catalog.ts',
      'src/commands/index.ts',
      'src/commands/registry.ts',
      'src/commands/types.ts',
      'src/config/document.ts',
      'src/config/profile-store.ts',
      'src/model-service/registry.ts',
      'src/runtime/supervisor.ts',
      'src/ui/server.ts',
      'src/ui/types.ts',
    ];
    for (const file of coreFiles) {
      const source = read(file);
      expect(source, file).not.toMatch(
        /from ['"][^'"]*(?:inbox|monitoring\/sources\/lark|plugins\/work-items)[^'"]*['"]/,
      );
    }
  });

  it('contains no internal import cycles', () => {
    expect(internalCycles()).toEqual([]);
  });
});
