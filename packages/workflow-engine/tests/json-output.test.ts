import { describe, expect, it } from 'vitest';
import { normalizeJsonOutput } from '../src/engine/json-output';

describe('worker JSON output recovery', () => {
  it('accepts strict JSON and the last fenced block after a summary', () => {
    expect(normalizeJsonOutput(' {"a": 1} ')).toBe('{"a":1}');
    expect(normalizeJsonOutput('检查完成。\n\n```json\n{"id":"B6"}\n```')).toBe('{"id":"B6"}');
    expect(normalizeJsonOutput('```\n{"draft":1}\n```\nfinal:\n```json\n[1, 2]\n```')).toBe('[1,2]');
  });

  it('recovers unfenced prose-wrapped JSON and earlier valid fences while rejecting truncated output', () => {
    expect(normalizeJsonOutput('以下是排查结果：\n{"id":"P0-1","severity":"high"}\n以上供参考。')).toBe('{"id":"P0-1","severity":"high"}');
    expect(normalizeJsonOutput('Findings:\n[\n  {"id":"P0-1","note":"[bracket] and {brace}"}\n]\nEnd.')).toBe('[{"id":"P0-1","note":"[bracket] and {brace}"}]');
    expect(normalizeJsonOutput('```json\n{"ok":true}\n```\nExample:\n```cpp\nvoid tick();\n```')).toBe('{"ok":true}');
    const repairArray = (text: string) => { if (!text.startsWith('[')) throw new SyntaxError('bad'); return [{ a: 1 }]; };
    expect(normalizeJsonOutput("Prose before [{'a': 1,}] prose after.", repairArray)).toBe('[{"a":1}]');
    expect(normalizeJsonOutput('[{"a": 1')).toBeUndefined();
    expect(normalizeJsonOutput('[{"a": 1}')).toBeUndefined();
  });

  it('falls back to host repair and rejects unrecoverable output', () => {
    const repair = (text: string) => { if (text !== "{'a': 1,}") throw new SyntaxError('bad'); return { a: 1 }; };
    expect(normalizeJsonOutput("```json\n{'a': 1,}\n```", repair)).toBe('{"a":1}');
    expect(normalizeJsonOutput("{'a': 1,}")).toBeUndefined();
    expect(normalizeJsonOutput('serena-prepare-project --project /repo</parameter>', repair)).toBeUndefined();
  });
});
