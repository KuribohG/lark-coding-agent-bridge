import { parseForESLint, type AST } from 'toml-eslint-parser';
import { parse, TomlError } from 'smol-toml';

export type KeyPath = string[];
export function getPath(value: any, path: KeyPath): any {
  for (const key of path) { if (!value || !Object.hasOwn(value, key)) return undefined; value = value[key]; }
  return value;
}
export function setPath(value: any, path: KeyPath, next: any): void {
  if (!path.length || path.some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) throw new Error('invalid configuration path');
  for (const key of path.slice(0, -1)) {
    if (next === undefined && value[key] === undefined) return;
    value = value[key] ??= {};
  }
  if (next === undefined) delete value[path.at(-1)!]; else value[path.at(-1)!] = next;
}
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const prefix = (a: readonly (string | number)[], b: readonly (string | number)[]) => a.length <= b.length && a.every((k, i) => k === b[i]);
const keyText = (path: KeyPath) => path.map(k => /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)).join('.');
function inline(value: any): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (value && typeof value === 'object') return `{ ${Object.entries(value).filter(([,v]) => v !== undefined).map(([k,v]) => `${keyText([k])} = ${inline(v)}`).join(', ')} }`;
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  throw new Error('unsupported TOML value');
}

/** Edit one path using syntax ranges; preserve text outside the edited value. */
export function editToml(text: string, path: KeyPath, value: any): string {
  if (!path.length || path.some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) throw new Error('invalid configuration path');
  try { return editTomlValue(text, path, value); }
  catch (e) {
    if (e instanceof TomlError) throw new Error(`TOML syntax error at line ${e.line}, column ${e.column}`);
    if (e && typeof e === 'object' && 'lineNumber' in e) throw new Error(`TOML syntax error at line ${e.lineNumber}`);
    throw e;
  }
}

/** Accept TOML dotted keys, including quoted profile names containing dots. */
export function parseKeyPath(key: string): KeyPath {
  try {
    const ast = parseForESLint(`${key} = 0`).ast;
    const nodes = ast.body[0]!.body;
    const node = nodes[0];
    if (nodes.length !== 1 || node?.type !== 'TOMLKeyValue') throw new Error();
    const path = node.key.keys.map(k => k.type === 'TOMLBare' ? k.name : k.value);
    if (!path.length || path.some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) throw new Error();
    return path;
  } catch { throw new Error('invalid TOML configuration path'); }
}

function editTomlValue(text: string, path: KeyPath, value: any): string {
  const before = parse(text);
  if (same(getPath(before, path), value)) return text;
  const ast = parseForESLint(text).ast;
  const tables = ast.body[0]!.body.filter((n): n is AST.TOMLTable => n.type === 'TOMLTable');
  const entries: { path: (string | number)[]; node: AST.TOMLKeyValue }[] = [];
  for (const node of ast.body[0]!.body) {
    const base = node.type === 'TOMLTable' ? node.resolvedKey : [];
    for (const kv of node.type === 'TOMLTable' ? node.body : [node]) {
      entries.push({ path: [...base, ...kv.key.keys.map(k => k.type === 'TOMLBare' ? k.name : k.value)], node: kv });
    }
  }
  const enclosing = entries.find(e => prefix(e.path, path));
  let result: string;
  if (enclosing) {
    const { node } = enclosing;
    let replacement = value;
    if (enclosing.path.length < path.length) {
      replacement = structuredClone(getPath(before, enclosing.path as string[]));
      setPath(replacement, path.slice(enclosing.path.length), value);
    }
    const range = replacement === undefined ? node.range : node.value.range;
    result = text.slice(0, range[0]) + (replacement === undefined ? '' : inline(replacement)) + text.slice(range[1]);
  } else if (value === undefined) {
    const ranges: [number, number][] = [];
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i]!;
      if (prefix(path, table.resolvedKey)) ranges.push([table.range[0], tables[i + 1]?.range[0] ?? text.length]);
    }
    for (const e of entries) if (prefix(path, e.path) && !ranges.some(([a,b]) => e.node.range[0] >= a && e.node.range[1] <= b)) ranges.push(e.node.range);
    result = text;
    for (const [a,b] of ranges.sort((a,b) => b[0]-a[0])) result = result.slice(0,a) + result.slice(b);
  } else if (tables.some(t => prefix(path, t.resolvedKey))) {
    result = editToml(editToml(text, path, undefined), path, value);
  } else {
    const table = tables.filter(t => t.kind === 'standard' && prefix(t.resolvedKey, path) && t.resolvedKey.length < path.length)
      .sort((a,b) => b.resolvedKey.length - a.resolvedKey.length)[0];
    const offset = table ? text.indexOf('\n', table.key.range[1]) + 1 : tables[0]?.range[0] ?? text.length;
    const at = offset === 0 && table ? text.length : offset;
    const relative = path.slice(table?.resolvedKey.length ?? 0);
    result = text.slice(0,at) + (at && text[at-1] !== '\n' ? '\n' : '') + `${keyText(relative)} = ${inline(value)}\n` + text.slice(at);
  }
  // A failed structural edit must never overwrite the user's file.
  const actual = parse(result);
  if (!same(getPath(actual, path), value)) throw new Error('configuration edit cannot preserve this table structure; edit the file directly');
  return result;
}

export function diffValues(before: any, after: any, path: string[] = []): { path: string[]; value: any }[] {
  if (same(before, after)) return [];
  const table = (v: any) => v && Object.getPrototypeOf(v) === Object.prototype;
  if (table(before) && table(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .flatMap(key => diffValues(before[key], after[key], [...path, key]));
  return [{ path, value: after }];
}
